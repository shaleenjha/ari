-- 0031 (v18.10.1, Sat Oct 17 2026): Copy Lab Stage A + Re-scan push. Approved by Owner 14:38 IST.
-- 1. draft_tags: what every draft WAS (angle, hook, hook kind, structure, journey step, persona, play, variant), written by the
--    worker through ari_worker_draft_tag (validated) and keyed by the exact draft text (md5), so a redraft never inherits
--    the old draft's tags. Supabase-only (the Sheet sync never touches it).
-- 2. draft_edits: Owner's in-app edits before he copies a draft: Ari's original, his edited text and a word diff, one row per
--    draft (successive saves of the same draft update the row; reverting to Ari's text removes it). Captured in the database
--    from ANY app edit path (the people trigger that already wrote copy_guidance), so no client can skip it. copy_guidance
--    rows for the same draft are kept in step instead of piling up one per save.
-- 3. sent_messages snapshot carries the tags, Ari's original and the diff, so the copy loop can learn from what went out.
-- 4. Re-scan done push: a "Rescan account" Queue row turning done queues one push that opens the account's Brief.
--    Lock-screen privacy text gets its own wording for re-scans. Brief-ready fallback text no longer mentions the quick check.
-- 5. Worker reads: ari_worker_untagged_drafts() and ari_worker_copy_stats(from,to) (aggregates + bodies, no raw table grant).
-- Rollback: rollbacks/0031_rollback.sql. Tests: tests/0031_copy_tags_edits_test.sql (staging, one transaction, ends in raise).

-- ---------- helpers ----------
create or replace function public.ari_draft_md5(p text) returns text language sql immutable set search_path = '' as $$
  select md5(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'))
$$;
revoke all on function public.ari_draft_md5(text) from public, anon;
grant execute on function public.ari_draft_md5(text) to authenticated, service_role, ari_worker;

-- word diff (LCS). ops: [{"op":"=","t":"..."},{"op":"-","t":"..."},{"op":"+","t":"..."}], counts in words.
create or replace function public.ari_word_diff(a text, b text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  x text[] := coalesce(regexp_split_to_array(nullif(btrim(coalesce(a, '')), ''), '\s+'), '{}');
  y text[] := coalesce(regexp_split_to_array(nullif(btrim(coalesce(b, '')), ''), '\s+'), '{}');
  n int := coalesce(array_length(x, 1), 0); m int := coalesce(array_length(y, 1), 0);
  L int[]; i int; j int; w int; ops jsonb := '[]'::jsonb; rev text[] := '{}'; revop text[] := '{}';
  cur_op text := null; cur_t text := ''; k int; added int := 0; removed int := 0; kept int := 0;
begin
  if n * m > 90000 then
    return jsonb_build_object('ops', jsonb_build_array(jsonb_build_object('op', '-', 't', a), jsonb_build_object('op', '+', 't', b)),
                              'added', m, 'removed', n, 'kept', 0, 'coarse', true);
  end if;
  w := m + 1;
  L := array_fill(0, array[(n + 1) * w]);
  for i in reverse n..1 loop
    for j in reverse m..1 loop
      if x[i] = y[j] then L[(i - 1) * w + j] := L[i * w + j + 1] + 1;
      else L[(i - 1) * w + j] := greatest(L[i * w + j], L[(i - 1) * w + j + 1]); end if;
    end loop;
  end loop;
  -- L index for (i,j) 1-based positions: (i-1)*w + j ; row n+1 / col m+1 are zero
  i := 1; j := 1;
  while i <= n or j <= m loop
    if i <= n and j <= m and x[i] = y[j] then revop := array_append(revop, '='::text); rev := array_append(rev, x[i]); kept := kept + 1; i := i + 1; j := j + 1;
    elsif j <= m and (i > n or coalesce(L[(i - 1) * w + j + 1], 0) >= coalesce(L[i * w + j], 0)) then revop := array_append(revop, '+'::text); rev := array_append(rev, y[j]); added := added + 1; j := j + 1;
    else revop := array_append(revop, '-'::text); rev := array_append(rev, x[i]); removed := removed + 1; i := i + 1; end if;
  end loop;
  for k in 1..coalesce(array_length(revop, 1), 0) loop
    if cur_op is distinct from revop[k] then
      if cur_op is not null then ops := ops || jsonb_build_object('op', cur_op, 't', cur_t); end if;
      cur_op := revop[k]; cur_t := rev[k];
    else cur_t := cur_t || ' ' || rev[k]; end if;
  end loop;
  if cur_op is not null then ops := ops || jsonb_build_object('op', cur_op, 't', cur_t); end if;
  return jsonb_build_object('ops', ops, 'added', added, 'removed', removed, 'kept', kept);
end $$;
revoke all on function public.ari_word_diff(text, text) from public, anon;
grant execute on function public.ari_word_diff(text, text) to authenticated, service_role, ari_worker;

-- ---------- 1. draft_tags ----------
create table if not exists public.draft_tags (
  id bigint generated always as identity primary key,
  person_id text not null references public.people(id) on delete cascade,
  kind text not null check (kind in ('dm1','dm2','dm3','note','reply')),
  body_md5 text not null,
  body text,
  angle text not null,
  hook text,
  hook_kind text not null check (hook_kind in ('launch','funding','hire','breach_fine','partnership','mcp_agent','filing',
                                               'post_talk','product_change','role_pain','peer_move','hypothesis','personal','none')),
  hook_url text,
  hook_date date,
  structure text not null,
  journey_step text not null check (journey_step in ('connect_note','dm1','dm2','dm3','nudge','reply','exec_note')),
  persona text,
  play text,
  variant text,
  created_by text not null default public.current_actor(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (person_id, kind, body_md5)
);
create index if not exists draft_tags_person on public.draft_tags(person_id, kind, updated_at desc);
alter table public.draft_tags enable row level security;
drop policy if exists owner_read on public.draft_tags;
create policy owner_read on public.draft_tags for select to authenticated using ((select public.is_owner()));
revoke all on public.draft_tags from anon, ari_worker;
revoke insert, update, delete, truncate on public.draft_tags from authenticated;
grant select on public.draft_tags to authenticated;

-- worker: tag one draft (validated). p_tags keys: angle, hook, hook_kind, hook_url, hook_date, structure, journey_step, persona, play, variant
create or replace function public.ari_worker_draft_tag(p_person_id text, p_kind text, p_body text, p_tags jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t jsonb := coalesce(p_tags, '{}'::jsonb); r public.draft_tags; v text; d date; js text; k text;
begin
  if coalesce(p_kind, '') not in ('dm1','dm2','dm3','note','reply') then raise exception 'kind must be dm1, dm2, dm3, note or reply'; end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null then raise exception 'empty draft'; end if;
  if not exists (select 1 from people where id = p_person_id) then raise exception 'no such person'; end if;
  for k in select jsonb_object_keys(t) loop
    if k not in ('angle','hook','hook_kind','hook_url','hook_date','structure','journey_step','persona','play','variant') then raise exception 'unknown tag %', k; end if;
  end loop;
  if nullif(btrim(coalesce(t->>'angle', '')), '') is null or length(t->>'angle') > 200 then raise exception 'angle required (max 200 chars)'; end if;
  if nullif(btrim(coalesce(t->>'structure', '')), '') is null or length(t->>'structure') > 80 then raise exception 'structure required (max 80 chars)'; end if;
  if coalesce(t->>'hook_kind', '') not in ('launch','funding','hire','breach_fine','partnership','mcp_agent','filing','post_talk','product_change',
                                           'role_pain','peer_move','hypothesis','personal','none') then raise exception 'bad hook_kind'; end if;
  if length(coalesce(t->>'hook', '')) > 300 or length(coalesce(t->>'persona', '')) > 60 or length(coalesce(t->>'play', '')) > 60
     or length(coalesce(t->>'variant', '')) > 60 then raise exception 'tag too long'; end if;
  v := nullif(btrim(coalesce(t->>'hook_url', '')), '');
  if v is not null and v !~* '^https://[^\s]+$' then raise exception 'hook_url must be https'; end if;
  if v is not null and v ~* '(apollo\.io|crunchbase\.com|linkedin\.com)' then raise exception 'hook_url must be a primary source'; end if;
  if (t->>'hook_kind') not in ('hypothesis','none','role_pain','personal') and v is null then raise exception 'a trigger hook needs its primary hook_url'; end if;
  begin d := nullif(t->>'hook_date', '')::date; exception when others then raise exception 'hook_date must be yyyy-mm-dd'; end;
  js := coalesce(nullif(t->>'journey_step', ''), case p_kind when 'note' then 'connect_note' else p_kind end);
  if js not in ('connect_note','dm1','dm2','dm3','nudge','reply','exec_note') then raise exception 'bad journey_step'; end if;
  perform set_config('ari.actor', coalesce(nullif(current_setting('ari.actor', true), ''), 'worker'), true);
  insert into draft_tags(person_id, kind, body_md5, body, angle, hook, hook_kind, hook_url, hook_date, structure, journey_step, persona, play, variant)
  values (p_person_id, p_kind, ari_draft_md5(p_body), left(btrim(p_body), 4000), btrim(t->>'angle'), nullif(btrim(coalesce(t->>'hook', '')), ''),
          t->>'hook_kind', v, d, lower(btrim(t->>'structure')), js, nullif(btrim(coalesce(t->>'persona', '')), ''),
          nullif(btrim(coalesce(t->>'play', '')), ''), nullif(btrim(coalesce(t->>'variant', '')), ''))
  on conflict (person_id, kind, body_md5) do update set (angle, hook, hook_kind, hook_url, hook_date, structure, journey_step, persona, play, variant, updated_at) =
    (excluded.angle, excluded.hook, excluded.hook_kind, excluded.hook_url, excluded.hook_date, excluded.structure, excluded.journey_step,
     excluded.persona, excluded.play, excluded.variant, now())
  returning * into r;
  return jsonb_build_object('id', r.id, 'person_id', r.person_id, 'kind', r.kind, 'journey_step', r.journey_step, 'hook_kind', r.hook_kind);
end $$;
revoke all on function public.ari_worker_draft_tag(text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.ari_worker_draft_tag(text, text, text, jsonb) to ari_worker, service_role;

-- ---------- 2. draft_edits ----------
create table if not exists public.draft_edits (
  id bigint generated always as identity primary key,
  person_id text not null references public.people(id) on delete cascade,
  account_id uuid,
  ae text,
  kind text not null check (kind in ('dm1','dm2','dm3')),
  original text not null,
  edited text not null,
  diff jsonb not null default '[]'::jsonb,
  words_added int not null default 0,
  words_removed int not null default 0,
  words_kept int not null default 0,
  saves int not null default 1,
  sent_at timestamptz,
  sent_message_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists draft_edits_open on public.draft_edits(person_id, kind, updated_at desc) where sent_at is null;
alter table public.draft_edits enable row level security;
drop policy if exists owner_read on public.draft_edits;
create policy owner_read on public.draft_edits for select to authenticated using ((select public.is_owner()));
revoke all on public.draft_edits from anon, ari_worker;
revoke insert, update, delete, truncate on public.draft_edits from authenticated;
grant select on public.draft_edits to authenticated;

-- tags for a draft text (latest edit chain aware): exact text first, else the Ari original it was edited from
create or replace function public.ari_tags_for(p_person_id text, p_kind text, p_body text) returns public.draft_tags
language sql stable security definer set search_path = public as $$
  select t.* from draft_tags t
  where t.person_id = p_person_id and t.kind = p_kind
    and (t.body_md5 = ari_draft_md5(p_body)
         or t.body_md5 in (select ari_draft_md5(e.original) from draft_edits e
                           where e.person_id = p_person_id and e.kind = p_kind and ari_draft_md5(e.edited) = ari_draft_md5(p_body)))
  order by (t.body_md5 = ari_draft_md5(p_body)) desc, t.updated_at desc limit 1
$$;

alter table public.copy_guidance add column if not exists draft_edit_id bigint;
create index if not exists copy_guidance_edit on public.copy_guidance(draft_edit_id) where draft_edit_id is not null;

-- replaces 0011's people_copy_guidance: same guard (app edit of an unsent, non-empty draft), now also keeps draft_edits
create or replace function public.people_copy_guidance() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; o text; n text; sent timestamptz; v_ae text; de public.draft_edits; df jsonb;
begin
  if coalesce(new.updated_by, '') not like 'app%' then return null; end if;
  select a.ae into v_ae from public.accounts a where a.id = new.account_id;
  v_ae := coalesce(v_ae, split_part(coalesce(new.owner, ''), ' ', 1));
  foreach k in array array['dm1','dm2','dm3'] loop
    o := case k when 'dm1' then old.dm when 'dm2' then old.dm2_text else old.dm3_text end;
    n := case k when 'dm1' then new.dm when 'dm2' then new.dm2_text else new.dm3_text end;
    sent := case k when 'dm1' then old.dm1_sent when 'dm2' then old.dm2_sent else old.dm3_sent end;
    if sent is null and nullif(btrim(coalesce(o, '')), '') is not null and nullif(btrim(coalesce(n, '')), '') is not null and o is distinct from n then
      select * into de from public.draft_edits e
       where e.person_id = new.id and e.kind = k and e.sent_at is null and public.ari_draft_md5(e.edited) = public.ari_draft_md5(o)
       order by e.updated_at desc limit 1;
      if de.id is not null then
        if public.ari_draft_md5(de.original) = public.ari_draft_md5(n) then
          -- back to Ari's own text: no edit left to learn from
          delete from public.copy_guidance where draft_edit_id = de.id;
          delete from public.draft_edits where id = de.id;
        else
          df := public.ari_word_diff(de.original, n);
          update public.draft_edits set edited = left(n, 4000), diff = df->'ops', words_added = (df->>'added')::int, words_removed = (df->>'removed')::int,
                 words_kept = (df->>'kept')::int, saves = saves + 1, updated_at = now(), ae = coalesce(v_ae, draft_edits.ae)
           where id = de.id;
          update public.copy_guidance set after = n where draft_edit_id = de.id;
        end if;
      else
        df := public.ari_word_diff(o, n);
        insert into public.draft_edits(person_id, account_id, ae, kind, original, edited, diff, words_added, words_removed, words_kept)
        values (new.id, new.account_id, v_ae, k, left(o, 4000), left(n, 4000), df->'ops', (df->>'added')::int, (df->>'removed')::int, (df->>'kept')::int)
        returning * into de;
        insert into public.copy_guidance(account_id, company, person_id, ae, kind, before, after, note, draft_edit_id)
        values (new.account_id, new.company, new.id, v_ae, k, o, n, 'Owner edited Ari''s draft in the app', de.id);
      end if;
    end if;
  end loop;
  return null;
end $$;
revoke all on function public.people_copy_guidance() from public, anon, authenticated;

-- ---------- 3. sent_messages carries tags + Ari's original ----------
alter table public.sent_messages add column if not exists tags jsonb;
alter table public.sent_messages add column if not exists draft_tag_id bigint;
alter table public.sent_messages add column if not exists draft_edit_id bigint;
alter table public.sent_messages add column if not exists ari_original text;
alter table public.sent_messages add column if not exists edit_diff jsonb;

create or replace function public.ari_sent_enrich(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare s public.sent_messages; t public.draft_tags; e public.draft_edits;
begin
  select * into s from sent_messages where id = p_id;
  if s.id is null or s.kind not in ('dm1','dm2','dm3') or s.body is null then return; end if;
  select * into e from draft_edits where person_id = s.person_id and kind = s.kind and sent_at is null
     and ari_draft_md5(edited) = ari_draft_md5(s.body) order by updated_at desc limit 1;
  t := ari_tags_for(s.person_id, s.kind, s.body);
  update sent_messages set
    draft_tag_id = t.id,
    tags = case when t.id is null then null else jsonb_strip_nulls(jsonb_build_object('angle', t.angle, 'hook', t.hook, 'hook_kind', t.hook_kind,
             'hook_url', t.hook_url, 'hook_date', t.hook_date, 'structure', t.structure, 'journey_step', t.journey_step, 'persona', t.persona,
             'play', t.play, 'variant', t.variant, 'hook_age_days', case when t.hook_date is null then null else (s.sent_at at time zone 'Asia/Kolkata')::date - t.hook_date end)) end,
    draft_edit_id = e.id, ari_original = e.original, edit_diff = e.diff
  where id = s.id;
  if e.id is not null then update draft_edits set sent_at = s.sent_at, sent_message_id = s.id where id = e.id; end if;
end $$;
revoke all on function public.ari_sent_enrich(bigint) from public, anon, authenticated;

-- replaces 0011's people_sent_snapshot: identical behaviour plus enrichment of the snapshot row
create or replace function public.people_sent_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; ts_new timestamptz; ts_old timestamptz; b text; sid bigint;
begin
  foreach k in array array['dm1','dm2','dm3'] loop
    ts_new := case k when 'dm1' then new.dm1_sent when 'dm2' then new.dm2_sent else new.dm3_sent end;
    ts_old := case when tg_op = 'INSERT' then null else case k when 'dm1' then old.dm1_sent when 'dm2' then old.dm2_sent else old.dm3_sent end end;
    b := case k when 'dm1' then new.dm when 'dm2' then new.dm2_text else new.dm3_text end;
    if ts_new is not null and ts_old is null then
      sid := null;
      insert into public.sent_messages(person_id, account_id, kind, body, sent_at, source)
      values (new.id, new.account_id, k, nullif(btrim(coalesce(b, '')), ''), ts_new, 'tick')
      on conflict (person_id, kind) where kind in ('dm1','dm2','dm3') do nothing
      returning id into sid;
      if sid is not null then
        begin perform public.ari_sent_enrich(sid); exception when others then null; end;  -- never block a send tick
      end if;
    elsif ts_new is null and ts_old is not null then
      update public.draft_edits set sent_at = null, sent_message_id = null
       where sent_message_id in (select id from public.sent_messages where person_id = new.id and kind = k and source in ('tick','backfill'));
      delete from public.sent_messages where person_id = new.id and kind = k and source in ('tick','backfill');
    end if;
  end loop;
  return null;
end $$;

-- ---------- 4. Re-scan done push + privacy wording + brief text ----------
create or replace function public.queue_rescan_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare a record; line text;
begin
  if new.action = 'Rescan account' and new.status ilike 'done%' and coalesce(old.status, '') not ilike 'done%' then
    select id, company into a from public.accounts where lower(btrim(company)) = lower(btrim(coalesce(new.target, ''))) and deleted_at is null limit 1;
    line := nullif(btrim(split_part(coalesce(new.result, ''), E'\n', 1)), '');
    insert into public.notifications(kind, dedupe_key, title, body, url, account_id)
    values ('research_done', 'rescan:' || new.id,
            'Re-scan done: ' || coalesce(a.company, nullif(btrim(new.target), ''), 'an account'),
            coalesce(left(line, 140), 'The brief is refreshed.'),
            case when a.id is null then '/ops' else '/ops?open=account:' || a.id || ':brief' end, a.id)
    on conflict (dedupe_key) do nothing;
  end if;
  return null;
end $$;
revoke all on function public.queue_rescan_notify() from public, anon, authenticated;
drop trigger if exists queue_rescan_notify on public.queue;
create trigger queue_rescan_notify after update of status on public.queue
  for each row execute function public.queue_rescan_notify();

create or replace function public.account_briefs_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare co text;
begin
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then
    co := coalesce(nullif(new.company, ''), (select a.company from public.accounts a where a.id = new.account_id), 'an account');
    insert into public.notifications(kind, dedupe_key, title, body, url, account_id)
    values ('research_done', 'brief:' || new.account_id || ':' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'),
            'Brief ready: ' || co,
            coalesce(left(nullif(new.thesis, ''), 140), 'Read it when you have a minute.'),
            '/ops?open=account:' || new.account_id || ':brief', new.account_id)
    on conflict (dedupe_key) do nothing;
  end if;
  return null;
end $$;

create or replace function public.notifications_privacy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('test', 'digest') or coalesce(new.dedupe_key, '') like 'digest:%' then return new; end if;
  if coalesce((public.ari_pref('push_show_names', 'false'::jsonb) #>> '{}')::boolean, false) then return new; end if;
  case new.kind
    when 'replied' then new.title := 'New reply on LinkedIn'; new.body := 'Someone you messaged wrote back. Open Ari to answer.';
    when 'accepted' then new.title := 'New connection accepted'; new.body := 'Their DM1 draft is ready in Ari.';
    when 'meeting' then new.title := 'Meeting set'; new.body := 'Open Ari to see the details.';
    when 'research_done' then
      if coalesce(new.dedupe_key, '') like 'rescan:%' then new.title := 'Re-scan done'; new.body := 'A fresh look at an account is waiting in Ari.';
      else new.title := 'Brief ready'; new.body := 'A new account brief is waiting in Ari.'; end if;
    when 'draft_due' then
      new.title := case when new.dedupe_key like 'draft:dm1:%' then 'DM1 ready'
                        when new.dedupe_key like 'draft:dm2:%' then 'DM2 drafted'
                        when new.dedupe_key like 'draft:dm3:%' then 'DM3 drafted'
                        else 'Draft ready' end;
      new.body := 'Ready for your review in Ari.';
    else new.title := 'Ari update'; new.body := 'Open Ari to see what changed.';
  end case;
  return new;
end $$;
revoke all on function public.notifications_privacy() from public, anon, authenticated;

-- ---------- 5. worker reads ----------
-- unsent drafts that carry no tag for their current text (the worker tags them; also its backfill list)
create or replace function public.ari_worker_untagged_drafts(p_limit int default 50) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x.updated_at desc), '[]'::jsonb) from (
    select p.id as person_id, p.name, p.company, d.kind, d.body, p.updated_at
    from people p
    cross join lateral (values ('dm1', p.dm, p.dm1_sent), ('dm2', p.dm2_text, p.dm2_sent), ('dm3', p.dm3_text, p.dm3_sent)) d(kind, body, sent)
    where p.deleted_at is null and coalesce(p.review, 'lead') = 'lead' and d.sent is null and nullif(btrim(coalesce(d.body, '')), '') is not null
      and (ari_tags_for(p.id, d.kind, d.body)).id is null
    order by p.updated_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 200))) x
$$;
revoke all on function public.ari_worker_untagged_drafts(int) from public, anon, authenticated;
grant execute on function public.ari_worker_untagged_drafts(int) to ari_worker, service_role;

-- the weekly copy read: every DM sent in the window with its tags, edit and outcome (reply within 14 days)
create or replace function public.ari_worker_copy_stats(p_from date default null, p_to date default null) returns jsonb
language sql stable security definer set search_path = public as $$
  with w as (select coalesce(p_from, (now() at time zone 'Asia/Kolkata')::date - 14) f, coalesce(p_to, (now() at time zone 'Asia/Kolkata')::date) t),
  s as (
    select m.id, m.person_id, m.kind, m.body, m.sent_at, m.tags, m.ari_original, m.edit_diff, p.title, p.company, a.ae,
           (select min(r.received_at) from replies r where r.person_id = m.person_id and r.received_at >= m.sent_at
              and r.received_at < m.sent_at + interval '14 days') as replied_at
    from sent_messages m join people p on p.id = m.person_id left join accounts a on a.id = p.account_id, w
    where m.kind in ('dm1','dm2','dm3') and (m.sent_at at time zone 'Asia/Kolkata')::date between w.f and w.t)
  select jsonb_build_object(
    'from', (select f from w), 'to', (select t from w),
    'sent', (select count(*) from s), 'tagged', (select count(*) from s where tags is not null),
    'edited', (select count(*) from s where ari_original is not null), 'replied', (select count(*) from s where replied_at is not null),
    'older_than_7d', (select count(*) from s where sent_at < now() - interval '7 days'),
    'by_hook_kind', (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (select coalesce(tags->>'hook_kind', 'untagged') k,
        jsonb_build_object('sent', count(*), 'replied', count(*) filter (where replied_at is not null)) c from s group by 1) g),
    'by_structure', (select coalesce(jsonb_object_agg(k, c), '{}'::jsonb) from (select coalesce(tags->>'structure', 'untagged') k,
        jsonb_build_object('sent', count(*), 'replied', count(*) filter (where replied_at is not null)) c from s group by 1) g),
    'messages', (select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'sent_at', sent_at, 'body', body, 'tags', tags,
        'ari_original', ari_original, 'edit_diff', edit_diff, 'title', title, 'company', company, 'ae', ae, 'replied', replied_at is not null)
        order by sent_at), '[]'::jsonb) from s))
$$;
revoke all on function public.ari_worker_copy_stats(date, date) from public, anon, authenticated;
grant execute on function public.ari_worker_copy_stats(date, date) to ari_worker, service_role;

revoke all on function public.ari_tags_for(text, text, text) from public, anon, authenticated;
grant execute on function public.ari_tags_for(text, text, text) to service_role;

-- realtime: the app shows "Edited" from draft_edits
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'draft_edits') then
    alter publication supabase_realtime add table public.draft_edits;
  end if;
end $$;

insert into supabase_migrations.schema_migrations(version, name) values ('0031', 'copy_tags_edits_rescan_push') on conflict do nothing;
