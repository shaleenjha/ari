-- Assertions for 0038 (S1 release 6). CI: sql-prod-shape after fixtures_before_0038.sql + 0037 + 0038.
-- One transaction, rolled back; synthetic rows only. Parts 3 (notifications) need the fixtures; elsewhere it is staging-safe.
\set ON_ERROR_STOP on
begin;
create function pg_temp.claims(uid uuid, aal text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', uid, 'aal', aal)::text, true),
         set_config('request.jwt.claim.sub', uid::text, true)
$$;
grant execute on function pg_temp.claims(uuid, text) to authenticated;
insert into public.accounts(id, company) values ('00000000-0000-4000-8000-0000000c0038', 'Synthetic Check Co 38') on conflict do nothing;
insert into public.people(id, name, company, account_id, stage, linkedin_url) values
  ('PA0038', 'Check Person Zero Three Eight', 'Synthetic Check Co 38', '00000000-0000-4000-8000-0000000c0038', 'Connect queued',
   'https://www.linkedin.com/in/check-person-0038/') on conflict do nothing;

-- 1. the signed-in role holds no DELETE on the 17 tables; the push tables keep theirs
do $$
declare t text;
begin
  foreach t in array array['plays','accounts','people','queue','brief','emails','book','research','decisions','threads','tasks',
                           'task_events','messages','attachments','ari_notes','targets','app_changes'] loop
    if has_table_privilege('authenticated', format('public.%I', t), 'DELETE') then raise exception 'FAIL 0038 part 1: authenticated can DELETE %', t; end if;
  end loop;
  if not has_table_privilege('authenticated', 'public.push_subscriptions', 'DELETE') then raise exception 'FAIL 0038 part 1: push_subscriptions changed'; end if;
end $$;

-- 2. as the owner (no factor, as today): a direct delete is refused; every apply_op write still works and writes no name
set local role authenticated;
select pg_temp.claims('b14d1605-c766-4684-9a5b-71ffcab6967b', 'aal1');
do $$
declare r jsonb;
begin
  begin
    delete from public.people where id = 'PA0038';
    raise exception 'FAIL 0038 part 2: owner deleted a person';
  exception when insufficient_privilege then null;
  end;
  for r in select x from (values
      (public.apply_op('chk38-1', 'mark', 'people', 'PA0038', '{"field":"connect_sent"}'::jsonb)),
      (public.apply_op('chk38-2', 'mark', 'people', 'PA0038', '{"field":"dm1_sent"}'::jsonb)),
      (public.apply_op('chk38-3', 'undo', 'people', 'PA0038', '{"field":"dm1_sent"}'::jsonb)),
      (public.apply_op('chk38-4', 'mark', 'people', 'PA0038', '{"field":"replied"}'::jsonb)),
      (public.apply_op('chk38-5', 'set', 'people', 'PA0038', '{"notes":"synthetic note"}'::jsonb)),
      (public.apply_op('chk38-6', 'set', 'accounts', '00000000-0000-4000-8000-0000000c0038',
                       '{"meeting_status":"set","meeting_person":"Check Person Zero Three Eight","meeting_source":"LinkedIn"}'::jsonb))) v(x)
  loop
    if (r ->> 'ok')::boolean is not true then raise exception 'FAIL 0038 part 2: apply_op returned %', r; end if;
  end loop;
end $$;
reset role;
do $$ begin
  if exists (select 1 from public.log_entries where source = 'app' and ts > now() - interval '5 minutes' and detail ilike '%Zero Three Eight%')
    then raise exception 'FAIL 0038 part 2: a new Log row carries the name'; end if;
  if (select count(*) from public.log_entries where source = 'app' and ts > now() - interval '5 minutes'
        and (person_id = 'PA0038' or detail like 'Synthetic Check Co 38%')) < 6 then raise exception 'FAIL 0038 part 2: Log rows missing'; end if;
  if not exists (select 1 from public.log_entries where event = 'Meeting set' and detail like 'Synthetic Check Co 38 · LinkedIn%')
    then raise exception 'FAIL 0038 part 2: Meeting set row does not start with the company (report match, 0009:146)'; end if;
  if exists (select 1 from public.queue where target = 'PA0038' and details ilike '%Zero Three Eight%')
    then raise exception 'FAIL 0038 part 2: queue Draft reply carries the name'; end if;
end $$;

-- 3. notifications: every fixture row now has the trigger's generic text; dedupe_key, sent_at and attempts kept
do $$
declare f record; o record; tw record;
begin
  if to_regclass('public.chk38_notif') is null then raise notice '0038 part 3 skipped (no fixtures here)'; return; end if;
  for f in select * from public.chk38_notif loop
    select * into o from public.notifications where dedupe_key = f.dedupe_key;
    if not found then raise exception 'FAIL 0038 part 3: % was deleted', f.dedupe_key; end if;
    if o.sent_at is distinct from f.sent_at then raise exception 'FAIL 0038 part 3: % sent_at changed', f.dedupe_key; end if;
    if f.kind = 'test' then
      if o.title <> 'Test ping' then raise exception 'FAIL 0038 part 3: test row was rewritten'; end if;
      continue;
    end if;
    if o.title ilike '%Check Person%' or o.body ilike '%Check Person%' or o.title ilike '%Synthetic%' or o.body ilike '%Synthetic%' then
      raise exception 'FAIL 0038 part 3: % still names someone: % / %', f.dedupe_key, o.title, o.body; end if;
    -- a twin written now goes through the privacy trigger; the rewritten row must read exactly the same
    insert into public.notifications(kind, dedupe_key, title, body, url) values (f.kind, f.dedupe_key || ':twin', 'Name here', 'Company here', '/ops')
      returning title, body into tw;
    if tw.title is distinct from o.title or tw.body is distinct from o.body then
      raise exception 'FAIL 0038 part 3: % differs from the trigger: "%"/"%" vs "%"/"%"', f.dedupe_key, o.title, o.body, tw.title, tw.body; end if;
  end loop;
end $$;

-- 4. the worker's Log rewrite functions are gone
do $$ begin
  if to_regprocedure('public.ari_worker_log_repair(text,text,jsonb,jsonb)') is not null or to_regprocedure('public.ari_worker_log_unappend(text)') is not null
    then raise exception 'FAIL 0038 part 4: Log repair functions still exist'; end if;
end $$;

-- 5. shadow purge: unmatched after 7 days, everything after 30, matched recent rows stay; nobody but the job can run it
insert into public.gmail_shadow_events(msg_id, kind, profile_url, name, event_at, ingested_at) values
  ('chk38-m-new', 'accept', 'https://www.linkedin.com/in/check-person-0038', 'Check Person Zero Three Eight', now(), now()),
  ('chk38-m-10d', 'reply',  'https://www.linkedin.com/in/check-person-0038', 'Check Person Zero Three Eight', now() - interval '10 days', now() - interval '10 days'),
  ('chk38-u-3d',  'accept', 'https://www.linkedin.com/in/someone-else-0038', 'Someone Else', now() - interval '3 days', now() - interval '3 days'),
  ('chk38-u-10d', 'accept', 'https://www.linkedin.com/in/someone-else-0038', 'Someone Else', now() - interval '10 days', now() - interval '10 days'),
  ('chk38-m-40d', 'accept', 'https://www.linkedin.com/in/check-person-0038', 'Check Person Zero Three Eight', now() - interval '40 days', now() - interval '40 days');
do $$
declare r jsonb; left_ text;
begin
  r := public.ari_gmail_shadow_purge();
  select string_agg(msg_id, ',' order by msg_id) into left_ from public.gmail_shadow_events where msg_id like 'chk38-%';
  if left_ is distinct from 'chk38-m-10d,chk38-m-new,chk38-u-3d' then raise exception 'FAIL 0038 part 5: left %, purge said %', left_, r; end if;
  if has_function_privilege('authenticated', 'public.ari_gmail_shadow_purge()', 'execute') or has_function_privilege('anon', 'public.ari_gmail_shadow_purge()', 'execute')
     or has_function_privilege('ari_worker', 'public.ari_gmail_shadow_purge()', 'execute') then raise exception 'FAIL 0038 part 5: purge callable by a client role'; end if;
  if (select count(*) from cron.job where jobname = 'ari-gmail-shadow-purge' and schedule = '15 20 * * *') <> 1 then raise exception 'FAIL 0038 part 5: purge job'; end if;
end $$;

-- 6. a hard delete (service role / maintenance only now) takes the person's replies with it
insert into public.replies(person_id, snippet) values ('PA0038', 'synthetic reply text');
do $$ begin
  if (select confdeltype from pg_constraint where conname = 'replies_person_id_fkey' and conrelid = 'public.replies'::regclass) <> 'c'
    then raise exception 'FAIL 0038 part 6: replies FK is not CASCADE'; end if;
  delete from public.people where id = 'PA0038';
  if exists (select 1 from public.replies where person_id = 'PA0038') then raise exception 'FAIL 0038 part 6: reply survived the delete'; end if;
end $$;

-- 7. ledger and the two recorded cron jobs, once each, as live
do $$ begin
  if (select count(*) from supabase_migrations.schema_migrations where version in ('0036', '0038')) <> 2 then raise exception 'FAIL 0038 part 7: ledger rows'; end if;
  if (select count(*) from cron.job where jobname = 'ari-session-expiry' and schedule = '17 * * * *' and command like 'delete from auth.sessions where%') <> 1
     or (select count(*) from cron.job where jobname = 'ari-weekly-digest' and schedule = '30 5 * * 6' and command = 'select public.ari_weekly_digest()') <> 1
    then raise exception 'FAIL 0038 part 7: cron jobs not recorded as live'; end if;
  raise notice 'ALL 0038 TESTS PASSED';
end $$;
rollback;
-- Final row: the Management API returns only the last statement's result, so success = HTTP 201 + this row.
select case when to_regclass('public.chk38_notif') is null then 'ALL 0038 TESTS PASSED (part 3 skipped: no fixtures)' else 'ALL 0038 TESTS PASSED' end as result;
