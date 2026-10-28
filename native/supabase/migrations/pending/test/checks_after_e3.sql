-- Assertions after 0033..0035 on the local prod-shape database. One transaction, rolled back at the end. Synthetic rows only.
-- Also meant for STAGING after the apply: self-contained fixtures, ends in ROLLBACK, so nothing it writes survives.
begin;
-- synthetic fixtures (fake names, example.* style), so the checks do not depend on what the database already holds
insert into public.accounts(id, company) values ('00000000-0000-4000-8000-0000000c4ec1', 'Synthetic Check Co') on conflict do nothing;
insert into public.people(id, name, company, account_id, stage) values
  ('PA9901', 'Check Person One', 'Synthetic Check Co', '00000000-0000-4000-8000-0000000c4ec1', 'Connect queued'),
  ('PA9902', 'Check Person Two', 'Synthetic Check Co', '00000000-0000-4000-8000-0000000c4ec1', 'Accepted') on conflict do nothing;
create temp table chk_total on commit drop as select (select count(*) from public.people) people, (select count(*) from public.accounts) accounts;
grant select on chk_total to authenticated, ari_worker;
do $$
declare n int; m int; t text; ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
begin
  -- shape: 42 tenant tables with NOT NULL workspace_id defaulting to Owner, unique (workspace_id, pk), FK, guard trigger
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and column_name = 'workspace_id' and is_nullable = 'NO' and column_default like '%f5a1e000-0000-4000-8000-000000000001%';
  if n <> 42 then raise exception 'FAIL workspace_id columns: %', n; end if;
  select count(*) into n from pg_indexes where schemaname = 'public' and indexname like '%\_ws\_pk\_uidx';
  if n <> 42 then raise exception 'FAIL ws pk indexes: %', n; end if;
  select count(*) into n from pg_constraint where contype = 'f' and conname like '%\_workspace\_fk' and convalidated;
  if n <> 42 then raise exception 'FAIL workspace fks: %', n; end if;
  select count(*) into n from pg_trigger where tgname = 'ws_guard' and not tgisinternal;
  if n <> 42 then raise exception 'FAIL ws_guard triggers: %', n; end if;
  select count(*) into n from pg_constraint where conname like '%\_ws\_nn';
  if n <> 0 then raise exception 'FAIL helper ws_nn checks left behind: %', n; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name in ('gmail_events', 'scan_runs') and column_name = 'workspace_id')
    then raise exception 'FAIL 0032 tables got workspace_id (not in the approved 42)'; end if;
  select count(*) into n from supabase_migrations.schema_migrations where version in ('0033', '0034', '0035');
  if n <> 3 then raise exception 'FAIL ledger rows 0033..0035: %', n; end if;
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'backup_runs' and column_name = 'workspace_id')
    then raise exception 'FAIL backup_runs got workspace_id'; end if;
  -- every row is in Owner
  foreach t in array array['accounts','people','queue','replies','events','log_entries','account_briefs','notifications','sent_messages','hygiene_findings'] loop
    execute format('select count(*) from public.%I where workspace_id is distinct from $1', t) using ws into n;
    if n <> 0 then raise exception 'FAIL % rows outside Owner: %', t, n; end if;
  end loop;
  -- policies: 37 owner policies are dual, the 11 ari_worker policies are untouched
  select count(*) into n from pg_policies where schemaname = 'public' and roles = '{authenticated}'
     and (coalesce(qual, '') || coalesce(with_check, '')) like '%app.is_member(%workspace_id)%';
  select count(*) into m from pg_policies where schemaname = 'public' and roles = '{authenticated}'
     and ((qual like '%is_owner()%' and qual not like '%app.is_member(%workspace_id)%') or (with_check like '%is_owner()%' and with_check not like '%app.is_member(%workspace_id)%'))
     and exists (select 1 from information_schema.columns c where c.table_schema = 'public' and c.table_name = pg_policies.tablename and c.column_name = 'workspace_id');
  if n <> 37 then raise exception 'FAIL dual owner policies: %', n; end if;
  if m <> 0 then raise exception 'FAIL owner expressions without the member clause: %', m; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and roles = '{ari_worker}' and qual = 'true' and with_check = 'true';
  if n <> 11 then raise exception 'FAIL ari_worker policies: %', n; end if;
  -- privileges: helpers for authenticated only; nothing in app for anon or ari_worker
  if not has_function_privilege('authenticated', 'app.is_member(uuid)', 'execute') then raise exception 'FAIL is_member grant'; end if;
  if has_function_privilege('anon', 'app.is_member(uuid)', 'execute') or has_function_privilege('ari_worker', 'app.is_member(uuid)', 'execute')
    then raise exception 'FAIL is_member over-granted'; end if;
  if has_schema_privilege('ari_worker', 'app', 'usage') or has_schema_privilege('anon', 'app', 'usage') then raise exception 'FAIL app schema usage'; end if;
  if has_table_privilege('anon', 'app.memberships', 'select') or has_table_privilege('authenticated', 'app.memberships', 'insert')
    then raise exception 'FAIL memberships grants'; end if;
  raise notice 'ok shape (42 tables, 37 dual owner policies, owner-only on 0032 tables, 11 worker policies, grants, ledger)';
