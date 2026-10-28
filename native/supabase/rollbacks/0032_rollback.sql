-- Rollback for 0032_accept_ingest. Restores the 0026 ari_health()/ari_health_alert() bodies (no 'deadman'), drops the
-- accept-ingest and dead-man functions and tables, and people.accepted_source.
-- Kept on purpose: people.accepted / stage values and log_entries rows ('Accepted' | 'gmail') that ari_worker_accept_record
-- wrote are real accept data and stay. gmail_events (dedupe keys) and scan_runs (run history) are discarded.
create or replace function public.ari_health() returns jsonb language sql stable security definer set search_path = public as $$
  with hb as (select last_scan_at from scan_heartbeat where id = 1),
       br as (select finished_at, verified, offsite, error from backup_runs order by id desc limit 1),
       pf as (select count(*)::int n from notifications where sent_at is null and attempts >= 5 and created_at > now() - interval '24 hours')
  select jsonb_build_object(
    'scan_age_min', (select round(extract(epoch from now() - last_scan_at) / 60) from hb),
    'scan_stale', coalesce((select last_scan_at < now() - interval '40 minutes' from hb), true),
    'backup_ok', coalesce((select finished_at > now() - interval '26 hours' and verified and error is null from br), false),
    'backup_offsite', (select offsite from br),
    'push_failed_24h', (select n from pf));
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
  return h;
end $$;
revoke all on function public.ari_health_alert() from public, anon, authenticated;

drop function if exists public.ari_scan_deadman();
drop function if exists public.ari_worker_scan_finish(bigint, int, timestamptz, text);
drop function if exists public.ari_worker_scan_start(text, text);
drop function if exists public.ari_worker_gmail_known(text[]);
drop function if exists public.ari_worker_accept_record(text, text, timestamptz, text);
drop table if exists public.scan_runs, public.gmail_events;
alter table public.people drop constraint if exists people_accepted_source_check;
alter table public.people drop column if exists accepted_source;
delete from supabase_migrations.schema_migrations where version = '0032';
