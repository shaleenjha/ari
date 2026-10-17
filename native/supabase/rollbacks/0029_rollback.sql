-- Rollback for 0029_data_hygiene. Restores the v18.7 hand-set flag by the same rule, then drops everything 0029 added.
-- Fixes already applied through hygiene_resolve (links, connect ticks, merges) are user actions and are NOT reverted here;
-- each one's before-values are in hygiene_findings.resolution.undo, so export them first if a revert is wanted:
--   \copy (select id, check_key, entity_id, resolution from public.hygiene_findings where status = 'fixed') to 'hygiene_fixed.csv' csv header
update public.people set flags = array_append(flags, 'no_connect_tick')
 where deleted_at is null and accepted is not null and connect_sent is null and not ('no_connect_tick' = any(flags));
drop function if exists public.hygiene_resolve(uuid, text, jsonb);
drop function if exists public.hygiene_open();
drop function if exists public.ari_worker_hygiene();
drop function if exists public.ari_hygiene_scan();
drop view if exists public.hygiene_v_dm1_past_due, public.hygiene_v_stale_stage, public.hygiene_v_no_account_link,
                    public.hygiene_v_duplicate_account, public.hygiene_v_accept_no_connect;
drop function if exists public.ari_domain_norm(text);
drop function if exists public.ari_company_norm(text);
drop table if exists public.hygiene_findings;
delete from public.app_config where key = 'hygiene_last_scan';
delete from supabase_migrations.schema_migrations where version = '0029';
