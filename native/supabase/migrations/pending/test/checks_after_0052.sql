-- Checks for 0052 scan controls. ONE statement, synthetic rows only (run rows dated January 2030, settings changed in place),
-- and it ENDS IN A DELIBERATE RAISE so the whole transaction rolls back (nothing kept). Staging-safe; never needs fixtures.
-- Through the Management API the reply "ALL 0052 CHECKS PASSED (deliberate raise ...)" (HTTP 400) is a pass; "FAIL n: ..." is a fail.
-- Mon 2030-01-07 is a Monday. Times below are IST.
\set ON_ERROR_STOP 1
do $$
declare
  ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
  owner_uid constant text := 'b14d1605-c766-4684-9a5b-71ffcab6967b';
  d jsonb; j jsonb; k text; n int; rid bigint; ok boolean;
  t0 timestamptz := '2030-01-07 00:00 Asia/Kolkata';            -- Monday 00:00 IST
  f_owner text[] := array['kyte_scan_settings_get()', 'kyte_scan_settings_set(text, boolean, text, text[], time, time)', 'kyte_scan_request(text, boolean)', 'kyte_scan_resume(text)'];
  f_worker text[] := array['kyte_worker_scan_check(text)', 'kyte_worker_scan_start(text, text)', 'kyte_worker_scan_finish(bigint, text, int, text)'];
  f_inner text[] := array['kyte_scan_caps(text)', 'kyte_scan_daymin(time)', 'kyte_scan_decide(text, timestamptz)', 'kyte_scan_view(text)'];
