-- 0052 scan controls (Owner approved Oct 30 2026 19:24 IST). WRITTEN, local rehearsal only; staging first, never prod without Owner + a PAT.
-- Spec: docs/specs/scan_controls.md. Rollback: 0052_scan_controls_rollback.sql. Checks: test/checks_after_0052.sql.
--
-- What it does (teaching version):
--   Owner sets, per LinkedIn read scan (connections, sent, profile), whether it runs, how often, on which days and between which
--   hours, and can ask for a run now. The scans themselves stay scheduled tasks outside the database; at start each one asks
--   kyte_worker_scan_start(scan) "should I run?" and at the end reports with kyte_worker_scan_finish(...).
--   1. scan_settings: one row per (workspace, scan). Seeded with today's behaviour, so nothing changes when this lands.
--   2. scan_control_runs: one row per run that opened LinkedIn (or was claimed to). Idle polls write nothing.
--      Not the 0032 scan_runs table: that one feeds ari_scan_deadman() (a 25 min miss rule for the old 10 min signal scan),
--      so daily LinkedIn reads written there would raise false alarms.
--   3. kyte_scan_caps(scan): the safety caps. Constants in code: only a migration can raise them, never the app.
--   4. kyte_scan_decide(scan, now): the one decision function. Order: blocked, another LinkedIn read running, daily cap,
--      minimum gap, outside the allowed hours, then (Scan now request -> run), off, not an active day, outside Owner's hours,
--      done for today, gap between scheduled runs, else due. Returns {run, reason, next_due}.
--   5. Owner RPCs (signed-in owner only, is_owner()): kyte_scan_settings_get(), kyte_scan_settings_set(...),
--      kyte_scan_request(scan, cancel), kyte_scan_resume(scan). The app never writes the tables directly.
--   6. Worker RPCs (ari_worker and service_role): kyte_worker_scan_check(scan) (read-only), kyte_worker_scan_start(scan, task)
--      (decides and claims atomically, consumes a Scan now request), kyte_worker_scan_finish(run, result, items, note)
--      (a 'blocked' result holds that scan until Owner taps Resume).
-- Time model: all times IST. A "scan day" runs 04:00 to 03:59 IST (the same day the 15:00 to 03:59 worker window uses), so a
--   window like 15:00 to 03:59 is one day and its weekday is the day it started on.
-- Needs: 0033 (app.workspaces, Owner workspace row), is_owner() (0024). Re-runnable; the ledger row is written last.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regclass('app.workspaces') is null or to_regprocedure('public.is_owner()') is null then
    raise exception '0052 needs app.workspaces (0033) and public.is_owner() first'; end if;
  if not exists (select 1 from app.workspaces where id = 'f5a1e000-0000-4000-8000-000000000001') then
    raise exception '0052 needs the Owner workspace row (0033)'; end if;
end $$;

-- 1. settings -----------------------------------------------------------------------------------------------------------------
create table if not exists public.scan_settings (
  workspace_id uuid not null default 'f5a1e000-0000-4000-8000-000000000001' references app.workspaces(id) on delete cascade,
  scan text not null check (scan in ('connections', 'sent', 'profile')),
  enabled boolean not null default true,
  frequency text not null check (frequency in ('1x', '2x', 'paced')),
  days text[] not null check (cardinality(days) between 1 and 7 and days <@ array['mon','tue','wed','thu','fri','sat','sun']),
  start_time time not null,
  end_time time not null,
  requested_at timestamptz,                    -- Scan now: pending until a run claims it (expires after 12 h)
  requested_by uuid,
  blocked_at timestamptz,                      -- LinkedIn showed a check: no run until Owner taps Resume
  blocked_note text check (blocked_note is null or length(blocked_note) <= 200),
  updated_at timestamptz not null default now(),
  updated_by text,
  primary key (workspace_id, scan),
  check (frequency <> 'paced' or scan = 'profile')
);
alter table public.scan_settings enable row level security;