end $$;

-- the guard: explicit null becomes Owner, workspace_id cannot change
insert into public.plays(name, workspace_id) values ('Guard probe', null);
do $$ begin
  if (select workspace_id from public.plays where name = 'Guard probe') <> 'f5a1e000-0000-4000-8000-000000000001' then raise exception 'FAIL guard insert'; end if;
  begin
    update public.plays set workspace_id = gen_random_uuid() where name = 'Guard probe';
    raise exception 'FAIL guard update allowed';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok ws_guard';
end $$;

-- owner: reads and writes exactly as before (apply_op set + insert, ari_set_account_stage)
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"b14d1605-c766-4684-9a5b-71ffcab6967b","aal":"aal1"}', true),
       set_config('request.jwt.claim.sub', 'b14d1605-c766-4684-9a5b-71ffcab6967b', true), set_config('request.jwt.claim.role', 'authenticated', true);
do $$
declare r jsonb; n int;
begin
  select count(*) into n from public.people; if n <> (select people from chk_total) then raise exception 'FAIL owner sees % of % people', n, (select people from chk_total); end if;
  select count(*) into n from public.accounts; if n <> (select accounts from chk_total) then raise exception 'FAIL owner accounts %', n; end if;
  select count(*) into n from app.workspaces; if n <> 1 then raise exception 'FAIL owner sees own workspace %', n; end if;
  r := public.apply_op('chk-op-1', 'set', 'people', 'PA9901', '{"stage":"Connect sent"}'::jsonb, now(), 'test');
  if (r ->> 'ok')::boolean is not true then raise exception 'FAIL owner apply_op set %', r; end if;
  r := public.apply_op('chk-op-2', 'insert', 'queue', null, '{"id":"Q9990","action":"Synthetic follow up"}'::jsonb, now(), 'test');
  if (r ->> 'ok')::boolean is not true then raise exception 'FAIL owner apply_op insert %', r; end if;
  if (select workspace_id from public.queue where id = 'Q9990') <> 'f5a1e000-0000-4000-8000-000000000001' then raise exception 'FAIL owner insert workspace'; end if;
  begin
    r := public.apply_op('chk-op-3', 'set', 'people', 'PA9901', '{"workspace_id":"00000000-0000-4000-8000-000000000999"}'::jsonb, now(), 'test');
    raise exception 'FAIL owner re-homed a row %', r;
  exception when insufficient_privilege or foreign_key_violation then null;
  end;
  raise notice 'ok owner reads + apply_op writes, cannot re-home a row';
end $$;
reset role;

-- ari_worker: reads + writes through its policies, no access to app
set local role ari_worker;
select set_config('request.jwt.claims', '{"role":"ari_worker"}', true), set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'ari_worker', true);
do $$
declare n int;
begin
  select count(*) into n from public.people; if n <> (select people from chk_total) then raise exception 'FAIL worker sees % people', n; end if;
  insert into public.people(id, name, company, stage) values ('PA9903', 'Worker Probe', 'Synthetic Check Co', 'Connect queued');  -- the worker sends ids (people_app_seq is the app's)
  update public.accounts set company = company where id = '00000000-0000-4000-8000-0000000c4ec1';
  if (select workspace_id from public.people where name = 'Worker Probe') <> 'f5a1e000-0000-4000-8000-000000000001' then raise exception 'FAIL worker insert workspace'; end if;
  begin
    select count(*) into n from app.memberships;
    raise exception 'FAIL worker reads app.memberships';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok ari_worker reads + writes, no app access';
end $$;
reset role;

-- stranger (authenticated, not owner, not member): sees nothing; then as a member of Owner sees rows through the new clause
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated","sub":"d0000000-0000-4000-8000-00000000000d","aal":"aal1"}', true),
       set_config('request.jwt.claim.sub', 'd0000000-0000-4000-8000-00000000000d', true);
do $$ declare n int; begin
  select count(*) into n from public.people; if n <> 0 then raise exception 'FAIL non-member sees people %', n; end if;
  select count(*) into n from app.workspaces; if n <> 0 then raise exception 'FAIL non-member sees workspace'; end if;
  raise notice 'ok non-member sees nothing';
end $$;
reset role;
insert into app.memberships(workspace_id, user_id, role, display_name) values ('f5a1e000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-00000000000d', 'ae', 'Test AE');
set local role authenticated;
do $$ declare n int; begin
  select count(*) into n from public.people; if n < (select people from chk_total) then raise exception 'FAIL member path people %', n; end if;
  begin  -- gmail_* have no grant/policy for authenticated: still closed to members
    select count(*) into n from public.gmail_connection;
    if n <> 0 then raise exception 'FAIL member sees gmail_connection'; end if;
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok member path (app.is_member) opens tenant rows, policy-less tables stay closed';
end $$;
reset role;
select 'ALL E1-E3 CHECKS PASSED' as result;
rollback;
