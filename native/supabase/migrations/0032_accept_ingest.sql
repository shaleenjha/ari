-- 0032 accept ingest + scan dead-man's switch (spec docs/specs/04_engine_watchdog_and_ingest.md, sections 1 and 3).
-- STATUS: written Oct 17 2026 by Otto; NOT applied. Staging first, after 0026_health_alerts (this file asserts it).
-- Numbering note: native/supabase/migrations/pending/ also holds a 0032_app2_e1_tenancy.sql; the two must be renumbered
-- before both land (this one was assigned 0032 by Hark; the pending app2 set is not touched here).
--
-- 1. gmail_events: one row per Gmail message the accept ingest handled (msg_id = idempotency key). Owner-read only.
-- 2. people.accepted_source: 'gmail' | 'manual' (Today queue tap, spec section 4) | null (older rows).
-- 3. ari_worker_accept_record(): records one accept email; first accept sets accepted/stage and one Log row
--    ('Accepted' | detail 'gmail'); a repeat only moves an approximate or later accepted time to the exact email time.
-- 4. ari_worker_gmail_known(): which of a list of Gmail ids are already recorded (the worker's dedupe read).
-- 5. scan_runs + ari_worker_scan_start/finish + ari_scan_deadman(): alert when no scheduled scan started for 2 slots + 5 min,
--    or the last 2 finished runs were empty/error. Hooked into ari_health()/ari_health_alert() from 0026.
-- Rollback: native/supabase/rollbacks/0032_rollback.sql.

do $$ begin
  if to_regprocedure('public.ari_health()') is null or to_regprocedure('public.ari_health_alert()') is null then
    raise exception '0032 needs 0026_health_alerts applied first (ari_health / ari_health_alert missing)';
  end if;
end $$;

-- 1 + 2 ------------------------------------------------------------------------------------------------------------------
create table if not exists public.gmail_events (
  msg_id text primary key,
  kind text not null check (kind in ('accept')),
  person_id text references public.people(id) on delete set null,
  event_at timestamptz not null,               -- the email's internalDate
  matched_by text,                             -- vanity | full_name | none | ambiguous
  created_at timestamptz not null default now()
);
create index if not exists gmail_events_person on public.gmail_events(person_id);
alter table public.gmail_events enable row level security;
drop policy if exists owner_read on public.gmail_events;
create policy owner_read on public.gmail_events for select to authenticated using (public.is_owner());
revoke all on public.gmail_events from anon, public;
revoke insert, update, delete, truncate on public.gmail_events from authenticated;
grant select on public.gmail_events to authenticated;

alter table public.people add column if not exists accepted_source text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'people_accepted_source_check') then
    alter table public.people add constraint people_accepted_source_check check (accepted_source in ('gmail', 'manual'));
  end if;
end $$;
grant select (accepted_source) on public.people to ari_worker;

