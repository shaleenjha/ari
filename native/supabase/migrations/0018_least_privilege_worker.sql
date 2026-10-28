-- 0018 (v18.5, Sat Oct 17 2026): least-privilege worker + sync.
-- Hark's worker (task e8fbd86f), the Sheet sync (56e17ef1), reply_ingest.py, brief_upsert.py and daily_report.py stop
-- running as service_role. They reach PostgREST with a JWT whose role claim is ari_worker (HS256, signed with the
-- project's legacy JWT secret, held only in the Hark vault and injected by the sandbox proxy).
-- ari_worker: NOLOGIN, NOINHERIT, no BYPASSRLS. RLS policies scoped TO ari_worker; table rights below are the whole list.
-- Raw SQL paths are not granted (hark_query / hark_exec / hark_time stay service_role-only; hark_exec is dropped in 0019).
-- Every new function: explicit grants (default privileges are revoked since 0016). Rollback: rollbacks/0018_rollback.sql

-- 1. Role -------------------------------------------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'ari_worker') then
    create role ari_worker nologin noinherit;
  end if;
end $$;
alter role ari_worker nologin noinherit nobypassrls nocreatedb nocreaterole;
alter role ari_worker set statement_timeout = '60s';
grant ari_worker to authenticator;
grant usage on schema public to ari_worker;

-- 2. Actor stamping without the auth schema (ari_worker has no usage on auth) ------------------------------------------
create or replace function public.ari_jwt_role() returns text language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
$$;
revoke execute on function public.ari_jwt_role() from public, anon;
grant execute on function public.ari_jwt_role() to authenticated, service_role, ari_worker;