-- 2. runs ---------------------------------------------------------------------------------------------------------------------
create table if not exists public.scan_control_runs (
  id bigserial primary key,
  workspace_id uuid not null default 'f5a1e000-0000-4000-8000-000000000001' references app.workspaces(id) on delete cascade,
  scan text not null check (scan in ('connections', 'sent', 'profile')),
  trigger text not null check (trigger in ('scheduled', 'requested')),
  task text check (task is null or length(task) <= 64),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'empty', 'idle', 'error', 'blocked', 'abandoned')),
  items int check (items is null or items between 0 and 10000),
  note text check (note is null or length(note) <= 200)
);
create index if not exists scan_control_runs_scan_started on public.scan_control_runs(workspace_id, scan, started_at desc);
alter table public.scan_control_runs enable row level security;

-- owner may read both (defence in depth; the app reads through kyte_scan_settings_get). Nobody but service_role writes directly.
drop policy if exists owner_read on public.scan_settings;
create policy owner_read on public.scan_settings for select to authenticated using ((select public.is_owner()));
drop policy if exists owner_read on public.scan_control_runs;
create policy owner_read on public.scan_control_runs for select to authenticated using ((select public.is_owner()));
revoke all on public.scan_settings, public.scan_control_runs from public, anon, authenticated;
revoke all on sequence public.scan_control_runs_id_seq from public, anon, authenticated;
grant select on public.scan_settings, public.scan_control_runs to authenticated;   -- RLS: owner only, read only
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ari_worker') then
    execute 'revoke all on public.scan_settings, public.scan_control_runs from ari_worker';
    execute 'revoke all on sequence public.scan_control_runs_id_seq from ari_worker';
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant select, insert, update, delete on public.scan_settings, public.scan_control_runs to service_role';
    execute 'grant usage, select on sequence public.scan_control_runs_id_seq to service_role';
  end if;
end $$;

-- defaults = today's behaviour (connections weekdays from 14:45, sent Mondays from 14:30, profile paced in the worker window)
insert into public.scan_settings(scan, enabled, frequency, days, start_time, end_time, updated_by) values
  ('connections', true, '1x',    array['mon','tue','wed','thu','fri'], '14:45', '03:59', 'migration 0052'),
  ('sent',        true, '1x',    array['mon'],                         '14:30', '03:59', 'migration 0052'),
  ('profile',     true, 'paced', array['mon','tue','wed','thu','fri'], '15:00', '03:59', 'migration 0052')
on conflict (workspace_id, scan) do nothing;

-- 3. safety caps (code, not data) -------------------------------------------------------------------------------------------
-- max_runs_day: every run that opens LinkedIn, scheduled or Scan now. gap_min: between two scheduled runs (2x).
-- now_gap_min: between ANY two runs (Scan now included). allowed window (env_start..env_end): the only hours any run may start.
-- per_batch / per_day_1x / per_day_2x: profile scan only (one profile per run). stale_min: a running row older than this is abandoned.
create or replace function public.kyte_scan_caps(p_scan text) returns jsonb language sql immutable set search_path = public as $$
  select case p_scan
    when 'connections' then '{"max_runs_day": 3, "gap_min": 240, "now_gap_min": 60, "env_start": "09:00", "env_end": "03:59", "max_rows": 80, "stale_min": 90}'::jsonb
    when 'sent'        then '{"max_runs_day": 2, "gap_min": 360, "now_gap_min": 60, "env_start": "09:00", "env_end": "03:59", "max_rows": 300, "stale_min": 90}'::jsonb
    when 'profile'     then '{"max_runs_day": 25, "gap_min": 15, "now_gap_min": 15, "env_start": "09:00", "env_end": "03:59", "per_batch": 5, "rest_min": 120, "per_day_1x": 5, "per_day_2x": 10, "stale_min": 60}'::jsonb
  end
$$;

-- minutes since the 04:00 IST scan-day start (0..1439)
create or replace function public.kyte_scan_daymin(p_t time) returns int language sql immutable set search_path = public as $$
  select ((extract(hour from p_t)::int * 60 + extract(minute from p_t)::int) - 240 + 1440) % 1440
