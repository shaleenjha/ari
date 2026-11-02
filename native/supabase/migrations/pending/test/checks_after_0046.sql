-- Checks for 0046 draft assumptions. Staging/prod-safe: ONE statement, synthetic rows only (one auth user
-- chk0046-a@example.com + membership, queue rows 'AS:P999999946:dm1' / 'AS:P999999947:dm2'), and it ENDS IN A DELIBERATE
-- RAISE so the whole transaction rolls back (nothing kept). Through the Management API the reply
-- "ALL 0046 CHECKS PASSED (deliberate raise ...)" (HTTP 400) is a pass; "FAIL n: ..." is a fail.
-- Callers are simulated the way PostgREST does it: SET LOCAL ROLE + request.jwt.claims (transaction-local).
\set ON_ERROR_STOP 1
do $$
declare
  shal constant uuid := 'b14d1605-c766-4684-9a5b-71ffcab6967b';
  ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
  a uuid := gen_random_uuid(); n bigint; j jsonb; ok boolean; q text; r jsonb;
  item constant jsonb := '[{"id":"c0ffee0001","text":"40%","kind":"number","source":"checker","status":"open"},{"id":"c0ffee0002","text":"Ixterlane Health","kind":"customer","source":"drafter","status":"open"}]';
begin
  -- 1. shape, default, constraint, ledger
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'queue' and column_name = 'assumptions'
                 and data_type = 'jsonb' and is_nullable = 'NO' and column_default like '''[]''::jsonb%') then
    raise exception 'FAIL 1: queue.assumptions missing, nullable or wrong default'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.queue'::regclass and conname = 'queue_assumptions_shape' and convalidated) then
    raise exception 'FAIL 1: queue_assumptions_shape missing or not validated'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0046') then raise exception 'FAIL 1: no ledger row 0046'; end if;
  select count(*) into n from public.queue where assumptions <> '[]'::jsonb and id not like 'AS:%';
  if n <> 0 then raise exception 'FAIL 1: % existing rows got a non-empty list', n; end if;
  raise notice 'ok 1 column, default, constraint, ledger';

  -- 2. queue is still owner-private exactly as 0045 left it
  if not (select relrowsecurity from pg_class where oid = 'public.queue'::regclass) then raise exception 'FAIL 2: RLS off on queue'; end if;
  select string_agg(policyname || ':' || array_to_string(roles, ','), ' ' order by policyname) into q from pg_policies where schemaname = 'public' and tablename = 'queue';
  if q <> 'ari_worker_rw:ari_worker owner_all:authenticated' then raise exception 'FAIL 2: queue policies changed: %', q; end if;
  select coalesce(qual, '') into q from pg_policies where schemaname = 'public' and tablename = 'queue' and policyname = 'owner_all';
  if q not like '%owner_uid = ( SELECT auth.uid()%' or q not like '%is_member%' then raise exception 'FAIL 2: owner_all clause changed: %', q; end if;
  raise notice 'ok 2 queue policies unchanged (owner_all + ari_worker_rw)';

  -- 3. explicit grants: authenticated + ari_worker yes, anon/public no
  if has_column_privilege('anon', 'public.queue', 'assumptions', 'select') or has_column_privilege('anon', 'public.queue', 'assumptions', 'insert')
     or has_column_privilege('anon', 'public.queue', 'assumptions', 'update') then raise exception 'FAIL 3: anon can reach queue.assumptions'; end if;
  if exists (select 1 from information_schema.column_privileges where table_schema = 'public' and table_name = 'queue' and column_name = 'assumptions' and grantee = 'PUBLIC') then
    raise exception 'FAIL 3: PUBLIC holds a grant on queue.assumptions'; end if;
  if not (has_column_privilege('authenticated', 'public.queue', 'assumptions', 'select') and has_column_privilege('authenticated', 'public.queue', 'assumptions', 'insert')
          and has_column_privilege('authenticated', 'public.queue', 'assumptions', 'update') and has_column_privilege('ari_worker', 'public.queue', 'assumptions', 'select')
          and has_column_privilege('ari_worker', 'public.queue', 'assumptions', 'insert') and has_column_privilege('ari_worker', 'public.queue', 'assumptions', 'update')) then
    raise exception 'FAIL 3: a required grant is missing'; end if;
  select count(*) into n from information_schema.column_privileges where table_schema = 'public' and table_name = 'queue' and column_name = 'assumptions'
     and grantee in ('authenticated', 'ari_worker') and privilege_type in ('SELECT', 'INSERT', 'UPDATE');
  if n <> 6 then raise exception 'FAIL 3: expected 6 explicit grants, found %', n; end if;
  raise notice 'ok 3 explicit column grants';

  -- 4. the worker path: ari_worker upserts a draft's list (what copy_check.py --store does through PostgREST)
  perform set_config('request.jwt.claims', json_build_object('role', 'ari_worker')::text, true);
  set local role ari_worker;
  insert into public.queue (id, action, target, details, status, result, assumptions)
    values ('AS:P999999946:dm1', 'Draft assumptions', 'P999999946', 'dm1', 'done', '2 to confirm', item)
    on conflict (id) do update set assumptions = excluded.assumptions;
  insert into public.queue (id, action, target, details, status, result, assumptions)
    values ('AS:P999999946:dm1', 'Draft assumptions', 'P999999946', 'dm1', 'done', '2 to confirm', item)
    on conflict (id) do update set assumptions = excluded.assumptions;
  select count(*) into n from public.queue where id = 'AS:P999999946:dm1';
  reset role;
  if n <> 1 then raise exception 'FAIL 4: worker upsert gave % rows', n; end if;
  if (select owner_uid from public.queue where id = 'AS:P999999946:dm1') <> shal then raise exception 'FAIL 4: worker row not owned by Owner (owner_fill)'; end if;
  raise notice 'ok 4 worker upsert, owner filled';

  -- 5. shape constraint refuses a non-array and an oversized list
  ok := false;
  begin update public.queue set assumptions = '{"text":"x"}'::jsonb where id = 'AS:P999999946:dm1';
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL 5: an object was accepted'; end if;
  ok := false;
  begin update public.queue set assumptions = (select jsonb_agg(jsonb_build_object('id', g::text, 'text', 'x', 'kind', 'name', 'status', 'open')) from generate_series(1, 61) g) where id = 'AS:P999999946:dm1';
  exception when check_violation then ok := true; end;
  if not ok then raise exception 'FAIL 5: 61 items accepted'; end if;
  raise notice 'ok 5 shape constraint';

  -- 6. Owner (owner, aal2) reads it and confirms an item through apply_op set (the app path)
  perform set_config('request.jwt.claims', json_build_object('sub', shal, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select assumptions into j from public.queue where id = 'AS:P999999946:dm1';
  if j is null or jsonb_array_length(j) <> 2 then reset role; raise exception 'FAIL 6: Owner cannot read the list'; end if;
  r := public.apply_op('chk0046-' || gen_random_uuid()::text, 'set', 'queue', 'AS:P999999946:dm1',
         jsonb_build_object('assumptions', jsonb_set(item, '{0,status}', '"confirmed"')), now(), 'chk');
  select assumptions -> 0 ->> 'status' into q from public.queue where id = 'AS:P999999946:dm1';
  reset role;
  if q <> 'confirmed' then raise exception 'FAIL 6: apply_op set did not store the confirm (%; %)', q, r; end if;
  raise notice 'ok 6 Owner reads and confirms via apply_op';

  -- 7. another member of the same workspace sees none of Owner's lists and cannot write them
  insert into auth.users (id, aud, role, email) values (a, 'authenticated', 'authenticated', 'chk0046-a@example.com');
  insert into app.memberships (workspace_id, user_id, role, status, display_name) values (ws, a, 'sdr', 'active', 'chk 0046 A');
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  select count(*) into n from public.queue where id like 'AS:%';
  update public.queue set assumptions = '[]'::jsonb where id = 'AS:P999999946:dm1';
  reset role;
  if n <> 0 then raise exception 'FAIL 7: another member sees % assumption rows', n; end if;
  if (select jsonb_array_length(assumptions) from public.queue where id = 'AS:P999999946:dm1') <> 2 then raise exception 'FAIL 7: another member changed Owner''s list'; end if;
  -- ... and their own row is theirs alone (owner_fill gives it their uid; Owner does not see it)
  set local role authenticated;
  insert into public.queue (id, action, target, details, status, assumptions) values ('AS:P999999947:dm2', 'Draft assumptions', 'P999999947', 'dm2', 'done', '[]');
  reset role;
  if (select owner_uid from public.queue where id = 'AS:P999999947:dm2') <> a then raise exception 'FAIL 7: member row not owned by the member'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', shal, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  select count(*) into n from public.queue where id = 'AS:P999999947:dm2';
  reset role;
  if n <> 0 then raise exception 'FAIL 7: Owner sees another member''s row'; end if;
  raise notice 'ok 7 owner-private both ways';

  -- 8. anon gets nothing
  perform set_config('request.jwt.claims', json_build_object('role', 'anon')::text, true);
  ok := false;
  begin set local role anon; select count(*) into n from public.queue; reset role;
  exception when insufficient_privilege then reset role; ok := true; end;
  if not ok and n <> 0 then raise exception 'FAIL 8: anon sees % queue rows', n; end if;
  raise notice 'ok 8 anon sees nothing';

  raise exception 'ALL 0046 CHECKS PASSED (deliberate raise: rolled back, nothing kept)';
end $$;
