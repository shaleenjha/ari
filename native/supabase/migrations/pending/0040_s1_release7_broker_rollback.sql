-- Rollback of 0040 (S1 release 7 broker guardrails). Re-runnable. Run only AFTER the broker is undeployed or disabled
-- (ARI_BROKER_DISABLED=1), or its gate calls fail closed (the worker then cannot get new tokens; that is the intent).
-- Does not touch the worker Auth user (Auth admin API, runbook undo) or ari_worker's grants (0018).
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from cron.job where jobname = 'ari-broker-mints-prune') then perform cron.unschedule('ari-broker-mints-prune'); end if;
end $$;
drop function if exists public.ari_broker_note(text, text, text);
drop function if exists public.ari_broker_gate(text);
drop function if exists public.ari_broker_in_window(timestamptz, jsonb);
drop table if exists public.ari_broker_mints;
drop table if exists public.ari_broker_state;
delete from supabase_migrations.schema_migrations where version = '0040';
commit;