$$;

-- 4. the decision ----------------------------------------------------------------------------------------------------------------
create or replace function public.kyte_scan_decide(p_scan text, p_now timestamptz default now()) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
  c jsonb := public.kyte_scan_caps(p_scan);
  s scan_settings;
  ist timestamp := p_now at time zone 'Asia/Kolkata';
  sday date := (ist - interval '4 hours')::date;                  -- scan day
  day0 timestamptz := ((sday::timestamp + interval '4 hours') at time zone 'Asia/Kolkata');   -- 04:00 IST that day
  m int := public.kyte_scan_daymin(ist::time);
  dname text := lower(to_char(sday, 'Dy'));
  env_s int; env_e int; st_m int; en_m int;
  n_all int; n_sched int; last_any timestamptz; last_sched timestamptz; want int; gap int; nowgap int;
  nxt timestamptz; d int; dd date;
  req boolean; over boolean;
begin
  if c is null then raise exception 'unknown scan %', p_scan; end if;
  select * into s from scan_settings where workspace_id = ws and scan = p_scan;
  if not found then  -- no row: behave as the defaults (should not happen after this migration)
    return jsonb_build_object('run', false, 'reason', 'no_settings', 'next_due', null);
  end if;
  env_s := public.kyte_scan_daymin((c->>'env_start')::time); env_e := public.kyte_scan_daymin((c->>'env_end')::time);
  st_m := public.kyte_scan_daymin(s.start_time); en_m := public.kyte_scan_daymin(s.end_time);
  gap := (c->>'gap_min')::int; nowgap := (c->>'now_gap_min')::int;
  req := s.requested_at is not null and s.requested_at > p_now - interval '12 hours';

  if s.blocked_at is not null then return jsonb_build_object('run', false, 'reason', 'blocked', 'next_due', null); end if;
  -- one LinkedIn read at a time, across all three scans (they share one signed-in browser)
  if exists (select 1 from scan_control_runs r where r.workspace_id = ws and r.status = 'running'
               and r.started_at > p_now - make_interval(mins => (public.kyte_scan_caps(r.scan)->>'stale_min')::int)) then
    return jsonb_build_object('run', false, 'reason', 'busy', 'next_due', null, 'requested', req); end if;

  select count(*) filter (where status in ('running', 'ok', 'empty', 'error', 'blocked', 'abandoned')),
         count(*) filter (where status in ('running', 'ok', 'empty', 'error', 'blocked', 'abandoned') and trigger = 'scheduled'),
         max(started_at) filter (where status in ('running', 'ok', 'empty', 'error', 'blocked', 'abandoned')),
         max(started_at) filter (where status in ('running', 'ok', 'empty', 'error', 'blocked', 'abandoned') and trigger = 'scheduled')
    into n_all, n_sched, last_any, last_sched
    from scan_control_runs where workspace_id = ws and scan = p_scan and started_at >= day0;
  -- the gaps look back across the 04:00 boundary too
  select max(started_at) into last_any from scan_control_runs
   where workspace_id = ws and scan = p_scan and status in ('running', 'ok', 'empty', 'error', 'blocked', 'abandoned');

  -- hard caps first: no request and no setting gets past these
  if n_all >= (c->>'max_runs_day')::int then
    return jsonb_build_object('run', false, 'reason', 'daily_cap', 'next_due', null, 'requested', req); end if;
  if last_any is not null and last_any > p_now - make_interval(mins => nowgap) then
    return jsonb_build_object('run', false, 'reason', 'too_soon', 'next_due', last_any + make_interval(mins => nowgap), 'requested', req); end if;
  if m < env_s or m > env_e then
    return jsonb_build_object('run', false, 'reason', 'outside_allowed_hours',
      'next_due', case when m < env_s then day0 + make_interval(mins => env_s) else day0 + interval '1 day' + make_interval(mins => env_s) end,
      'requested', req); end if;

  if req then return jsonb_build_object('run', true, 'reason', 'requested', 'next_due', p_now, 'requested', true); end if;
  if not s.enabled then return jsonb_build_object('run', false, 'reason', 'off', 'next_due', null); end if;

  want := case s.frequency when '1x' then case when p_scan = 'profile' then (c->>'per_day_1x')::int else 1 end
                           when '2x' then case when p_scan = 'profile' then (c->>'per_day_2x')::int else 2 end
                           else (c->>'max_runs_day')::int end;
  over := n_sched >= want;
  if dname = any(s.days) and m >= st_m and m <= en_m and not over then
    if last_sched is not null and last_sched > p_now - make_interval(mins => gap) then
      nxt := last_sched + make_interval(mins => gap);
      if nxt <= day0 + make_interval(mins => en_m) then return jsonb_build_object('run', false, 'reason', 'gap', 'next_due', nxt); end if;
      over := true;   -- the next slot would fall after today's hours: done for today
    else
      return jsonb_build_object('run', true, 'reason', 'due', 'next_due', p_now);
    end if;
  end if;

  -- not due now: when is the next scheduled start?
  nxt := null;
  if dname = any(s.days) and m < st_m and not over then
    nxt := day0 + make_interval(mins => st_m);
  else
    for d in 1..7 loop
      dd := sday + d;
      if lower(to_char(dd, 'Dy')) = any(s.days) then
        nxt := ((dd::timestamp + interval '4 hours') at time zone 'Asia/Kolkata') + make_interval(mins => st_m); exit;
      end if;
    end loop;
  end if;
  return jsonb_build_object('run', false,
    'reason', case when not (dname = any(s.days)) then 'not_today' when over then 'done_today'
                   when m < st_m then 'before_hours' else 'after_hours' end,
    'next_due', nxt);
