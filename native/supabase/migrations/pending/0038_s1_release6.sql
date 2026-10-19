-- 0038 (S1 release 6, proposed by the auditor; number to be confirmed, see the note on Diamond's 0037).
-- One release, seven parts, all small. Synthetic-tested on the local prod shape: pending/test/checks_after_0038.sql.
-- Rollback: rollbacks/0038_rollback.sql. Two parts cannot be undone by design: the notification rewrite (3) and the
-- shadow-event purge (5) delete or replace text; the nightly backups keep the old state for 14 nights.
--   1. The signed-in role loses DELETE on the 17 mirrored tables (data-side D2). Nothing in ops.html, app2 or any migration
--      deletes from them; the worker's Book prune runs as ari_worker. push_subscriptions / push_tokens are left as they are.
--   2. apply_op writes no names: Log detail is the company (or nothing), queue 'Draft reply' details carry no name (D3).
--   3. Stored notifications get the generic text the privacy trigger writes today (0031:307-328). dedupe_key, person_id,
--      url, sent_at and attempts stay, so "one push per real event" still holds and nothing is re-sent.
--   4. The worker's Log rewrite functions from 0036 (applied by hand, no ledger row) are dropped.
--   5. gmail_shadow_events purge: unmatched rows after 7 days, every row after 30 days; nightly at 01:45 IST.
--   6. replies.person_id -> people ON DELETE CASCADE, so a hard erase removes the prospect's reply text too.
--   7. Ledger: 0036 recorded; the two cron jobs created by hand in prod are recorded with their live schedule and command.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- 1. no hard deletes from the signed-in role
revoke delete on public.plays, public.accounts, public.people, public.queue, public.brief, public.emails, public.book,
                 public.research, public.decisions, public.threads, public.tasks, public.task_events, public.messages,
                 public.attachments, public.ari_notes, public.targets, public.app_changes from authenticated;

-- 2. apply_op without names (0005 body, five lines changed)
CREATE OR REPLACE FUNCTION public.apply_op(p_op_id text, p_kind text, p_table text, p_id text, p_patch jsonb DEFAULT '{}'::jsonb, p_client_ts timestamp with time zone DEFAULT now(), p_device text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  prev jsonb; res jsonb; rowj jsonb; k text; applied text[] := '{}'; stale text[] := '{}';
  keycol text; rid text; cur jsonb; filt jsonb := '{}'::jsonb; ts jsonb := '{}'::jsonb; sets text := '';
  f text; today date := (now() at time zone 'Asia/Kolkata')::date; tsv timestamptz := coalesce(p_client_ts, now());
  stage_by jsonb := '{"connect_sent":"Connect sent","accepted":"Accepted","dm1_sent":"DM1 sent","dm2_sent":"DM2 sent","dm3_sent":"DM3 sent","replied":"Replied","meeting":"Meeting","withdrawn":"Withdrawn"}';
  p record; actor text := 'app' || coalesce(':' || p_device, '');
  allowed text[];
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  insert into public.ops(op_id, kind, target_table, target_id, payload, client_ts, device)
  values (p_op_id, p_kind, p_table, p_id, coalesce(p_patch, '{}'), p_client_ts, p_device)
  on conflict (op_id) do nothing;
  if not found then
    select result into prev from public.ops where op_id = p_op_id;
    return coalesce(prev, '{}'::jsonb) || jsonb_build_object('duplicate', true);
  end if;
  perform set_config('ari.actor', actor, true);

  if p_kind in ('mark','undo') then
    if p_table <> 'people' then raise exception 'mark/undo only on people'; end if;
    f := p_patch ->> 'field';
    if not stage_by ? f then raise exception 'bad field %', f; end if;
    select * into p from public.people where id = p_id for update;
    if not found then raise exception 'person not found: %', p_id; end if;
    if p_kind = 'mark' then
      if to_jsonb(p) ->> f is not null then
        res := jsonb_build_object('ok', true, 'already', true);
      else
        execute format('update public.people set %I = $1, stage = $2 where id = $3', f) using tsv, stage_by ->> f, p_id;
        if f = 'accepted' then
          update public.people set next_action = 'DM1 on ' || to_char(today, 'YYYY-MM-DD') where id = p_id;
        elsif f = 'dm1_sent' then
          update public.people set dm2_due = today + 4, dm3_due = today + 7,
                 next_action = 'DM2 on ' || to_char(today + 4, 'YYYY-MM-DD') where id = p_id;
        elsif f = 'dm2_sent' then
          update public.people set next_action = 'DM3 on ' || to_char(coalesce(p.dm3_due, today + 3), 'YYYY-MM-DD') where id = p_id;
        elsif f = 'dm3_sent' then
          update public.people set next_action = 'Sequence done. Park or try another angle.' where id = p_id;
        elsif f = 'replied' then
          update public.people set next_action = 'Hark drafting your answer' where id = p_id;
          insert into public.queue(action, target, details, updated_by)
          values ('Draft reply', p_id, 'Replied on LinkedIn. Paste their reply in the Hark chat for a sharper draft.', actor);
        elsif f = 'meeting' then
          update public.people set next_action = 'Log meeting in SFDC' where id = p_id;
        elsif f = 'withdrawn' then
          update public.people set next_action = '' where id = p_id;
        end if;
        insert into public.log_entries(ts, person_id, event, detail, source)
        values (tsv, p_id, stage_by ->> f, nullif(coalesce(p.company,''), ''), 'app');
        res := jsonb_build_object('ok', true, 'applied', jsonb_build_array(f));
      end if;
    else
      execute format('update public.people set %I = null where id = $1', f) using p_id;
      update public.people x set stage = coalesce(
        case when x.meeting is not null then 'Meeting' when x.replied is not null then 'Replied'
             when x.dm3_sent is not null then 'DM3 sent' when x.dm2_sent is not null then 'DM2 sent'
             when x.dm1_sent is not null then 'DM1 sent' when x.accepted is not null then 'Accepted'
             when x.connect_sent is not null then 'Connect sent' end, 'Connect queued')
      where id = p_id;
      -- v17.1: the next step follows the restored stage, and an undone reply cancels its queued Draft reply
      update public.people x set next_action = case x.stage
          when 'Meeting' then 'Log meeting in SFDC'
          when 'Replied' then 'Hark drafting your answer'
          when 'DM3 sent' then 'Sequence done. Park or try another angle.'
          when 'DM2 sent' then 'DM3 on ' || to_char(coalesce(x.dm3_due, today + 3), 'YYYY-MM-DD')
          when 'DM1 sent' then 'DM2 on ' || to_char(coalesce(x.dm2_due, today + 4), 'YYYY-MM-DD')
          when 'Accepted' then 'Send DM1'
          when 'Connect sent' then 'Waiting on accept'
          else 'Send connect' end
       where id = p_id;
      if f = 'replied' then
        update public.queue set status = 'cancelled', result = 'Cancelled: the reply mark was undone in Ari.', updated_by = actor
         where target = p_id and action = 'Draft reply' and status = 'queued';
      end if;
      insert into public.log_entries(ts, person_id, event, detail, source) values (tsv, p_id, 'Undo ' || f, null, 'app');
      res := jsonb_build_object('ok', true, 'applied', jsonb_build_array(f));
    end if;
    select to_jsonb(x) into rowj from public.people x where id = p_id;

  elsif p_kind = 'insert' then
    if p_table not in ('queue','people','log_entries') then raise exception 'insert not allowed on %', p_table; end if;
    filt := jsonb_strip_nulls(p_patch || case when p_table = 'log_entries' then '{}'::jsonb
                                              else jsonb_build_object('updated_by', actor) end);
    select string_agg(format('%I', key), ', ') into sets from jsonb_object_keys(filt) key;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) returning to_jsonb(%I.*)',
                   p_table, sets, sets, p_table, p_table) using filt into rowj;
    res := jsonb_build_object('ok', true, 'applied', '["insert"]'::jsonb);

  elsif p_kind = 'set' then
    if p_table not in ('people','accounts','queue','brief') then raise exception 'set not allowed on %', p_table; end if;
    keycol := case p_table when 'brief' then 'key' else 'id' end;
    rid := p_id;
    if p_table = 'accounts' and rid !~* '^[0-9a-f-]{36}$' then
      select id::text into rid from public.accounts where lower(btrim(company)) = lower(btrim(p_id));
      if rid is null then  -- like Apps Script setAccount: create the account row
        insert into public.accounts(company, updated_by) values (btrim(p_id), actor) returning id::text into rid;
      end if;
    end if;
    if p_table = 'brief' then
      insert into public.brief(key, updated_by) values (rid, actor) on conflict (key) do nothing;
    end if;
    execute format('select to_jsonb(t) from public.%I t where %I::text = $1 for update', p_table, keycol) into cur using rid;
    if cur is null then raise exception '% not found: %', p_table, p_id; end if;
    for k in select jsonb_object_keys(p_patch) loop
      if k in ('id','key','created_at','updated_at','updated_by','field_ts','sheet_row','ae') or not (cur ? k) then
        raise exception 'field not editable: %', k;
      end if;
      if (cur -> 'field_ts' ->> k) is not null and (cur -> 'field_ts' ->> k)::timestamptz > tsv then
        stale := stale || k;
      else
        applied := applied || k;
        filt := filt || jsonb_build_object(k, p_patch -> k);
        ts := ts || jsonb_build_object(k, tsv);
        sets := sets || format('%I = r.%I, ', k, k);
      end if;
    end loop;
    if array_length(applied, 1) > 0 then
      execute format('update public.%I t set %s field_ts = t.field_ts || $2, updated_by = $3 from jsonb_populate_record(null::public.%I, $1) r where t.%I::text = $4 returning to_jsonb(t.*)',
                     p_table, sets, p_table, keycol)
        using filt, ts, actor, rid into rowj;
      if p_table = 'accounts' and filt ->> 'meeting_status' = 'set' then
        insert into public.log_entries(ts, person_id, event, detail, source)
        values (tsv, null, 'Meeting set', concat_ws(' · ', rowj ->> 'company', rowj ->> 'meeting_source', rowj ->> 'meeting_date'), 'app');
      elsif p_table = 'people' then
        insert into public.log_entries(ts, person_id, event, detail, source)
        values (tsv, rid, 'Ari edit ' || array_to_string(applied, ','), nullif(rowj ->> 'company', ''), 'app');
      end if;
    else
      rowj := cur;
    end if;
    res := jsonb_build_object('ok', true, 'applied', to_jsonb(applied), 'stale', to_jsonb(stale));
  else
    raise exception 'unknown op kind %', p_kind;
  end if;

  res := res || jsonb_build_object('row', rowj, 'duplicate', false);
  update public.ops set result = res - 'row',
         status = case when cardinality(stale) > 0 and cardinality(applied) = 0 then 'stale'
                       when cardinality(stale) > 0 then 'partial' else 'applied' end
   where op_id = p_op_id;
  return res;
