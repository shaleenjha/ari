-- Checks for 0043 (caller checks on ari_account_implied, ari_pref, ari_push_ack). Staging/prod-safe: ONE statement, synthetic rows
-- only (one ari_prefs key '_chk0043', one push_subscriptions row on an .invalid endpoint), and it ENDS IN A DELIBERATE RAISE so the
-- whole transaction rolls back (nothing kept). Through the Management API the reply "ALL 0043 CHECKS PASSED (deliberate raise ...)"
-- (HTTP 400) is a pass; any "FAIL n: ..." is a fail. Callers are simulated the way PostgREST does it: SET LOCAL ROLE authenticated
-- plus request.jwt.claims (transaction-local). Owner = the uid is_owner() is pinned to; stranger = a random uid.
\set ON_ERROR_STOP 1
do $$
declare
  owner_uid constant text := 'b14d1605-c766-4684-9a5b-71ffcab6967b';
  stranger_uid constant text := gen_random_uuid()::text;
  ep constant text := 'https://chk0043.invalid/' || gen_random_uuid()::text;
  v jsonb; ts timestamptz; n int;
begin
  -- 1. grants: ari_account_implied closed to authenticated, the other two still open (the live app needs them)
  if has_function_privilege('authenticated', 'public.ari_account_implied(uuid)', 'execute')
     or has_function_privilege('anon', 'public.ari_account_implied(uuid)', 'execute') then
    raise exception 'FAIL 1: ari_account_implied still callable by authenticated/anon'; end if;
  if not has_function_privilege('postgres', 'public.ari_account_implied(uuid)', 'execute')
     or not has_function_privilege('service_role', 'public.ari_account_implied(uuid)', 'execute') then
    raise exception 'FAIL 1: postgres/service_role lost ari_account_implied'; end if;
  if not has_function_privilege('authenticated', 'public.ari_pref(text,jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.ari_push_ack(text,text)', 'execute')
     or has_function_privilege('anon', 'public.ari_pref(text,jsonb)', 'execute')
     or has_function_privilege('anon', 'public.ari_push_ack(text,text)', 'execute') then
    raise exception 'FAIL 1: ari_pref / ari_push_ack grants changed'; end if;
  if (select p.prosecdef and p.provolatile = 's' and pg_get_function_result(p.oid) = 'jsonb'
             and pg_get_function_arguments(p.oid) = 'p_key text, p_default jsonb DEFAULT NULL::jsonb'
        from pg_proc p where p.oid = 'public.ari_pref(text,jsonb)'::regprocedure) is not true
     or (select p.prosecdef and pg_get_function_result(p.oid) = 'void'
             and pg_get_function_arguments(p.oid) = 'p_endpoint text, p_tag text DEFAULT NULL::text'
        from pg_proc p where p.oid = 'public.ari_push_ack(text,text)'::regprocedure) is not true then
    raise exception 'FAIL 1: a signature, volatility or SECURITY DEFINER changed'; end if;
  begin
    perform set_config('request.jwt.claims', json_build_object('sub', owner_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
    set local role authenticated;
    perform public.ari_account_implied(gen_random_uuid());
    reset role; raise exception 'FAIL 1: authenticated could call ari_account_implied';
  exception when insufficient_privilege then reset role; end;
  -- its definer callers still work as postgres
  perform set_config('request.jwt.claims', '', true);
  perform * from public.ari_account_implied(gen_random_uuid());
  raise notice 'ok 1 grants: ari_account_implied refused to authenticated (42501), still runs as postgres; pref/ack still granted';

  -- 2. ari_pref: owner and non-API callers get the stored value, a signed-in stranger gets the default, nobody gets an error
  insert into public.ari_prefs(key, value, updated_at, updated_by) values ('_chk0043', '"stored"'::jsonb, now(), 'chk0043');
  if public.ari_pref('_chk0043', '"dflt"'::jsonb) <> '"stored"'::jsonb then raise exception 'FAIL 2: postgres (no claims) lost the stored value'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'ari_worker')::text, true);
  if public.ari_pref('_chk0043', '"dflt"'::jsonb) <> '"stored"'::jsonb then raise exception 'FAIL 2: worker claims lost the stored value'; end if;
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  if public.ari_pref('_chk0043', '"dflt"'::jsonb) <> '"stored"'::jsonb then raise exception 'FAIL 2: service_role lost the stored value'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', owner_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  v := public.ari_pref('_chk0043', '"dflt"'::jsonb);
  perform * from public.ari_today_top(((now() at time zone 'Asia/Kolkata')::date));   -- the live /ops caller (invoker -> ari_pref)
  reset role;
  if v <> '"stored"'::jsonb then raise exception 'FAIL 2: owner got % (want stored)', v; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', stranger_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  v := public.ari_pref('_chk0043', '"dflt"'::jsonb);
  perform * from public.ari_today_top(((now() at time zone 'Asia/Kolkata')::date));   -- no error for a stranger either
  reset role;
  if v <> '"dflt"'::jsonb then raise exception 'FAIL 2: stranger got % (want the default)', v; end if;
  raise notice 'ok 2 ari_pref: stored for owner/postgres/worker/service_role, default for a stranger; ari_today_top runs for both';

  -- 3. ari_push_ack: a stranger stamps nothing, the owner stamps the row, a revoked row is never stamped
  perform set_config('request.jwt.claims', '', true);
  insert into public.push_subscriptions(endpoint, p256dh, auth) values (ep, 'chk0043', 'chk0043'), (ep || '-revoked', 'chk0043', 'chk0043');
  update public.push_subscriptions set revoked_at = now() where endpoint = ep || '-revoked';
  perform set_config('request.jwt.claims', json_build_object('sub', stranger_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  perform public.ari_push_ack(ep, 'chk-stranger');
  reset role;
  select last_rx_at into ts from public.push_subscriptions where endpoint = ep;
  if ts is not null then raise exception 'FAIL 3: a stranger stamped the push receipt'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', owner_uid, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  set local role authenticated;
  perform public.ari_push_ack(ep, 'chk-owner');
  perform public.ari_push_ack(ep || '-revoked', 'chk-owner');
  reset role;
  select count(*) into n from public.push_subscriptions where endpoint = ep and last_rx_at is not null and last_rx_tag = 'chk-owner';
  if n <> 1 then raise exception 'FAIL 3: owner ack did not stamp (% rows)', n; end if;
  if exists (select 1 from public.push_subscriptions where endpoint = ep || '-revoked' and last_rx_at is not null) then
    raise exception 'FAIL 3: a revoked subscription was stamped'; end if;
  raise notice 'ok 3 ari_push_ack: stranger 0 rows, owner 1 row, revoked untouched';

  -- 4. ledger
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0043') then raise exception 'FAIL 4: no ledger row 0043'; end if;

  raise exception 'ALL 0043 CHECKS PASSED (deliberate raise: rolled back, nothing kept)';
end $$;
