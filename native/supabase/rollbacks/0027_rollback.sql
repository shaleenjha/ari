drop function if exists public.ari_worker_metrics();
drop function if exists public.usage_ping(date, int, int);
drop table if exists public.app_usage;
delete from supabase_migrations.schema_migrations where version = '0027';