begin
  -- 1. objects, ledger, grants ------------------------------------------------------------------------------------------------
  if to_regclass('public.scan_settings') is null or to_regclass('public.scan_control_runs') is null then raise exception 'FAIL 1: tables missing'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0052') then raise exception 'FAIL 1: no ledger row 0052'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.scan_settings'::regclass) or not (select relrowsecurity from pg_class where oid = 'public.scan_control_runs'::regclass) then
    raise exception 'FAIL 1: RLS off'; end if;
  foreach k in array array['public.scan_settings', 'public.scan_control_runs'] loop
    if has_table_privilege('anon', k, 'select') or has_table_privilege('authenticated', k, 'insert') or has_table_privilege('authenticated', k, 'update')
       or has_table_privilege('authenticated', k, 'delete') then raise exception 'FAIL 1: % open to anon or direct app writes', k; end if;
    if exists (select 1 from pg_roles where rolname = 'ari_worker') and (has_table_privilege('ari_worker', k, 'select') or has_table_privilege('ari_worker', k, 'update')) then
      raise exception 'FAIL 1: ari_worker has direct access to %', k; end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') and not (has_table_privilege('service_role', k, 'select') and has_table_privilege('service_role', k, 'update')) then
      raise exception 'FAIL 1: service_role lacks explicit grants on %', k; end if;
  end loop;
  foreach k in array f_owner loop
    if to_regprocedure('public.' || k) is null then raise exception 'FAIL 1: % missing', k; end if;
    if has_function_privilege('anon', 'public.' || k, 'execute') or not has_function_privilege('authenticated', 'public.' || k, 'execute') then raise exception 'FAIL 1: grants on %', k; end if;
    if exists (select 1 from pg_roles where rolname = 'ari_worker') and has_function_privilege('ari_worker', 'public.' || k, 'execute') then raise exception 'FAIL 1: ari_worker can run %', k; end if;
    if position('is_owner()' in pg_get_functiondef(('public.' || k)::regprocedure)) = 0 then raise exception 'FAIL 1: % has no owner check', k; end if;
  end loop;
  foreach k in array f_worker loop
    if has_function_privilege('anon', 'public.' || k, 'execute') or has_function_privilege('authenticated', 'public.' || k, 'execute') then raise exception 'FAIL 1: app can run %', k; end if;
    if exists (select 1 from pg_roles where rolname = 'ari_worker') and not has_function_privilege('ari_worker', 'public.' || k, 'execute') then raise exception 'FAIL 1: ari_worker cannot run %', k; end if;
  end loop;
  foreach k in array f_inner loop
    if has_function_privilege('anon', 'public.' || k, 'execute') or has_function_privilege('authenticated', 'public.' || k, 'execute') then raise exception 'FAIL 1: app can run %', k; end if;
    if exists (select 1 from pg_roles where rolname = 'ari_worker') and has_function_privilege('ari_worker', 'public.' || k, 'execute') then raise exception 'FAIL 1: ari_worker can run %', k; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    foreach k in array f_owner || f_worker || f_inner loop
      if not has_function_privilege('service_role', 'public.' || k, 'execute') then raise exception 'FAIL 1: service_role cannot run %', k; end if;
    end loop;
  end if;
  raise notice 'ok 1 objects, ledger, grants';

  -- 2. defaults = today's behaviour (only meaningful before Owner changes anything: checked on the seeded values) ---------------
  if exists (select 1 from scan_settings where workspace_id = ws and updated_by = 'migration 0052') then
    if (select count(*) from scan_settings where workspace_id = ws and updated_by = 'migration 0052' and enabled and not (
          (scan = 'connections' and frequency = '1x' and days = array['mon','tue','wed','thu','fri'] and start_time = '14:45' and end_time = '03:59')
       or (scan = 'sent' and frequency = '1x' and days = array['mon'] and start_time = '14:30' and end_time = '03:59')
       or (scan = 'profile' and frequency = 'paced' and days = array['mon','tue','wed','thu','fri'] and start_time = '15:00' and end_time = '03:59'))) > 0 then
      raise exception 'FAIL 2: seeded defaults differ from today''s schedules'; end if;
  end if;
  raise notice 'ok 2 defaults';

  -- reset to the defaults inside this transaction so the decision tests are deterministic
  update scan_settings set enabled = true, frequency = case scan when 'profile' then 'paced' else '1x' end,
    days = case scan when 'sent' then array['mon'] else array['mon','tue','wed','thu','fri'] end,
    start_time = case scan when 'connections' then '14:45'::time when 'sent' then '14:30'::time else '15:00'::time end, end_time = '03:59',
    requested_at = null, blocked_at = null, blocked_note = null where workspace_id = ws;

  -- 3. the decision (pure, at fixed 2030 times) ---------------------------------------------------------------------------------
  d := kyte_scan_decide('connections', t0 + interval '14 hours');
  if d->>'reason' <> 'before_hours' or (d->>'next_due')::timestamptz <> t0 + interval '14 hours 45 minutes' then raise exception 'FAIL 3a: %', d; end if;
  d := kyte_scan_decide('connections', t0 + interval '14 hours 50 minutes');
  if not (d->>'run')::boolean or d->>'reason' <> 'due' then raise exception 'FAIL 3b: %', d; end if;
  insert into scan_control_runs(scan, trigger, started_at, finished_at, status) values ('connections', 'scheduled', t0 + interval '14 hours 50 minutes', t0 + interval '14 hours 55 minutes', 'ok');
  d := kyte_scan_decide('connections', t0 + interval '15 hours 10 minutes');
  if d->>'reason' <> 'too_soon' then raise exception 'FAIL 3c: %', d; end if;
  d := kyte_scan_decide('connections', t0 + interval '16 hours');
  if d->>'reason' <> 'done_today' or (d->>'next_due')::timestamptz <> t0 + interval '1 day 14 hours 45 minutes' then raise exception 'FAIL 3d: %', d; end if;
  d := kyte_scan_decide('connections', t0 + interval '5 days 15 hours');                     -- Saturday
  if d->>'reason' <> 'not_today' or (d->>'next_due')::timestamptz <> t0 + interval '7 days 14 hours 45 minutes' then raise exception 'FAIL 3e: %', d; end if;
  update scan_settings set frequency = '2x' where workspace_id = ws and scan = 'connections';
  d := kyte_scan_decide('connections', t0 + interval '16 hours');
  if d->>'reason' <> 'gap' or (d->>'next_due')::timestamptz <> t0 + interval '18 hours 50 minutes' then raise exception 'FAIL 3f: %', d; end if;
  d := kyte_scan_decide('connections', t0 + interval '19 hours');
  if d->>'reason' <> 'due' then raise exception 'FAIL 3g: %', d; end if;
  insert into scan_control_runs(scan, trigger, started_at, finished_at, status) values ('connections', 'scheduled', t0 + interval '19 hours', t0 + interval '19 hours 5 minutes', 'empty');
  update scan_settings set requested_at = t0 + interval '20 hours 30 minutes' where workspace_id = ws and scan = 'connections';
  d := kyte_scan_decide('connections', t0 + interval '20 hours 40 minutes');
  if not (d->>'run')::boolean or d->>'reason' <> 'requested' then raise exception 'FAIL 3h: %', d; end if;
  update scan_settings set enabled = false where workspace_id = ws and scan = 'connections';
  d := kyte_scan_decide('connections', t0 + interval '20 hours 40 minutes');
  if d->>'reason' <> 'requested' then raise exception 'FAIL 3i Scan now works while the schedule is off: %', d; end if;
  insert into scan_control_runs(scan, trigger, started_at, finished_at, status) values ('connections', 'requested', t0 + interval '20 hours 40 minutes', t0 + interval '20 hours 45 minutes', 'ok');
  d := kyte_scan_decide('connections', t0 + interval '23 hours');
  if d->>'reason' <> 'daily_cap' then raise exception 'FAIL 3j hard cap beats the request: %', d; end if;
  d := kyte_scan_decide('connections', t0 + interval '1 day 5 hours');                       -- Tue 05:00, request still pending
  if d->>'reason' <> 'outside_allowed_hours' or (d->>'next_due')::timestamptz <> t0 + interval '1 day 9 hours' then raise exception 'FAIL 3k: %', d; end if;
  update scan_settings set requested_at = null, enabled = true, frequency = '1x' where workspace_id = ws and scan = 'connections';
  d := kyte_scan_decide('profile', t0 + interval '1 day 2 hours');                            -- Tue 02:00 = Monday's scan day
  if d->>'reason' <> 'due' then raise exception 'FAIL 3l window across midnight: %', d; end if;
  insert into scan_control_runs(scan, trigger, started_at, status) values ('profile', 'scheduled', t0 + interval '1 day 2 hours', 'running');
  d := kyte_scan_decide('connections', t0 + interval '1 day 2 hours 5 minutes');
  if d->>'reason' <> 'busy' then raise exception 'FAIL 3m one LinkedIn read at a time: %', d; end if;
  update scan_settings set blocked_at = t0 where workspace_id = ws and scan = 'sent';
  d := kyte_scan_decide('sent', t0 + interval '15 hours');
  if d->>'reason' <> 'blocked' then raise exception 'FAIL 3n: %', d; end if;
  update scan_settings set blocked_at = null where workspace_id = ws and scan = 'sent';
  delete from scan_control_runs where started_at >= t0 - interval '1 day' and started_at < t0 + interval '8 days';
  raise notice 'ok 3 decisions';

  -- 4. owner RPCs as the signed-in owner, a stranger, and anon --------------------------------------------------------------------
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', owner_uid, 'aal', 'aal2')::text, true);
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  execute 'set local role authenticated';
  j := kyte_scan_settings_get();
  if jsonb_array_length(j->'scans') <> 3 or j->'scans'->0->>'scan' <> 'connections' or j->'scans'->0->'caps' is null then raise exception 'FAIL 4a: %', j; end if;
  j := kyte_scan_settings_set('connections', p_start => '07:00');
  if j->>'error' is distinct from 'hours_outside_limits' then raise exception 'FAIL 4b: %', j; end if;
  j := kyte_scan_settings_set('connections', p_start => '18:00', p_end => '17:00');
  if j->>'error' is distinct from 'bad_hours' then raise exception 'FAIL 4c: %', j; end if;
  j := kyte_scan_settings_set('connections', p_frequency => '2x', p_start => '15:00', p_end => '17:00');
  if j->>'error' is distinct from 'window_too_short' then raise exception 'FAIL 4d: %', j; end if;
  j := kyte_scan_settings_set('sent', p_frequency => 'paced');
  if j->>'error' is distinct from 'bad_frequency' then raise exception 'FAIL 4e: %', j; end if;
  j := kyte_scan_settings_set('sent', p_days => array['bad']);
  if j->>'error' is distinct from 'bad_days' then raise exception 'FAIL 4f: %', j; end if;
  j := kyte_scan_settings_set('connections', p_frequency => '2x', p_days => array['MON', 'wed'], p_start => '10:00', p_end => '22:30');
  if not (j->>'ok')::boolean or j->'scan'->>'frequency' <> '2x' or j->'scan'->>'start' <> '10:00' or j->'scan'->'days' <> '["mon", "wed"]'::jsonb then raise exception 'FAIL 4g: %', j; end if;
  ok := false;
  begin update scan_settings set enabled = false where scan = 'profile'; exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL 4h: the app could update scan_settings directly'; end if;
  ok := false;
  begin insert into scan_control_runs(scan, trigger) values ('profile', 'requested'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL 4h: the app could insert a run directly'; end if;
  if (select count(*) from scan_settings) <> 3 then raise exception 'FAIL 4i: owner cannot read own settings under RLS'; end if;
  j := kyte_scan_resume('profile');
  if not (j->>'ok')::boolean then raise exception 'FAIL 4j: %', j; end if;
  execute 'reset role';
  -- stranger
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', '00000000-0000-4000-8000-00000000052a', 'aal', 'aal2')::text, true);
  perform set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000052a', true);
  execute 'set local role authenticated';
  ok := false;
  begin perform kyte_scan_settings_get(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL 4k: a stranger read the settings'; end if;
  ok := false;
  begin perform kyte_scan_request('connections'); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL 4k: a stranger asked for a scan'; end if;
  if (select count(*) from scan_settings) <> 0 then raise exception 'FAIL 4k: a stranger sees settings rows'; end if;
  execute 'reset role';
  execute 'set local role anon';
  ok := false;
  begin perform kyte_scan_settings_get(); exception when insufficient_privilege then ok := true; end;
  if not ok then raise exception 'FAIL 4l: anon read the settings'; end if;
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claim.role', '', true);
  raise notice 'ok 4 owner RPCs, stranger, anon';

  -- 5. Scan now -> worker claim -> finish, at the real clock ---------------------------------------------------------------------
  update scan_settings set enabled = true, frequency = '1x', days = array['mon','tue','wed','thu','fri','sat','sun'], start_time = '09:00', end_time = '03:59',
    requested_at = null, blocked_at = null where workspace_id = ws;
  perform set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', owner_uid, 'aal', 'aal2')::text, true);
  perform set_config('request.jwt.claim.sub', owner_uid, true);
  execute 'set local role authenticated';
  j := kyte_scan_request('sent');
  execute 'reset role';
  perform set_config('request.jwt.claims', '', true); perform set_config('request.jwt.claim.sub', '', true);
  if j->>'error' = 'daily_cap' then
    raise notice 'ok 5 skipped: sent already hit its daily cap today (real runs)';
  elsif not (j->>'ok')::boolean or not (j->'scan'->>'requested')::boolean then raise exception 'FAIL 5a: %', j;
  else
    if exists (select 1 from pg_roles where rolname = 'ari_worker') then execute 'set local role ari_worker'; end if;
    ok := false;
    begin perform 1 from scan_settings limit 1; exception when insufficient_privilege then ok := true; end;
    if not ok and current_user = 'ari_worker' then raise exception 'FAIL 5b: ari_worker can read scan_settings directly'; end if;
    d := kyte_worker_scan_check('sent');
    j := kyte_worker_scan_start('sent', 'checks_0052');
    if d->>'reason' = 'requested' then
      if not (j->>'run')::boolean or j->>'trigger' <> 'requested' or j->>'run_id' is null then raise exception 'FAIL 5c: %', j; end if;
      rid := (j->>'run_id')::bigint;
      j := kyte_worker_scan_start('profile', 'checks_0052');
      if j->>'reason' <> 'busy' or (j->>'run')::boolean then raise exception 'FAIL 5d: second scan started while one runs: %', j; end if;
      j := kyte_worker_scan_finish(rid, 'blocked', 0, 'security check shown');
      if not (j->>'ok')::boolean then raise exception 'FAIL 5e: %', j; end if;
      j := kyte_worker_scan_finish(rid, 'ok', 3, null);
      if (j->>'ok')::boolean then raise exception 'FAIL 5f: finish ran twice'; end if;
      j := kyte_worker_scan_start('sent', 'checks_0052');
      if j->>'reason' <> 'blocked' then raise exception 'FAIL 5g: %', j; end if;
      execute 'reset role';
      if (select requested_at from scan_settings where workspace_id = ws and scan = 'sent') is not null then raise exception 'FAIL 5h: request not consumed'; end if;
      if (select blocked_at from scan_settings where workspace_id = ws and scan = 'sent') is null then raise exception 'FAIL 5h: blocked not recorded'; end if;
      raise notice 'ok 5 Scan now, claim, busy, blocked, finish once';
    else
      if (j->>'run')::boolean then raise exception 'FAIL 5c: started although check said %', d; end if;
      execute 'reset role';
      raise notice 'ok 5 partial: the real clock or real runs hold the request (%), claim not exercised', d->>'reason';
    end if;
  end if;

  raise exception 'ALL 0052 CHECKS PASSED (deliberate raise: synthetic rows rolled back)';
end $$;
