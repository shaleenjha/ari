-- 0026 (v18.7, PENDING maintenance session): health + alerts inside Supabase, no Hark run needed.
-- Every 15 min pg_cron runs ari_health_alert(): if the scan heartbeat is stale (> 40 min), the newest nightly backup
-- failed / is older than 26 h, or a push has failed 5 times in the last 24 h, ONE push 'ops_alert' goes to Owner
-- (generic lock-screen text, at most one per problem per 12 h via dedupe_key). ari_worker_health() lets Hark's
-- scripts/health_check.py read the same verdict (metadata only).
-- Note: if push itself is what is failing, the push may not arrive; health_check.py (task 56e17ef1) then posts in Hark chat.
do $$ declare d text; begin
  select pg_get_constraintdef(oid) into d from pg_constraint where conname = 'notifications_kind_check';
  if d is not null and position('ops_alert' in d) = 0 then
    execute 'alter table public.notifications drop constraint notifications_kind_check';
    execute 'alter table public.notifications add constraint notifications_kind_check ' || replace(d, '''test''', '''test'',''ops_alert''');
  end if;
end $$;
update public.push_subscriptions set kinds = kinds || '{ops_alert}'::text[] where kinds is not null and not ('ops_alert' = any(kinds));
alter table public.push_subscriptions alter column kinds set default '{accepted,replied,meeting,research_done,draft_due,digest,test,ops_alert}'::text[];

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

create or replace function public.ari_worker_health() returns jsonb language sql stable security definer set search_path = public as $$
  select public.ari_health();
$$;
revoke all on function public.ari_worker_health() from public, anon, authenticated;
grant execute on function public.ari_worker_health() to ari_worker;

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
select cron.unschedule('ari-health-alert') where exists (select 1 from cron.job where jobname = 'ari-health-alert');
select cron.schedule('ari-health-alert', '*/15 * * * *', $c$select public.ari_health_alert()$c$);
-- add to the 0018 worker allow-list check if one exists (scripts list 29 functions -> 30)
insert into supabase_migrations.schema_migrations(version, name) values ('0026', 'health_alerts') on conflict do nothing;
