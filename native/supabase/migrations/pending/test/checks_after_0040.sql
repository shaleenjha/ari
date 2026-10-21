-- LOCAL/CI ONLY (throwaway prod-shape DB from run_local.sh). Checks for 0040 (S1 R7 broker guardrails) and the R7 kill
-- switch files. Synthetic data only; never run on staging or prod (it rewrites ari_broker_state and bans a test user).
\set ON_ERROR_STOP 1
-- local stand-ins for the Auth columns the kill switch touches (real Supabase has them)
alter table auth.users add column if not exists banned_until timestamptz;
alter table auth.users add column if not exists role text;
insert into auth.users(id, email, role) values ('00000000-0000-4000-8000-00000000a1a1', 'worker-synthetic', 'ari_worker')
  on conflict (id) do nothing;

do $$
declare g jsonb; n int; nn int; d text;
begin
  -- 1. objects, grants
  if not exists (select 1 from public.ari_broker_state where id = 1 and enabled and max_per_hour = 3) then raise exception 'FAIL 1: state row'; end if;
  if has_function_privilege('ari_worker', 'public.ari_broker_gate(text)', 'execute') then raise exception 'FAIL 1: ari_worker can gate'; end if;
  if has_function_privilege('authenticated', 'public.ari_broker_gate(text)', 'execute') then raise exception 'FAIL 1: authenticated can gate'; end if;
  if has_function_privilege('anon', 'public.ari_broker_note(text, text, text)', 'execute') then raise exception 'FAIL 1: anon can note'; end if;
  if not has_function_privilege('service_role', 'public.ari_broker_gate(text)', 'execute') then raise exception 'FAIL 1: service_role cannot gate'; end if;
  if has_table_privilege('ari_worker', 'public.ari_broker_mints', 'select') or has_table_privilege('authenticated', 'public.ari_broker_mints', 'select')
     or has_table_privilege('anon', 'public.ari_broker_state', 'select') then raise exception 'FAIL 1: table readable'; end if;
  if not exists (select 1 from cron.job where jobname = 'ari-broker-mints-prune') then raise exception 'FAIL 1: prune cron'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0040') then raise exception 'FAIL 1: ledger'; end if;
  raise notice 'ok 1 objects and grants';

  -- 2. windows (IST). 2026-10-21 is a Wednesday.
  select windows::text into d from public.ari_broker_state where id = 1;
  if not public.ari_broker_in_window('2026-10-21 15:00 +05:30', d::jsonb) then raise exception 'FAIL 2: Wed 15:00'; end if;
  if not public.ari_broker_in_window('2026-10-21 23:59:30 +05:30', d::jsonb) then raise exception 'FAIL 2: Wed 23:59:30'; end if;
  if not public.ari_broker_in_window('2026-10-22 03:59 +05:30', d::jsonb) then raise exception 'FAIL 2: Thu 03:59'; end if;
  if public.ari_broker_in_window('2026-10-22 05:10 +05:30', d::jsonb) then raise exception 'FAIL 2: Thu 05:10 (odd hour) allowed'; end if;
  if not public.ari_broker_in_window('2026-10-22 10:05 +05:30', d::jsonb) then raise exception 'FAIL 2: Thu 10:05 off-hours slot'; end if;
  if public.ari_broker_in_window('2026-10-22 10:45 +05:30', d::jsonb) then raise exception 'FAIL 2: Thu 10:45 allowed'; end if;
  if public.ari_broker_in_window('2026-10-22 14:59 +05:30', d::jsonb) then raise exception 'FAIL 2: Thu 14:59 allowed'; end if;
  if not public.ari_broker_in_window('2026-10-24 01:00 +05:30', d::jsonb) then raise exception 'FAIL 2: Sat 01:00 (Fri night)'; end if;
  if public.ari_broker_in_window('2026-10-25 01:00 +05:30', d::jsonb) then raise exception 'FAIL 2: Sun 01:00 allowed'; end if;
  if public.ari_broker_in_window('2026-10-24 15:30 +05:30', d::jsonb) then raise exception 'FAIL 2: Sat 15:30 allowed'; end if;
  if not public.ari_broker_in_window('2026-10-21 09:30 +00', d::jsonb) then raise exception 'FAIL 2: 09:30 UTC = 15:00 IST'; end if;
  if public.ari_broker_in_window(now(), '[]'::jsonb) then raise exception 'FAIL 2: empty windows allowed'; end if;
  raise notice 'ok 2 windows';

  -- 3. gate: open window for the rest of the checks
  update public.ari_broker_state set windows = '[{"dow":[0,1,2,3,4,5,6],"from":"00:00","to":"23:59"}]' where id = 1;
  delete from public.ari_broker_mints;
  select count(*) into nn from public.notifications where dedupe_key like 'ops:broker:%';
  g := public.ari_broker_gate('t1'); if not (g->>'allow')::boolean then raise exception 'FAIL 3: first mint refused %', g; end if;
  perform public.ari_broker_note('t1', 'minted', null);
  g := public.ari_broker_gate('t2'); perform public.ari_broker_note('t2', 'error', 'auth 400');
  g := public.ari_broker_gate('t3'); if not (g->>'allow')::boolean then raise exception 'FAIL 3: third refused'; end if;
  g := public.ari_broker_gate('t4'); if (g->>'allow')::boolean or g->>'reason' <> 'rate' then raise exception 'FAIL 3: 4th in an hour allowed %', g; end if;
  select count(*) into n from public.ari_broker_mints where outcome = 'refused' and reason = 'rate'; if n <> 1 then raise exception 'FAIL 3: refusal not logged'; end if;
  if not exists (select 1 from public.ari_broker_mints where request_id = 't1' and outcome = 'minted') then raise exception 'FAIL 3: note minted'; end if;
  if not exists (select 1 from public.ari_broker_mints where request_id = 't2' and outcome = 'error' and reason = 'auth 400') then raise exception 'FAIL 3: note error'; end if;
  select count(*) into n from public.notifications where dedupe_key = 'ops:broker:' || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24');
  if n <> 1 then raise exception 'FAIL 3: expected exactly one alert for this hour, found %', n; end if;
  if exists (select 1 from public.notifications where dedupe_key like 'ops:broker:%'
             and (title ~* 'worker|token|database|supabase|api' or body ~* 'worker|token|database|supabase|api')) then raise exception 'FAIL 3: alert copy'; end if;
  -- older than an hour no longer counts
  update public.ari_broker_mints set at = now() - interval '61 minutes';
  g := public.ari_broker_gate('t5'); if not (g->>'allow')::boolean then raise exception 'FAIL 3: cap did not reset'; end if;
  begin perform public.ari_broker_note('t5', 'refused', null); raise exception 'FAIL 3: bad outcome accepted';
  exception when raise_exception then if sqlerrm like 'FAIL%' then raise; end if; end;
  raise notice 'ok 3 gate: cap 3 per hour, log, one generic alert per hour';

  -- 4. disabled / outside window
  update public.ari_broker_state set enabled = false where id = 1;
  g := public.ari_broker_gate('t6'); if (g->>'allow')::boolean or g->>'reason' <> 'disabled' then raise exception 'FAIL 4: disabled %', g; end if;
  update public.ari_broker_state set enabled = true, windows = '[]' where id = 1;
  g := public.ari_broker_gate('t7'); if (g->>'allow')::boolean or g->>'reason' <> 'outside window' then raise exception 'FAIL 4: window %', g; end if;
  delete from public.ari_broker_state; g := public.ari_broker_gate('t8');
  if (g->>'allow')::boolean then raise exception 'FAIL 4: missing state allowed'; end if;
  insert into public.ari_broker_state(id) values (1);
  raise notice 'ok 4 disabled, outside window and missing state all refuse';
end $$;

-- 5. kill switch files: ari_worker cannot be assumed by authenticator while ON; restored by OFF
\ir ../../../ops/r7_kill_switch_on.sql
do $$ begin
  if pg_has_role('authenticator', 'ari_worker', 'member') then raise exception 'FAIL 5: authenticator still has ari_worker'; end if;
  if (select enabled from public.ari_broker_state where id = 1) then raise exception 'FAIL 5: broker still enabled'; end if;
  if (select banned_until from auth.users where role = 'ari_worker') is null then raise exception 'FAIL 5: not banned'; end if;
end $$;
set session authorization authenticator;
do $$ begin
  begin execute 'set role ari_worker'; raise exception 'FAIL 5: set role ari_worker worked with the kill switch on';
  exception when insufficient_privilege then null; end;
end $$;
reset session authorization;
\ir ../../../ops/r7_kill_switch_off.sql
set session authorization authenticator;
set role ari_worker;
reset role;
reset session authorization;
do $$ begin
  if (select banned_until from auth.users where role = 'ari_worker') is not null then raise exception 'FAIL 5: still banned'; end if;
  raise notice 'ok 5 kill switch on refuses ari_worker, off restores it';
  raise notice 'ALL 0040 TESTS PASSED';
end $$;
