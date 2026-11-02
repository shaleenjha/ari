-- Checks after 0047 (staging/prod-safe: one statement, reads plus a synthetic probe that is rolled back by the final raise).
-- Expected reply: ERROR "ALL 0047 STAGING CHECKS PASSED" (HTTP 400 = pass). Any other error names the failing check.
do $$
declare n int; pid text := 'P999999947'; acc uuid; j jsonb; r jsonb; jid bigint; mid bigint;
begin
  -- 1. objects
  if to_regclass('public.pipeline_jobs') is null or to_regclass('public.fact_check_cache') is null then raise exception 'FAIL 1: tables'; end if;
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'ari_pipeline') then raise exception 'FAIL 1: queue'; end if;
  if not exists (select 1 from cron.job where jobname = 'ari-pipeline') then raise exception 'FAIL 1: cron'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0047') then raise exception 'FAIL 1: ledger'; end if;
  -- 2. RLS + grants: no anon/authenticated writes, no anon read, RPCs service_role only
  if not (select relrowsecurity from pg_class where oid = 'public.pipeline_jobs'::regclass) then raise exception 'FAIL 2: rls'; end if;
  if has_table_privilege('anon', 'public.pipeline_jobs', 'select') or has_table_privilege('authenticated', 'public.pipeline_jobs', 'insert')
     or has_table_privilege('authenticated', 'public.fact_check_cache', 'select') then raise exception 'FAIL 2: table grants'; end if;
  if has_function_privilege('authenticated', 'public.ari_pipeline_enqueue(text, text, text, boolean)', 'execute')
     or has_function_privilege('anon', 'public.ari_pipeline_finish(bigint, bigint, text, jsonb, text, text, text, text, int)', 'execute')
     or not has_function_privilege('service_role', 'public.ari_pipeline_read(int, int)', 'execute')
     or has_function_privilege('authenticated', 'public.ari_pipeline_alert(bigint)', 'execute')
     then raise exception 'FAIL 2: function grants'; end if;
  -- review #51: no pre-review-50 overloads left behind (old 2-arg start / 8-arg finish)
  if to_regprocedure('public.ari_pipeline_start(bigint, bigint)') is not null
     or to_regprocedure('public.ari_pipeline_finish(bigint, bigint, text, jsonb, text, text, text, text)') is not null
     or (select count(*) from pg_proc where proname in ('ari_pipeline_start', 'ari_pipeline_finish') and pronamespace = 'public'::regnamespace) <> 2
     then raise exception 'FAIL 2: old pipeline overloads left'; end if;
  -- 3. kill switch untouched (must be off outside a test run)
  if exists (select 1 from ai_budget where enabled) then raise exception 'FAIL 3: ai_budget is on'; end if;
  -- 4. synthetic probe: Accepted insert -> exactly one research job + one message; repeat update -> nothing new; outbox dedupe
  insert into accounts(company, domain, stage, updated_by) values ('Chk Co 0047', 'chk0047.example', 'Target', 'check') returning id into acc;
  insert into people(id, name, title, company, account_id, stage, accepted, updated_by)
  values (pid, 'Chk Person', 'VP Security', 'Chk Co 0047', acc, 'Accepted', now(), 'check');
  select count(*) into n from pipeline_jobs where contact_id = pid and stage = 'research'; if n <> 1 then raise exception 'FAIL 4: research jobs %', n; end if;
  select count(*) into n from pipeline_jobs where contact_id = pid and stage <> 'research'; if n <> 0 then raise exception 'FAIL 4: early stage'; end if;
  update people set accepted = now() where id = pid;
  perform ari_pipeline_enqueue(pid, 'research', null, false);
  select count(*) into n from pipeline_jobs where contact_id = pid; if n <> 1 then raise exception 'FAIL 4: repeat made %', n; end if;
  -- dm1 before research: start must refuse
  j := ari_pipeline_enqueue(pid, 'dm1', 'chk-dm1-early', false);
  if (ari_pipeline_start((j->>'job_id')::bigint, (j->>'msg_id')::bigint))->>'reason' <> 'wait_research' then raise exception 'FAIL 4: dm1 ran early'; end if;
  perform ari_ai_notify_dm_ready(pid);
  perform ari_notify('draft_due', 'draft:dm1:ai:' || pid, 'DM1 ready', 'x', '/ops', pid, acc);   -- the old second key
  select count(*) into n from notifications where person_id = pid and kind = 'draft_due'; if n <> 1 then raise exception 'FAIL 4: dm1 notifications %', n; end if;
  -- 5. review #50 lease: claim research, a second start while the lease lives is refused (no double run)
  select id, msg_id into jid, mid from pipeline_jobs where contact_id = pid and stage = 'research';
  r := ari_pipeline_start(jid, mid, 150); if not (r->>'ok')::boolean then raise exception 'FAIL 5: first claim %', r; end if;
  r := ari_pipeline_start(jid, mid, 150); if r->>'reason' <> 'running' then raise exception 'FAIL 5: second claim %', r; end if;
  -- a stale finish (wrong attempt) is fenced off
  r := ari_pipeline_finish(jid, mid, 'done', null, null, null, null, null, 99); if r->>'reason' <> 'not_running' then raise exception 'FAIL 5: fence %', r; end if;
  -- 6. failed research -> exactly one delayed retry job, no alert yet; the retry's failure -> one alert, no 3rd job
  r := ari_pipeline_finish(jid, mid, 'failed', null, null, 'probe failure', null, null, 1);
  if r #>> '{next,retry_job}' is null then raise exception 'FAIL 6: no retry %', r; end if;
  select count(*) into n from notifications where dedupe_key = 'ops:pipeline:' || jid; if n <> 0 then raise exception 'FAIL 6: alert before retry'; end if;
  select id, msg_id into jid, mid from pipeline_jobs where id = (r #>> '{next,retry_job}')::bigint;
  if (select vt from pgmq.q_ari_pipeline where msg_id = mid) < now() + interval '200 seconds' then raise exception 'FAIL 6: retry not delayed'; end if;
  r := ari_pipeline_start(jid, mid, 150); if not (r->>'ok')::boolean then raise exception 'FAIL 6: retry claim %', r; end if;
  r := ari_pipeline_finish(jid, mid, 'failed', null, null, 'probe failure 2', null, null, 1);
  if r #>> '{next,retry_job}' is not null then raise exception 'FAIL 6: second retry'; end if;
  select count(*) into n from pipeline_jobs where contact_id = pid and stage = 'research'; if n <> 2 then raise exception 'FAIL 6: research jobs %', n; end if;
  select count(*) into n from notifications where dedupe_key = 'ops:pipeline:' || jid and kind = 'ops_alert'; if n <> 1 then raise exception 'FAIL 6: alert %', n; end if;
  perform ari_pipeline_alert(jid);
  select count(*) into n from notifications where kind = 'ops_alert' and person_id = pid; if n <> 1 then raise exception 'FAIL 6: alert dedupe %', n; end if;
  -- 7. Oct 28 2026 kick fix: with the budget on, an Accepted insert queues exactly ONE pg_net request in the SAME transaction
  --    (the old vt <= now() test never saw the message pgmq.send had just stamped with clock_timestamp()). The budget flip and
  --    the queued request are both undone by the final raise, so nothing is ever sent.
  if position('clock_timestamp()' in pg_get_functiondef('public.ari_pipeline_kick()'::regprocedure)) = 0 then raise exception 'FAIL 7: kick still compares vt with now()'; end if;
  update ai_budget set enabled = true where id = 1;
  select count(*) into n from net.http_request_queue;
  insert into people(id, name, title, company, account_id, stage, accepted, updated_by)
  values (pid || 'k', 'Chk Kick', 'Director Security', 'Chk Co 0047', acc, 'Accepted', now(), 'check');
  if (select count(*) from net.http_request_queue) - n <> 1 then
    raise exception 'FAIL 7: Accepted insert queued % kick request(s) in the same transaction, want 1', (select count(*) from net.http_request_queue) - n; end if;
  update ai_budget set enabled = false where id = 1;
  raise exception 'ALL 0047 STAGING CHECKS PASSED';
end $$;
