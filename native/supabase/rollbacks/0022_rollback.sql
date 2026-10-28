-- Rollback for 0022_backup_inside_supabase.sql. Keeps the stored backup objects (delete the bucket by hand only if wanted).
select cron.unschedule('ari-nightly-backup') where exists (select 1 from cron.job where jobname = 'ari-nightly-backup');
drop function if exists public.ari_worker_backup_status();
drop function if exists public.ari_backup_kick();
drop table if exists public.backup_runs;
delete from vault.secrets where name = 'ari_backup_hook_secret';
delete from supabase_migrations.schema_migrations where version = '0022';
-- edge function: Management API DELETE /v1/projects/<ref>/functions/ari-backup ; old nightly path: scripts/db_backup.py (needs the PAT)
