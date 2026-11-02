-- rollback 0015
drop trigger if exists notifications_privacy on public.notifications;
drop function if exists public.notifications_privacy();
delete from supabase_migrations.schema_migrations where version='0015';
