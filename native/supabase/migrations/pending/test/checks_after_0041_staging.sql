-- Checks for 0041 (Live AI layer) on STAGING or PROD. Written Oct 28 2026 for the staging deploy (work/ai-layer/staging_deploy_plan.md).
-- checks_after_0041.sql is LOCAL/CI only (it flips ai_budget and keeps synthetic rows); this one is staging/prod-safe:
-- ONE statement, synthetic values only, and it ENDS IN A DELIBERATE RAISE so the whole transaction rolls back (nothing kept).
-- Through the Management API the reply "ALL 0041 STAGING CHECKS PASSED (deliberate raise ...)" (HTTP 400) is a pass;
-- "FAIL n: ..." is a fail. Also checks the 0045 interplay (rows the AI layer writes get an owner the owner can see).
\set ON_ERROR_STOP 1
do $$
declare
  shal constant uuid := 'b14d1605-c766-4684-9a5b-71ffcab6967b';
  n bigint; pid text; r jsonb; h text; own uuid;
begin
  -- 1. objects, RLS, grants, cron, ledger, hook secret
  select count(*) into n from pg_class where relnamespace = 'public'::regnamespace
     and relname in ('ai_budget', 'ai_calls', 'ai_jobs', 'ai_triggers', 'gmail_watch') and relrowsecurity;
  if n <> 5 then raise exception 'FAIL 1: RLS not on all 5 tables (%)', n; end if;
  if has_table_privilege('anon', 'public.ai_calls', 'select') or has_table_privilege('authenticated', 'public.ai_calls', 'insert')
     or has_table_privilege('authenticated', 'public.ai_budget', 'update') or has_table_privilege('authenticated', 'public.ai_triggers', 'select')
     then raise exception 'FAIL 1: table grants too wide'; end if;
  if not has_table_privilege('service_role', 'public.ai_calls', 'insert') then raise exception 'FAIL 1: service_role grant missing'; end if;
  if has_function_privilege('authenticated', 'public.ari_ai_budget_reserve(text, text, text, numeric, text, uuid, uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.ari_ai_caller()', 'execute')
     or has_function_privilege('authenticated', 'public.ari_ai_hook()', 'execute')
     or has_function_privilege('authenticated', 'public.ari_ai_import_book()', 'execute')
     or has_function_privilege('authenticated', 'public.ari_ai_kick()', 'execute')
     then raise exception 'FAIL 1: function grants too wide'; end if;
  if not has_function_privilege('authenticated', 'public.ari_ai_caller()', 'execute')
     or not has_function_privilege('service_role', 'public.ari_ai_save_draft(text, text, text, jsonb, text, text)', 'execute')
     or not has_function_privilege('service_role', 'public.ari_gmail_watch_set(text, bigint, text)', 'execute')
     then raise exception 'FAIL 1: function grants missing'; end if;
  if exists (select 1 from pg_roles where rolname = 'ari_worker') and (has_table_privilege('ari_worker', 'public.ai_calls', 'select')
     or has_function_privilege('ari_worker', 'public.ari_ai_context(text, uuid)', 'execute')) then raise exception 'FAIL 1: ari_worker has access'; end if;
  select count(*) into n from cron.job where jobname in ('ari-ai-events', 'ari-gmail-watch-renew', 'ari-ai-prune');
  if n <> 3 then raise exception 'FAIL 1: cron jobs (%)', n; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0041') then raise exception 'FAIL 1: ledger'; end if;
  h := public.ari_ai_hook();
  if h is null or h !~ '^[0-9a-f]{64}$' then raise exception 'FAIL 1: hook secret missing or not 64 hex'; end if;
  raise notice 'ok 1 objects, RLS, grants, cron, ledger, hook';

  -- 2. kill switch: off after apply, kicks are no-ops while off
  if (select enabled from public.ai_budget where id = 1) then raise exception 'FAIL 2: ai_budget enabled (must stay off until the go)'; end if;
  if public.ari_ai_kick() is not null then raise exception 'FAIL 2: ari_ai_kick ran while disabled'; end if;
  if public.ari_gmail_watch_kick() is not null and coalesce((select value from public.app_config where key = 'gmail_watch_topic'), '') = '' then
    raise exception 'FAIL 2: watch kick ran without a topic'; end if;
  raise notice 'ok 2 kill switch off, kicks no-op';

  -- 3. callers: a random signed-in user is not the owner; Owner at aal2 is
  perform set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  if (public.ari_ai_caller() ->> 'owner')::boolean then reset role; raise exception 'FAIL 3: random user reported as owner'; end if;
  select count(*) into n from public.ai_jobs;   -- RLS: owner only, so 0 rows (and no error)
  reset role;
  if n <> 0 then raise exception 'FAIL 3: random user reads ai_jobs (%)', n; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', shal, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  if not (public.ari_ai_caller() ->> 'owner')::boolean then reset role; raise exception 'FAIL 3: Owner at aal2 not owner'; end if;
  reset role;
  raise notice 'ok 3 owner check';

  -- 4. 0045 interplay: research written by the service RPC gets an owner, and Owner (aal2) can read it
  select id into pid from public.people where deleted_at is null order by id limit 1;
  if pid is null then
    raise notice 'skip 4 no people rows';
  else
    perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
    set local role service_role;
    r := public.ari_ai_save_research(pid, null, '[{"fact":"chk0041 synthetic finding","source_url":"https://example.com/chk0041","dated":"2026-10-28"}]'::jsonb,
                                     '{"summary":"chk0041"}'::jsonb);
    reset role;
    select owner_uid into own from public.research where source_url = 'https://example.com/chk0041' order by 1 limit 1;
    if own is null then raise exception 'FAIL 4: research row missing or owner_uid null (%)', r; end if;
    if own = shal then
      perform set_config('request.jwt.claims', json_build_object('sub', shal, 'role', 'authenticated', 'aal', 'aal2')::text, true);
      set local role authenticated;
      select count(*) into n from public.research where source_url = 'https://example.com/chk0041';
      reset role;
      if n < 1 then raise exception 'FAIL 4: Owner cannot read the AI research row'; end if;
    end if;
    raise notice 'ok 4 AI research row owned (%), visible to its owner', own;
  end if;

  raise exception 'ALL 0041 STAGING CHECKS PASSED (deliberate raise: rolled back, nothing kept)';
end $$;