-- 3 + 4 ------------------------------------------------------------------------------------------------------------------
create or replace function public.ari_worker_accept_record(p_msg_id text, p_person_id text, p_at timestamptz, p_how text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare n int; was timestamptz; now_at timestamptz;
begin
  insert into gmail_events(msg_id, kind, person_id, event_at, matched_by)
  values (p_msg_id, 'accept', p_person_id, p_at, p_how) on conflict (msg_id) do nothing;
  get diagnostics n = row_count;
  if n = 0 or p_person_id is null then return jsonb_build_object('fresh', n > 0); end if;
  select accepted into was from people where id = p_person_id and deleted_at is null;
  if not found then return jsonb_build_object('fresh', true, 'person', 'missing'); end if;
  -- exact email time replaces an approximate one (0028 ts_approx) or a later one (UTC-dated / bare-date rows);
  -- the 0028 trigger then drops 'accepted' from ts_approx because the new value is not 00:00 / 12:00 IST.
  update people set
    accepted = case when accepted is null or 'accepted' = any(ts_approx) then p_at else least(accepted, p_at) end,
    accepted_source = coalesce(accepted_source, 'gmail'),
    stage = case when coalesce(stage, '') in ('', 'Mapped', 'Connect queued', 'Connect sent') then 'Accepted' else stage end
  where id = p_person_id
  returning accepted into now_at;
  if was is null then
    insert into log_entries(ts, person_id, event, detail, source) values (p_at, p_person_id, 'Accepted', 'gmail', 'hark');
  end if;
  -- caller pushes only when new_accept and not in --backfill
  return jsonb_build_object('fresh', true, 'new_accept', was is null, 'moved', was is distinct from now_at);
end $$;
revoke all on function public.ari_worker_accept_record(text, text, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ari_worker_accept_record(text, text, timestamptz, text) to ari_worker;

create or replace function public.ari_worker_gmail_known(p_ids text[]) returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(msg_id), '{}') from gmail_events where msg_id = any(p_ids) $$;
revoke all on function public.ari_worker_gmail_known(text[]) from public, anon, authenticated;
grant execute on function public.ari_worker_gmail_known(text[]) to ari_worker;

-- 5 ----------------------------------------------------------------------------------------------------------------------
create table if not exists public.scan_runs (
  id bigserial primary key,
  book text not null,
  trigger text not null default 'scheduled',
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  last_scan_at timestamptz,
  accounts_scanned_count int,
  error text,
  status text not null default 'running' check (status in ('running', 'ok', 'empty', 'error'))
);
create index if not exists scan_runs_book_started on public.scan_runs(book, started_at desc);
alter table public.scan_runs enable row level security;
drop policy if exists owner_read on public.scan_runs;
create policy owner_read on public.scan_runs for select to authenticated using (public.is_owner());
revoke all on public.scan_runs from anon, public;
revoke insert, update, delete, truncate on public.scan_runs from authenticated;
grant select on public.scan_runs to authenticated;

create or replace function public.ari_worker_scan_start(p_book text, p_trigger text) returns bigint
language sql security definer set search_path = public as $$
  insert into scan_runs(book, trigger) values (p_book, coalesce(p_trigger, 'scheduled')) returning id $$;
create or replace function public.ari_worker_scan_finish(p_id bigint, p_accounts int, p_last timestamptz, p_error text)
returns void language sql security definer set search_path = public as $$
  update scan_runs set finished_at = now(), accounts_scanned_count = p_accounts, last_scan_at = p_last, error = p_error,
    status = case when p_error is not null then 'error' when coalesce(p_accounts, 0) = 0 then 'empty' else 'ok' end
  where id = p_id $$;
revoke all on function public.ari_worker_scan_start(text, text) from public, anon, authenticated;
revoke all on function public.ari_worker_scan_finish(bigint, int, timestamptz, text) from public, anon, authenticated;
grant execute on function public.ari_worker_scan_start(text, text) to ari_worker;
grant execute on function public.ari_worker_scan_finish(bigint, int, timestamptz, text) to ari_worker;

-- alert: no scheduled start for 2 slots + 5 min (25 min = 2 x 600 s + 5 min), or the last 2 finished runs empty/error
create or replace function public.ari_scan_deadman() returns jsonb language sql stable security definer set search_path = public as $$
  with v as (select b.book,
      max(b.started_at) filter (where b.trigger = 'scheduled') < now() - interval '25 minutes' as missed,
      (select count(*) = 2 and bool_and(t.status in ('empty', 'error')) from (select r.status from scan_runs r
         where r.book = b.book and r.finished_at is not null order by r.started_at desc limit 2) t) as empty2
    from scan_runs b where b.started_at > now() - interval '7 days' group by b.book)
  select coalesce(jsonb_agg(to_jsonb(v)) filter (where v.missed or v.empty2), '[]'::jsonb) from v $$;
revoke all on function public.ari_scan_deadman() from public, anon, authenticated;

-- 0026 hooks: same bodies as 0026 plus 'deadman' (rollback restores the 0026 bodies)
create or replace function public.ari_health() returns jsonb language sql stable security definer set search_path = public as $$
  with hb as (select last_scan_at from scan_heartbeat where id = 1),
       br as (select finished_at, verified, offsite, error from backup_runs order by id desc limit 1),
       pf as (select count(*)::int n from notifications where sent_at is null and attempts >= 5 and created_at > now() - interval '24 hours')
  select jsonb_build_object(
    'scan_age_min', (select round(extract(epoch from now() - last_scan_at) / 60) from hb),
    'scan_stale', coalesce((select last_scan_at < now() - interval '40 minutes' from hb), true),
    'backup_ok', coalesce((select finished_at > now() - interval '26 hours' and verified and error is null from br), false),
    'backup_offsite', (select offsite from br),
    'push_failed_24h', (select n from pf),
    'deadman', public.ari_scan_deadman());
$$;
revoke all on function public.ari_health() from public, anon, authenticated;

create or replace function public.ari_health_alert() returns jsonb language plpgsql security definer set search_path = public as $$
declare h jsonb := public.ari_health(); slot text := to_char(date_trunc('hour', now()) - (extract(hour from now())::int % 12) * interval '1 hour', 'YYYYMMDDHH24');
begin
  if (h->>'scan_stale')::boolean then
    perform ari_notify('ops_alert', 'ops:scan:' || slot, 'Ari needs a look', 'Scans have paused. Your data may be out of date.', '/ops', null, null); end if;
  if not (h->>'backup_ok')::boolean then
    perform ari_notify('ops_alert', 'ops:backup:' || slot, 'Ari needs a look', 'Last night''s backup did not finish cleanly.', '/ops', null, null); end if;
  if coalesce((h->>'push_failed_24h')::int, 0) > 0 then
    perform ari_notify('ops_alert', 'ops:push:' || slot, 'Ari needs a look', 'Some alerts did not reach your phone.', '/ops', null, null); end if;
  if jsonb_array_length(coalesce(h->'deadman', '[]'::jsonb)) > 0 then
    perform ari_notify('ops_alert', 'ops:deadman:' || slot, 'Ari needs a look', 'A scheduled scan stopped running or keeps finding nothing.', '/ops', null, null); end if;
  return h;
end $$;
revoke all on function public.ari_health_alert() from public, anon, authenticated;
-- ari_worker_health() (0026) wraps ari_health(), so health_check.py sees 'deadman' with no further change.
-- 0018 worker allow-list: +4 functions (ari_worker_accept_record, ari_worker_gmail_known, ari_worker_scan_start, ari_worker_scan_finish).

insert into supabase_migrations.schema_migrations(version, name) values ('0032', 'accept_ingest') on conflict do nothing;