end $$;

-- the view the app shows: settings + last run + decision + caps, one object per scan
create or replace function public.kyte_scan_view(p_scan text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'scan', s.scan, 'enabled', s.enabled, 'frequency', s.frequency, 'days', to_jsonb(s.days),
    'start', to_char(s.start_time, 'HH24:MI'), 'end', to_char(s.end_time, 'HH24:MI'),
    'requested', s.requested_at is not null and s.requested_at > now() - interval '12 hours', 'requested_at', s.requested_at,
    'blocked', s.blocked_at is not null, 'blocked_at', s.blocked_at,
    'updated_at', s.updated_at,
    'last_run', (select jsonb_build_object('started_at', r.started_at, 'finished_at', r.finished_at, 'result', r.status,
                                           'items', r.items, 'trigger', r.trigger)
                   from scan_control_runs r where r.workspace_id = s.workspace_id and r.scan = s.scan and r.status <> 'idle'
                  order by r.started_at desc limit 1),
    'decision', public.kyte_scan_decide(s.scan, now()),
    'caps', public.kyte_scan_caps(s.scan))
  from scan_settings s where s.workspace_id = 'f5a1e000-0000-4000-8000-000000000001' and s.scan = p_scan
$$;

-- 5. owner RPCs ------------------------------------------------------------------------------------------------------------------
create or replace function public.kyte_scan_settings_get() returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jsonb_build_object('now', now(), 'scans', jsonb_build_array(public.kyte_scan_view('connections'), public.kyte_scan_view('sent'), public.kyte_scan_view('profile')));
end $$;

