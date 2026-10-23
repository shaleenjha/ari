-- Rollback of 0041 (Live AI layer). Re-runnable. Drops every object 0041 created; restores nothing else because 0041 changed
-- no existing function or policy. Data written by the layer into existing tables STAYS (people.dm / extra.ai, replies.drafts,
-- research rows, notifications): those are Owner's drafts and research now. replies.ai_triage is dropped (expand column).
-- Order: stop the crons first so nothing kicks a function mid-rollback.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
select cron.unschedule('ari-ai-events') where exists (select 1 from cron.job where jobname = 'ari-ai-events');
select cron.unschedule('ari-gmail-watch-renew') where exists (select 1 from cron.job where jobname = 'ari-gmail-watch-renew');
select cron.unschedule('ari-ai-prune') where exists (select 1 from cron.job where jobname = 'ari-ai-prune');
do $$ begin
  if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ai_jobs') then
    execute 'alter publication supabase_realtime drop table public.ai_jobs';
  end if;
end $$;
drop function if exists public.ari_ai_prune();
drop function if exists public.ari_gmail_watch_kick();
drop function if exists public.ari_ai_kick();
drop function if exists public.ari_gmail_watch_push(text);
drop function if exists public.ari_gmail_watch_set(text, bigint, text);
drop function if exists public.ari_gmail_push_config();
drop function if exists public.ari_ai_notify_dm_ready(text);
drop function if exists public.ari_ai_pending_events(int);
drop function if exists public.ari_ai_trigger_done(text, text, text, text);
drop function if exists public.ari_ai_trigger_claim(text, text);
drop function if exists public.ari_ai_job_update(uuid, jsonb, text, jsonb, text);
drop function if exists public.ari_ai_job_events(uuid, int);
drop function if exists public.ari_ai_job_event(uuid, jsonb);
drop function if exists public.ari_ai_job_claim(uuid);
drop function if exists public.ari_ai_job_enqueue(text, uuid, text, jsonb);
drop function if exists public.ari_ai_save_research(text, uuid, jsonb, jsonb);
drop function if exists public.ari_ai_save_reply_draft(bigint, text, text, text);
drop function if exists public.ari_ai_save_triage(bigint, jsonb, jsonb);
drop function if exists public.ari_ai_save_draft(text, text, text, jsonb, text, text);
drop function if exists public.ari_ai_reply_context(bigint);
drop function if exists public.ari_ai_context(text, uuid);
drop function if exists public.ari_ai_budget_headroom();
drop function if exists public.ari_ai_call_finish(bigint, text, int, int, numeric, text);
drop function if exists public.ari_ai_budget_reserve(text, text, text, numeric, text, uuid, uuid, text);
drop function if exists public.ari_ai_spend();
drop function if exists public.ari_ai_caller();
drop function if exists public.ari_ai_hook();
delete from vault.secrets where name = 'ari_ai_hook_secret';
drop table if exists public.gmail_watch;
drop table if exists public.ai_triggers;
drop table if exists public.ai_jobs;
drop table if exists public.ai_calls;
drop table if exists public.ai_budget;
alter table public.replies drop column if exists ai_triage;
delete from supabase_migrations.schema_migrations where version = '0041';
commit;