end $function$
;

-- 3. stored notifications: the generic text the BEFORE INSERT trigger writes now (keep this CASE equal to
--    notifications_privacy(); checks_after_0038.sql compares them kind by kind)
do $$
declare n int;
begin
  with g as (
    select x.id,
      case x.kind
        when 'replied' then 'New reply on LinkedIn'
        when 'accepted' then 'New connection accepted'
        when 'meeting' then 'Meeting set'
        when 'research_done' then case when coalesce(x.dedupe_key, '') like 'rescan:%' then 'Re-scan done' else 'Brief ready' end
        when 'draft_due' then case when x.dedupe_key like 'draft:dm1:%' then 'DM1 ready' when x.dedupe_key like 'draft:dm2:%' then 'DM2 drafted'
                                   when x.dedupe_key like 'draft:dm3:%' then 'DM3 drafted' else 'Draft ready' end
        else 'Ari update' end as title,
      case x.kind
        when 'replied' then 'Someone you messaged wrote back. Open Ari to answer.'
        when 'accepted' then 'Their DM1 draft is ready in Ari.'
        when 'meeting' then 'Open Ari to see the details.'
        when 'research_done' then case when coalesce(x.dedupe_key, '') like 'rescan:%' then 'A fresh look at an account is waiting in Ari.'
                                       else 'A new account brief is waiting in Ari.' end
        when 'draft_due' then 'Ready for your review in Ari.'
        else 'Open Ari to see what changed.' end as body
    from public.notifications x
    where x.kind not in ('test', 'digest') and coalesce(x.dedupe_key, '') not like 'digest:%')
  update public.notifications t set title = g.title, body = g.body
    from g where g.id = t.id and (t.title is distinct from g.title or t.body is distinct from g.body);
  get diagnostics n = row_count;
  raise notice '0038: % notifications rewritten to the generic text', n;