create or replace function public.current_actor() returns text language sql stable as $$
  select coalesce(nullif(current_setting('ari.actor', true), ''),
                  case when public.ari_jwt_role() in ('service_role', 'ari_worker')
                       then nullif(left(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-ari-actor', 40), '') end,
                  case when public.ari_jwt_role() = 'authenticated' then 'app' else 'hark' end)
$$;
grant execute on function public.current_actor() to ari_worker;

-- 3. Table rights (sync = Sheet <-> DB mirror; reports = daily report reads) --------------------------------------------
grant select on public.people, public.accounts, public.queue, public.emails, public.brief, public.log_entries,
                public.book, public.plays, public.sync_state, public.scan_heartbeat, public.account_stage_history
  to ari_worker;
grant select on public.rpt_people, public.rpt_accounts, public.rpt_events to ari_worker;
grant insert, update on public.people, public.accounts, public.queue, public.emails, public.brief,
                        public.sync_state, public.scan_heartbeat, public.book
  to ari_worker;
grant delete on public.book to ari_worker;
grant insert on public.plays, public.log_entries to ari_worker;
grant update (sheet_key) on public.log_entries to ari_worker;
-- no TRUNCATE, REFERENCES, TRIGGER anywhere; no DELETE except book (the sync prunes Book rows the Sheet dropped)

do $$ declare t text; begin
  foreach t in array array['people','accounts','queue','emails','brief','log_entries','book','plays','sync_state',
                           'scan_heartbeat','account_stage_history'] loop
    execute format('drop policy if exists ari_worker_rw on public.%I', t);
    execute format('create policy ari_worker_rw on public.%I for all to ari_worker using (true) with check (true)', t);
  end loop;
end $$;

-- 4. Existing RPCs the worker path calls ------------------------------------------------------------------------------
grant execute on function public.ari_account_stage_reconcile() to ari_worker;
grant execute on function public.report_summary(text, date, date, text, text, text) to ari_worker;
grant execute on function public.report_rows(text, text, date, date, text, text, text, text) to ari_worker;
grant execute on function public.accounts_worked(date, date, text, text) to ari_worker;
grant execute on function public.rpt_filtered(date, date, text, text, text, text) to ari_worker;
grant execute on function public.rpt_range(text, date, date) to ari_worker;
grant execute on function public.rpt_today() to ari_worker;
grant execute on function public.rpt_day(timestamptz) to ari_worker;
grant execute on function public.rpt_unit(text) to ari_worker;
grant execute on function public.ari_stage_norm(text) to ari_worker;
grant execute on function public.ari_stage_rank(text) to ari_worker;

-- 5. Named worker functions (replace string-built SQL through hark_exec) ----------------------------------------------
create or replace function public.ari_worker_ping() returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('role', public.ari_jwt_role(), 'current_user', current_user::text, 'actor', public.current_actor())
$$;

-- column catalogue for the sync (only tables this role can see)
create or replace function public.ari_worker_columns() returns table(table_name text, column_name text)
language sql stable set search_path = '' as $$
  select c.table_name::text, c.column_name::text from information_schema.columns c
  where c.table_schema = 'public' order by c.table_name, c.ordinal_position
$$;

-- brief_upsert.py next
create or replace function public.ari_worker_brief_next() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare a jsonb;
begin
  select to_jsonb(r) into a from (
    select b.account_id, a.company, a.owner, a.stage, a.hook, a.hook_date, a.hook_url, a.why_thrandvex, a.domain, b.status, b.requested_at
    from account_briefs b join accounts a on a.id = b.account_id
    where b.status in ('queued','building') and a.deleted_at is null
    order by (b.status = 'building') desc, coalesce(a.stage_changed_at, a.updated_at) desc nulls last limit 1) r;
  if a is null then return '{}'::jsonb; end if;
  a := a || jsonb_build_object(
    'people', coalesce((select jsonb_agg(to_jsonb(p) order by p.id) from (
        select id, name, title, linkedin_url, route, stage, review, why_this_person, left(coalesce(dm,''),400) dm
        from people where account_id = (a->>'account_id')::uuid and deleted_at is null and coalesce(review,'lead') <> 'personal') p), '[]'::jsonb),
    'queued_total', (select count(*) from account_briefs where status in ('queued','building')));
  return a;
end $$;

-- brief_upsert.py building <account_id>: queued -> building only
create or replace function public.ari_worker_brief_building(p_account_id uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  perform set_config('ari.actor', 'hark', true);
  update account_briefs set status = 'building' where account_id = p_account_id and status = 'queued';
  get diagnostics n = row_count; return n;
end $$;

-- brief_upsert.py write: validated upsert; never touches check_answers / checked_at / check_via / reviewed_at
create or replace function public.ari_worker_brief_write(p_account_id uuid, p_brief jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare errs text[] := '{}'; k text; t text; qc jsonb; i jsonb; u text; r jsonb;
begin
  if p_brief is null or jsonb_typeof(p_brief) <> 'object' then raise exception 'brief must be a json object'; end if;
  if not exists (select 1 from accounts where id = p_account_id and deleted_at is null) then raise exception 'unknown account'; end if;
  foreach k in array array['thesis','why_now','committee','quick_check','sequences'] loop
    if p_brief->k is null or p_brief->k in ('null'::jsonb, '""'::jsonb, '[]'::jsonb) then errs := errs || ('missing ' || k); end if;
  end loop;
  foreach k in array array['why_now','data_flow','committee','soft_angles','quick_check','sequences'] loop
    if p_brief ? k and jsonb_typeof(p_brief->k) <> 'array' then errs := errs || (k || ' must be an array'); end if;
  end loop;
  if errs = '{}' then
    if jsonb_array_length(p_brief->'sequences') <> 2 then errs := errs || 'need exactly 2 sequences'::text; end if;
    qc := p_brief->'quick_check';
    if jsonb_array_length(qc) not between 1 and 2 then errs := errs || 'quick_check needs 1 or 2 items'::text; end if;
    for i in select * from jsonb_array_elements(qc) loop
      if jsonb_typeof(i->'answer') <> 'number' or jsonb_typeof(i->'options') <> 'array'
         or (i->>'answer')::numeric <> floor((i->>'answer')::numeric)
         or (i->>'answer')::int < 0 or (i->>'answer')::int >= jsonb_array_length(i->'options') then
        errs := errs || ('quick_check answer out of range: ' || coalesce(i->>'id','?'));
      end if;
    end loop;
    for i in select * from jsonb_array_elements(p_brief->'why_now') loop
      if coalesce(i->>'label','') not in ('Verified','Inference','Hypothesis') then errs := errs || 'why_now label must be Verified/Inference/Hypothesis'::text; end if;
    end loop;
  end if;
  t := p_brief::text;
  if t ~ '[\u2014\u2013]' then errs := errs || 'contains a dash'::text; end if;
  for u in select jsonb_path_query(p_brief, 'strict $.**.url') #>> '{}' union all select p_brief->>'doc_url' loop
    if u is not null and u <> '' and u !~ '^https://' then errs := errs || ('url must be https: ' || left(u, 80)); end if;
  end loop;
  if length(t) > 200000 then errs := errs || 'brief too large'::text; end if;
  if errs <> '{}' then raise exception 'NOT WRITTEN: %', array_to_string(errs, '; '); end if;
  perform set_config('ari.actor', 'hark', true);
  insert into account_briefs(account_id, status, thesis, why_now, data_flow, committee, angle, soft_angles, quick_check, sequences, doc_url)
  values (p_account_id, 'ready', p_brief->>'thesis', p_brief->'why_now', coalesce(p_brief->'data_flow','[]'), p_brief->'committee',
          coalesce(p_brief->>'angle',''), coalesce(p_brief->'soft_angles','[]'), p_brief->'quick_check', p_brief->'sequences', nullif(p_brief->>'doc_url',''))
  on conflict (account_id) do update set (status, thesis, why_now, data_flow, committee, angle, soft_angles, quick_check, sequences, doc_url) =
    (excluded.status, excluded.thesis, excluded.why_now, excluded.data_flow, excluded.committee, excluded.angle, excluded.soft_angles,
     excluded.quick_check, excluded.sequences, excluded.doc_url);
  select jsonb_build_object('company', company, 'status', status, 'built_at', built_at) into r from account_briefs where account_id = p_account_id;
  return r;
end $$;

-- brief_upsert.py guidance [ae]
create or replace function public.ari_worker_guidance(p_ae text default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(g)), '[]'::jsonb) from (
    select ae, company, kind, before, after, created_at from copy_guidance
    where p_ae is null or lower(ae) = lower(p_ae) order by created_at desc limit 15) g
$$;

-- reply_ingest.py: scan state (two allow-listed prefs + gmail ids already stored)
create or replace function public.ari_worker_reply_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'scan_last', (select value #>> '{}' from ari_prefs where key = 'reply_scan_last'),
    'show_names', coalesce((select value #>> '{}' from ari_prefs where key = 'push_show_names'), 'false') = 'true',
    'seen', coalesce((select jsonb_agg(gmail_id) from replies where gmail_id is not null), '[]'::jsonb))
$$;

create or replace function public.ari_worker_scan_last_set(p_ts bigint) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_ts is null or p_ts < 1700000000 or p_ts > extract(epoch from now())::bigint + 86400 then raise exception 'bad timestamp'; end if;
  insert into ari_prefs(key, value, updated_by) values ('reply_scan_last', to_jsonb(p_ts), 'hark')
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = 'hark';
end $$;

-- reply_ingest.py scan: one reply email -> replies row; first reply sets people.replied/stage; one push (text by pref)
create or replace function public.ari_worker_reply_record(p_person_id text, p_gmail_id text, p_received_at timestamptz,
  p_msg_count integer, p_thread_url text, p_headline text, p_snippet text, p_matched_by text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare p record; rid bigint; show boolean; ttl text; bdy text; dkey text; pushed boolean := false;
begin
  if p_gmail_id is null or p_gmail_id !~ '^[0-9a-f]{6,40}:[^[:space:]]{1,160}$' then raise exception 'bad gmail id'; end if;
  if p_thread_url is not null and p_thread_url !~ '^https://www\.linkedin\.com/messaging/thread/[^/?#\s]+/$' then raise exception 'bad thread url'; end if;
  if coalesce(p_matched_by,'') not in ('profile_url','name') then raise exception 'bad matched_by'; end if;
  if p_received_at is null or p_received_at > now() + interval '1 day' then raise exception 'bad received_at'; end if;
  if p_msg_count is not null and (p_msg_count < 0 or p_msg_count > 1000) then raise exception 'bad msg_count'; end if;
  select id, name, company, account_id, replied into p from people
   where id = p_person_id and deleted_at is null and coalesce(review,'lead') <> 'personal';
  if not found then raise exception 'unknown person'; end if;
  insert into replies(person_id, account_id, gmail_id, source, received_at, msg_count, thread_url, headline, snippet, snippet_source, matched_by)
  values (p.id, p.account_id, p_gmail_id, 'gmail', p_received_at, p_msg_count, p_thread_url, left(p_headline, 300), left(p_snippet, 2000),
          case when nullif(p_snippet,'') is null then 'none' else 'email' end, p_matched_by)
  on conflict (gmail_id) do nothing returning id into rid;
  if rid is null then return jsonb_build_object('fresh', false); end if;
  show := coalesce((select value #>> '{}' from ari_prefs where key = 'push_show_names'), 'false') = 'true';
  if show then ttl := p.name || ' replied'; bdy := coalesce(p.company, 'LinkedIn') || '. Open Ari for 3 reply drafts.';
  else ttl := 'New reply on LinkedIn'; bdy := 'Someone you messaged wrote back. Open Ari to answer.'; end if;
  dkey := case when p.replied is null then 'replied:' || p.id else 'reply:' || rid end;
  if not exists (select 1 from notifications where person_id = p.id and kind = 'replied' and created_at > now() - interval '6 hours') then
    perform ari_notify('replied', dkey, ttl, bdy, '/ops?open=person:' || p.id, p.id, p.account_id); pushed := true;
  end if;
  if p.replied is null then
    perform set_config('ari.actor', 'hark', true);
    update people set replied = p_received_at, stage = 'Replied', next_action = 'Reply', updated_by = 'hark:reply'
     where id = p.id and replied is null;
  end if;
  return jsonb_build_object('fresh', true, 'id', rid, 'pushed', pushed, 'first', p.replied is null);
end $$;

-- reply_ingest.py backfill
create or replace function public.ari_worker_reply_backfill(p_dry boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ids jsonb;
begin
  select coalesce(jsonb_agg(p.id order by p.id), '[]'::jsonb) into ids from people p
   where p.replied is not null and p.deleted_at is null and coalesce(p.review,'lead') <> 'personal'
     and not exists (select 1 from replies r where r.person_id = p.id);
  if not p_dry then
    insert into replies(person_id, account_id, source, received_at, snippet_source, matched_by)
    select p.id, p.account_id, 'backfill', p.replied, 'none', 'app' from people p
     where p.id in (select jsonb_array_elements_text(ids));
  end if;
  return jsonb_build_object('backfilled', ids, 'dry', p_dry);
end $$;

-- reply_ingest.py pending
create or replace function public.ari_worker_replies_pending() returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(x) order by x.received_at), '[]'::jsonb) from (
    select r.id reply_id, r.person_id, r.snippet, r.snippet_source, r.msg_count, r.received_at, p.name, p.title, p.company, p.owner,
           p.context, p.why_this_person, p.dm dm1_draft, a.hook, a.hook_date, a.hook_url, b.angle brief_angle,
           (select json_agg(json_build_object('kind', s.kind, 'body', s.body, 'sent_at', s.sent_at) order by s.sent_at)
              from sent_messages s where s.person_id = r.person_id) sent
    from replies r join people p on p.id = r.person_id left join accounts a on a.id = p.account_id
    left join account_briefs b on b.account_id = p.account_id
    where r.status = 'new' and r.drafts is null) x
$$;

-- reply_ingest.py drafts <id> <file>: exactly 3 drafts book/answer/soft, each 1..300 chars, no dashes
create or replace function public.ari_worker_reply_drafts(p_id bigint, p_drafts jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare d jsonb; clean jsonb := '[]'; r jsonb;
begin
  if jsonb_typeof(p_drafts) <> 'array' or jsonb_array_length(p_drafts) <> 3 then raise exception 'need exactly 3 drafts'; end if;
  if (select array_agg(e->>'key' order by e->>'key') from jsonb_array_elements(p_drafts) e) <> array['answer','book','soft'] then
    raise exception 'keys must be book, answer, soft'; end if;
  for d in select * from jsonb_array_elements(p_drafts) loop
    if coalesce(btrim(d->>'body'),'') = '' or coalesce(d->>'label','') = '' then raise exception 'each draft needs label and body'; end if;
    if length(btrim(d->>'body')) > 300 or length(d->>'label') > 60 then raise exception '% too long', d->>'key'; end if;
    if (d->>'body') ~ '[\u2014\u2013]' then raise exception '% contains a dash', d->>'key'; end if;
    clean := clean || jsonb_build_array(jsonb_build_object('key', d->>'key', 'label', d->>'label', 'body', btrim(d->>'body')));
  end loop;
  update replies set drafts = clean, drafted_at = now(), updated_at = now() where id = p_id and status = 'new';
  if not found then raise exception 'no open reply %', p_id; end if;
  select jsonb_build_object('id', id, 'person_id', person_id, 'drafted_at', drafted_at) into r from replies where id = p_id;
  return r;
end $$;

-- reply_ingest.py show
create or replace function public.ari_worker_replies_open(p_limit integer default 20) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(o)), '[]'::jsonb) from public.ari_replies_open(least(greatest(coalesce(p_limit, 20), 1), 50)) o
$$;

-- 6. Grants for the named functions: ari_worker (and service_role, for the switch-over) only ----------------------------
do $$ declare f text; begin
  foreach f in array array[
    'public.ari_worker_ping()', 'public.ari_worker_columns()', 'public.ari_worker_brief_next()',
    'public.ari_worker_brief_building(uuid)', 'public.ari_worker_brief_write(uuid, jsonb)', 'public.ari_worker_guidance(text)',
    'public.ari_worker_reply_state()', 'public.ari_worker_scan_last_set(bigint)',
    'public.ari_worker_reply_record(text, text, timestamptz, integer, text, text, text, text)',
    'public.ari_worker_reply_backfill(boolean)', 'public.ari_worker_replies_pending()',
    'public.ari_worker_reply_drafts(bigint, jsonb)', 'public.ari_worker_replies_open(integer)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to ari_worker, service_role', f);
  end loop;
end $$;

notify pgrst, 'reload schema';
