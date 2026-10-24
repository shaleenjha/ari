-- 0040 (S1 release 7, design D; PENDING, not applied anywhere). Guardrails for the ari-worker-token broker.
-- 0039 is reserved for Diamond (docs/specs/06), so R7 takes 0040. Two new platform tables (no workspace_id, like
-- backup_runs), five new functions, one cron job, one ledger row, and ONE change to an existing function:
-- notifications_privacy() (0031) now lets kind 'ops_alert' through unchanged (fixed, name-free health/security text that
-- used to arrive as "Ari update"); every other kind is rewritten exactly as before. The live worker (static token) and
-- the app keep working whether or not the broker is deployed. The rollback restores 0031's body exactly.
-- Rollback: 0040_s1_release7_broker_rollback.sql. Tests: test/checks_after_0040.sql (throwaway local/CI DB only).
--   1. ari_broker_state: one row. enabled (kill switch part 1), max_per_hour (default 3; the worker's cache makes ~1 the
--      normal), windows (IST, when a mint is allowed; default = the worker window + the off-hours housekeeping slots).
--   2. ari_broker_mints: one row per gate call (time, request id, outcome, reason). No token, no user data. 30-day prune.
--   3. ari_broker_gate(request_id): ONE transaction under an advisory lock decides enabled -> in window -> under the hourly
--      cap, logs the call, and on refusal queues ONE generic ops_alert push per hour (no infrastructure words).
--   4. ari_broker_note(request_id, outcome, reason): the broker records minted / error after the Auth call; an error
--      alerts the same way.
--   5. ari_worker_whoami(): echoes the caller's JWT role / sub / has_session / ttl (never the token). Only ari_worker may
--      call it; runbook step c uses it through the proxy to prove the worker really sends the broker token.
--   Only service_role (the broker's own named secret key ari_worker_token) may execute 3 and 4. anon and authenticated
--   get nothing here; ari_worker gets only 5.
-- The worker Auth user itself is created through the Auth admin API in the runbook (not SQL), with role ari_worker.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create table if not exists public.ari_broker_state (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default true,
  max_per_hour int not null default 3 check (max_per_hour between 1 and 12),
  windows jsonb not null default '[
    {"dow": [1,2,3,4,5], "from": "15:00", "to": "23:59", "why": "worker e8fbd86f, Mon to Fri evening"},
    {"dow": [2,3,4,5,6], "from": "00:00", "to": "03:59", "why": "worker e8fbd86f, after midnight"},
    {"dow": [0,1,2,3,4,5,6], "even_hours": true, "from_min": 0, "to_min": 30, "why": "off-hours check 228b5138 at :05 every 2 h"}
  ]'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.ari_broker_state(id) values (1) on conflict (id) do nothing;

create table if not exists public.ari_broker_mints (
  id bigserial primary key,
  at timestamptz not null default now(),
  request_id text not null,
  outcome text not null check (outcome in ('allowed', 'minted', 'refused', 'error')),
  reason text
);
create index if not exists ari_broker_mints_at on public.ari_broker_mints(at);

alter table public.ari_broker_state enable row level security;
alter table public.ari_broker_mints enable row level security;
revoke all on public.ari_broker_state, public.ari_broker_mints from public, anon, authenticated, ari_worker;
revoke all on sequence public.ari_broker_mints_id_seq from public, anon, authenticated, ari_worker;

-- is p_at (any zone) inside one of the IST windows?
create or replace function public.ari_broker_in_window(p_at timestamptz, p_windows jsonb) returns boolean
language sql stable set search_path = '' as $$
  with t as (select (p_at at time zone 'Asia/Kolkata') lt)
  select coalesce(bool_or(
           (w -> 'dow') @> to_jsonb(extract(dow from t.lt)::int)
           and case when coalesce((w ->> 'even_hours')::boolean, false)
                    then extract(hour from t.lt)::int % 2 = 0
                         and extract(minute from t.lt)::int between (w ->> 'from_min')::int and (w ->> 'to_min')::int
                    else t.lt::time >= (w ->> 'from')::time
                         and date_trunc('minute', t.lt)::time <= (w ->> 'to')::time end), false)  -- 'to' is inclusive
    from t, jsonb_array_elements(coalesce(p_windows, '[]'::jsonb)) w
$$;
revoke all on function public.ari_broker_in_window(timestamptz, jsonb) from public, anon, authenticated, ari_worker;
grant execute on function public.ari_broker_in_window(timestamptz, jsonb) to service_role;

create or replace function public.ari_broker_gate(p_request_id text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st public.ari_broker_state; n int; why text; ok boolean;
begin
  perform pg_advisory_xact_lock(hashtext('ari_broker_gate'));
  select * into st from public.ari_broker_state where id = 1;
  if not found or not st.enabled then why := 'disabled';
  elsif not public.ari_broker_in_window(now(), st.windows) then why := 'outside window';
  else
    select count(*) into n from public.ari_broker_mints
     where at > now() - interval '1 hour' and outcome in ('allowed', 'minted', 'error');
    if n >= st.max_per_hour then why := 'rate'; end if;
  end if;
  ok := why is null;
  -- a refusal with the same reason inside the last minute is not logged again (no unbounded growth from a loop)
  if ok or not exists (select 1 from public.ari_broker_mints
                        where outcome = 'refused' and reason = why and at > now() - interval '1 minute') then
    insert into public.ari_broker_mints(request_id, outcome, reason)
    values (left(coalesce(p_request_id, ''), 64), case when ok then 'allowed' else 'refused' end, coalesce(why, 'ok'));
  end if;
  if not ok then
    perform public.ari_notify('ops_alert', 'ops:broker:' || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24'),
      'Ari security check', 'Ari blocked an unexpected background sign-in. Open Hark if this keeps happening.', '/ops', null, null);
  end if;
  return jsonb_build_object('allow', ok, 'reason', coalesce(why, 'ok'));
end $$;
revoke all on function public.ari_broker_gate(text) from public, anon, authenticated, ari_worker;
grant execute on function public.ari_broker_gate(text) to service_role;

create or replace function public.ari_broker_note(p_request_id text, p_outcome text, p_reason text default null) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_outcome not in ('minted', 'error') then raise exception 'bad outcome'; end if;
  update public.ari_broker_mints set outcome = p_outcome, reason = coalesce(left(p_reason, 120), reason)
   where request_id = left(coalesce(p_request_id, ''), 64) and outcome = 'allowed';
  if p_outcome = 'error' then
    perform public.ari_notify('ops_alert', 'ops:broker:' || to_char(date_trunc('hour', now()), 'YYYYMMDDHH24'),
      'Ari security check', 'Ari blocked an unexpected background sign-in. Open Hark if this keeps happening.', '/ops', null, null);
  end if;
end $$;
revoke all on function public.ari_broker_note(text, text, text) from public, anon, authenticated, ari_worker;
grant execute on function public.ari_broker_note(text, text, text) to service_role;

-- 5. server-side identity check for runbook step c (R7 review F3)
create or replace function public.ari_worker_whoami() returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('role', c ->> 'role', 'sub', c ->> 'sub', 'has_session', (c ->> 'session_id') is not null,
                            'ttl', (c ->> 'exp')::bigint - (c ->> 'iat')::bigint)
    from (select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb c) x
$$;
revoke all on function public.ari_worker_whoami() from public, anon, authenticated;
grant execute on function public.ari_worker_whoami() to ari_worker;

-- 6. ops_alert pushes keep their fixed, name-free text (R7 review F1). Copy of 0031's body; only the first line changed.
create or replace function public.notifications_privacy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('test', 'digest', 'ops_alert') or coalesce(new.dedupe_key, '') like 'digest:%' then return new; end if;
  if coalesce((public.ari_pref('push_show_names', 'false'::jsonb) #>> '{}')::boolean, false) then return new; end if;
  case new.kind
    when 'replied' then new.title := 'New reply on LinkedIn'; new.body := 'Someone you messaged wrote back. Open Ari to answer.';
    when 'accepted' then new.title := 'New connection accepted'; new.body := 'Their DM1 draft is ready in Ari.';
    when 'meeting' then new.title := 'Meeting set'; new.body := 'Open Ari to see the details.';
    when 'research_done' then
      if coalesce(new.dedupe_key, '') like 'rescan:%' then new.title := 'Re-scan done'; new.body := 'A fresh look at an account is waiting in Ari.';
      else new.title := 'Brief ready'; new.body := 'A new account brief is waiting in Ari.'; end if;
    when 'draft_due' then
      new.title := case when new.dedupe_key like 'draft:dm1:%' then 'DM1 ready'
                        when new.dedupe_key like 'draft:dm2:%' then 'DM2 drafted'
                        when new.dedupe_key like 'draft:dm3:%' then 'DM3 drafted'
                        else 'Draft ready' end;
      new.body := 'Ready for your review in Ari.';
    else new.title := 'Ari update'; new.body := 'Open Ari to see what changed.';
  end case;
  return new;
end $$;
revoke all on function public.notifications_privacy() from public, anon, authenticated;

select cron.schedule('ari-broker-mints-prune', '17 20 * * *',
  $$delete from public.ari_broker_mints where at < now() - interval '30 days'$$);

insert into supabase_migrations.schema_migrations(version, name) values ('0040', 's1_release7_broker') on conflict do nothing;
commit;