end $$;

-- 4. the worker can no longer rewrite or delete Log rows
drop function if exists public.ari_worker_log_repair(text, text, jsonb, jsonb);
drop function if exists public.ari_worker_log_unappend(text);

-- 5. gmail_shadow_events: unmatched (by the same matcher as the nightly diff) after 7 days, everything after 30
create or replace function public.ari_gmail_shadow_purge() returns jsonb language plpgsql security definer set search_path = public as $$
declare a int; b int;
begin
  delete from gmail_shadow_events where ingested_at < now() - interval '30 days';
  get diagnostics a = row_count;
  delete from gmail_shadow_events e where e.ingested_at < now() - interval '7 days'
     and public.ari_gmail_match_person(public.ari_li_vanity(e.profile_url), e.name) is null;
  get diagnostics b = row_count;
  return jsonb_build_object('older_than_30d', a, 'unmatched_older_than_7d', b);
end $$;
revoke all on function public.ari_gmail_shadow_purge() from public, anon, authenticated;
select cron.schedule('ari-gmail-shadow-purge', '15 20 * * *', 'select public.ari_gmail_shadow_purge()');   -- 01:45 IST, after the 00:30 diff

-- 6. replies follow their person on a hard delete (NOT VALID + VALIDATE keeps the lock short)
do $$
declare c text;
begin
  select conname into c from pg_constraint
   where conrelid = 'public.replies'::regclass and confrelid = 'public.people'::regclass and contype = 'f';
  if c is null then raise exception '0038: replies -> people foreign key not found'; end if;
  execute format('alter table public.replies drop constraint %I', c);
