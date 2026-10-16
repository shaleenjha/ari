select cron.unschedule('ari-health-alert') where exists (select 1 from cron.job where jobname = 'ari-health-alert');
drop function if exists public.ari_health_alert();
drop function if exists public.ari_worker_health();
drop function if exists public.ari_health();
delete from public.notifications where kind = 'ops_alert';
update public.push_subscriptions set kinds = array_remove(kinds, 'ops_alert') where kinds is not null;
alter table public.push_subscriptions alter column kinds set default '{accepted,replied,meeting,research_done,draft_due,digest,test}'::text[];
do $$ declare d text; begin
  select pg_get_constraintdef(oid) into d from pg_constraint where conname = 'notifications_kind_check';
  if d is not null and position('ops_alert' in d) > 0 then
    execute 'alter table public.notifications drop constraint notifications_kind_check';
    execute 'alter table public.notifications add constraint notifications_kind_check ' || replace(d, ',''ops_alert''', '');
  end if;
end $$;
delete from supabase_migrations.schema_migrations where version = '0026';
