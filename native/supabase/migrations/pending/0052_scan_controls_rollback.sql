-- Rollback of 0052 scan controls: drops the owner and worker RPCs, the helpers and both tables, and removes the ledger row.
-- Re-runnable. Data loss is limited to Owner's scan settings and the run history this migration created (no other table is touched).
-- After a rollback scripts/scan_gate.py sees the functions missing and answers RUN, so the scans behave as before 0052.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop function if exists public.kyte_worker_scan_finish(bigint, text, int, text);
drop function if exists public.kyte_worker_scan_start(text, text);
drop function if exists public.kyte_worker_scan_check(text);
drop function if exists public.kyte_scan_resume(text);
drop function if exists public.kyte_scan_request(text, boolean);
drop function if exists public.kyte_scan_settings_set(text, boolean, text, text[], time, time);
drop function if exists public.kyte_scan_settings_get();
drop function if exists public.kyte_scan_view(text);
drop function if exists public.kyte_scan_decide(text, timestamptz);
drop function if exists public.kyte_scan_daymin(time);
drop function if exists public.kyte_scan_caps(text);
drop table if exists public.scan_control_runs;
drop table if exists public.scan_settings;
delete from supabase_migrations.schema_migrations where version = '0052';
commit;