end $$;
alter table public.replies add constraint replies_person_id_fkey
  foreign key (person_id) references public.people(id) on delete cascade not valid;
alter table public.replies validate constraint replies_person_id_fkey;

-- 7. ledger: what prod already runs, recorded (cron.schedule with an existing name updates that job, so no duplicates)
insert into supabase_migrations.schema_migrations(version, name) values ('0036', 'log_repair_rpc') on conflict do nothing;
select cron.schedule('ari-session-expiry', '17 * * * *',
  $c$delete from auth.sessions where created_at < now() - interval '30 days' or greatest(updated_at, coalesce(refreshed_at at time zone 'UTC', created_at)) < now() - interval '7 days'$c$);
select cron.schedule('ari-weekly-digest', '30 5 * * 6', $c$select public.ari_weekly_digest()$c$);

do $$ begin
  if exists (select 1 from information_schema.role_table_grants where grantee = 'authenticated' and privilege_type = 'DELETE'
              and table_schema = 'public' and table_name in ('plays','accounts','people','queue','brief','emails','book','research','decisions',
              'threads','tasks','task_events','messages','attachments','ari_notes','targets','app_changes'))
    then raise exception '0038: authenticated still holds DELETE'; end if;
  if position('p.name' in pg_get_functiondef('public.apply_op(text,text,text,text,jsonb,timestamp with time zone,text)'::regprocedure)) > 0
    then raise exception '0038: apply_op still writes p.name'; end if;
  if (select confdeltype from pg_constraint where conname = 'replies_person_id_fkey' and conrelid = 'public.replies'::regclass) <> 'c'
    then raise exception '0038: replies FK is not ON DELETE CASCADE'; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0038', 's1_release6') on conflict do nothing;
notify pgrst, 'reload schema';
commit;
