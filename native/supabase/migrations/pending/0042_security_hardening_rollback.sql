-- Rollback of 0042 security hardening. Re-runnable (if exists everywhere).
-- Part 2 (row-drop alert) is removed: cron job 'ari-rowcount-daily', ari_rowcount_snapshot(), ops_row_counts (its stored
-- daily counts go with it; they are metadata only, re-seeded by a re-apply). Push rows the job already sent stay in notifications.
-- Part 1 (default lock) is deliberately NOT reopened. Before 0042, postgres' default privileges in public already excluded
-- anon/authenticated (0016) and schema app had no default ACL of its own, so the pre-0042 state is the same closed state.
-- Granting anon here would open every future table to the public key, which is the risk 0042 exists to prevent.
-- To restore 0016's exact entries anyway, nothing is needed: 0042 only re-ran the same revokes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select cron.unschedule('ari-rowcount-daily') where exists (select 1 from cron.job where jobname = 'ari-rowcount-daily');
drop function if exists public.ari_rowcount_snapshot();
drop table if exists public.ops_row_counts;
delete from supabase_migrations.schema_migrations where version = '0042';
commit;
