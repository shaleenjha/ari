-- Checks after 0047 (staging/prod-safe: one statement, reads plus a synthetic probe that is rolled back by the final raise).
-- Expected reply: ERROR "ALL 0047 STAGING CHECKS PASSED" (HTTP 400 = pass). Any other error names the failing check.
do $$
declare n int; pid text := 'P999999947'; acc uuid; j jsonb;
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
     or has_function_privilege('anon', 'public.ari_pipeline_finish(bigint, bigint, text, jsonb, text, text, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.ari_pipeline_read(int, int)', 'execute') then raise exception 'FAIL 2: function grants'; end if;
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
  raise exception 'ALL 0047 STAGING CHECKS PASSED';
end $$;