-- every argument optional: null keeps the current value. Returns {ok, error?, scan: view}.
create or replace function public.kyte_scan_settings_set(p_scan text, p_enabled boolean default null, p_frequency text default null,
  p_days text[] default null, p_start time default null, p_end time default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
  c jsonb := public.kyte_scan_caps(p_scan); s scan_settings; f text; dy text[]; st time; en time;
begin
  if not public.is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if c is null then return jsonb_build_object('ok', false, 'error', 'unknown_scan'); end if;
  select * into s from scan_settings where workspace_id = ws and scan = p_scan for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_scan'); end if;
  f := coalesce(p_frequency, s.frequency);
  if f not in ('1x', '2x', 'paced') or (f = 'paced' and p_scan <> 'profile') then return jsonb_build_object('ok', false, 'error', 'bad_frequency'); end if;
  dy := coalesce((select array_agg(distinct lower(btrim(x))) from unnest(p_days) x), s.days);
  if cardinality(dy) is null or cardinality(dy) < 1 or not dy <@ array['mon','tue','wed','thu','fri','sat','sun'] then
    return jsonb_build_object('ok', false, 'error', 'bad_days'); end if;
  st := date_trunc('minute', coalesce(p_start, s.start_time)::interval)::time; en := date_trunc('minute', coalesce(p_end, s.end_time)::interval)::time;
  if public.kyte_scan_daymin(st) >= public.kyte_scan_daymin(en) then return jsonb_build_object('ok', false, 'error', 'bad_hours'); end if;
  if public.kyte_scan_daymin(st) < public.kyte_scan_daymin((c->>'env_start')::time) or public.kyte_scan_daymin(en) > public.kyte_scan_daymin((c->>'env_end')::time) then
    return jsonb_build_object('ok', false, 'error', 'hours_outside_limits'); end if;
  if f = '2x' and p_scan <> 'profile' and public.kyte_scan_daymin(en) - public.kyte_scan_daymin(st) < (c->>'gap_min')::int then
    return jsonb_build_object('ok', false, 'error', 'window_too_short'); end if;
  update scan_settings set enabled = coalesce(p_enabled, enabled), frequency = f, days = dy, start_time = st, end_time = en,
         updated_at = now(), updated_by = 'app'
   where workspace_id = ws and scan = p_scan;
  return jsonb_build_object('ok', true, 'scan', public.kyte_scan_view(p_scan));
end $$;

-- Scan now (or cancel it). The next poll of that scan (within 10 minutes inside the allowed hours) claims it.
create or replace function public.kyte_scan_request(p_scan text, p_cancel boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001'; s scan_settings; dcs jsonb;
begin
  if not public.is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into s from scan_settings where workspace_id = ws and scan = p_scan for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_scan'); end if;
  if coalesce(p_cancel, false) then
    update scan_settings set requested_at = null, requested_by = null, updated_at = now(), updated_by = 'app' where workspace_id = ws and scan = p_scan;
    return jsonb_build_object('ok', true, 'scan', public.kyte_scan_view(p_scan));
  end if;
  if s.blocked_at is not null then return jsonb_build_object('ok', false, 'error', 'blocked', 'scan', public.kyte_scan_view(p_scan)); end if;
  if s.requested_at is null or s.requested_at <= now() - interval '12 hours' then
    update scan_settings set requested_at = now(), requested_by = auth.uid(), updated_at = now(), updated_by = 'app' where workspace_id = ws and scan = p_scan;
  end if;
  dcs := public.kyte_scan_decide(p_scan, now());
  if dcs->>'reason' = 'daily_cap' then   -- never carry a request over into the next day
    update scan_settings set requested_at = null, requested_by = null where workspace_id = ws and scan = p_scan;
    return jsonb_build_object('ok', false, 'error', 'daily_cap', 'scan', public.kyte_scan_view(p_scan));
  end if;
  -- ok: the request is stored; decision says whether the next poll can take it or what holds it (daily_cap, too_soon, busy, outside_allowed_hours)
  return jsonb_build_object('ok', true, 'scan', public.kyte_scan_view(p_scan), 'decision', dcs);
end $$;

-- Resume after LinkedIn showed a check. Owner's tap only.
create or replace function public.kyte_scan_resume(p_scan text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
begin
  if not public.is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  update scan_settings set blocked_at = null, blocked_note = null, updated_at = now(), updated_by = 'app' where workspace_id = ws and scan = p_scan;
  if not found then return jsonb_build_object('ok', false, 'error', 'unknown_scan'); end if;
  return jsonb_build_object('ok', true, 'scan', public.kyte_scan_view(p_scan));
end $$;

-- 6. worker RPCs -------------------------------------------------------------------------------------------------------------------
create or replace function public.kyte_worker_scan_check(p_scan text) returns jsonb
language sql stable security definer set search_path = public as $$ select public.kyte_scan_decide(p_scan, now()) $$;

create or replace function public.kyte_worker_scan_start(p_scan text, p_task text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001'; dcs jsonb; rid bigint; trg text;
begin
  if public.kyte_scan_caps(p_scan) is null then raise exception 'unknown scan %', p_scan; end if;
  -- serialise all scan starts (one LinkedIn read at a time): lock every settings row in a fixed order
  perform 1 from scan_settings where workspace_id = ws order by scan for update;
  update scan_control_runs r set status = 'abandoned', finished_at = now(), note = coalesce(r.note, 'no finish reported')
   where r.workspace_id = ws and r.status = 'running'
     and r.started_at <= now() - make_interval(mins => (public.kyte_scan_caps(r.scan)->>'stale_min')::int);
  dcs := public.kyte_scan_decide(p_scan, now());
  if not coalesce((dcs->>'run')::boolean, false) then return dcs; end if;
  trg := case when dcs->>'reason' = 'requested' then 'requested' else 'scheduled' end;
  insert into scan_control_runs(scan, trigger, task) values (p_scan, trg, left(p_task, 64)) returning id into rid;
  if trg = 'requested' then
    update scan_settings set requested_at = null, requested_by = null where workspace_id = ws and scan = p_scan;
  end if;
  return dcs || jsonb_build_object('run_id', rid, 'trigger', trg);
end $$;

create or replace function public.kyte_worker_scan_finish(p_run bigint, p_result text, p_items int default null, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r scan_control_runs; n text := nullif(left(btrim(coalesce(p_note, '')), 200), '');
begin
  if p_result not in ('ok', 'empty', 'idle', 'error', 'blocked') then raise exception 'bad result %', p_result; end if;
  update scan_control_runs set status = p_result, finished_at = now(), items = p_items, note = n
   where id = p_run and status = 'running' returning * into r;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_running'); end if;
  if p_result = 'blocked' then
    update scan_settings set blocked_at = now(), blocked_note = n where workspace_id = r.workspace_id and scan = r.scan;
  end if;
  return jsonb_build_object('ok', true, 'scan', r.scan, 'result', p_result);
end $$;

-- grants -------------------------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  -- internal helpers: service_role only
  foreach f in array array['kyte_scan_caps(text)', 'kyte_scan_daymin(time)', 'kyte_scan_decide(text, timestamptz)', 'kyte_scan_view(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'ari_worker') then execute format('revoke all on function public.%s from ari_worker', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', f); end if;
  end loop;
  -- owner RPCs: signed-in (is_owner() inside) + service_role
  foreach f in array array['kyte_scan_settings_get()', 'kyte_scan_settings_set(text, boolean, text, text[], time, time)',
                           'kyte_scan_request(text, boolean)', 'kyte_scan_resume(text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'ari_worker') then execute format('revoke all on function public.%s from ari_worker', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', f); end if;
  end loop;
  -- worker RPCs: ari_worker + service_role
  foreach f in array array['kyte_worker_scan_check(text)', 'kyte_worker_scan_start(text, text)', 'kyte_worker_scan_finish(bigint, text, int, text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'ari_worker') then execute format('grant execute on function public.%s to ari_worker', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', f); end if;
  end loop;
end $$;

-- end-state check, then the ledger row
do $$ begin
  if (select count(*) from public.scan_settings where workspace_id = 'f5a1e000-0000-4000-8000-000000000001') <> 3 then
    raise exception '0052: expected 3 scan_settings rows'; end if;
  if has_table_privilege('authenticated', 'public.scan_settings', 'insert') or has_table_privilege('authenticated', 'public.scan_settings', 'update')
     or has_table_privilege('anon', 'public.scan_settings', 'select') then raise exception '0052: scan_settings open to direct writes'; end if;
  if has_function_privilege('anon', 'public.kyte_scan_settings_set(text, boolean, text, text[], time, time)', 'execute') then
    raise exception '0052: anon can call kyte_scan_settings_set'; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0052', 'scan_controls') on conflict do nothing;
commit;
