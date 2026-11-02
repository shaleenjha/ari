-- rollback 0028_event_times (times stay as they are; only the flag, trigger and report function go)
drop trigger if exists people_ts_approx on public.people;
drop function if exists public.people_ts_approx();
drop function if exists public.report_accept_dm1(text);
drop function if exists public.ari_worker_accept_dm1();
drop function if exists public.accept_dm1_stats(text);
revoke select (ts_approx) on public.people from ari_worker;
alter table public.people drop column if exists ts_approx;
delete from supabase_migrations.schema_migrations where version = '0028';
