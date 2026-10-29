-- Rollback of 0051 (drafting in Ask Kyte): drops the prune cron, the four functions, the drafts table and the ledger row.
-- Refuses while ai_chat_drafts has rows unless `set ari.allow_drop_chat_drafts = 'yes'` (the chat drafts are kept by default).
-- Re-runnable. Saved drafts already on people stay as they are (they are Owner's drafts now); app_config 'ask_draft' is left alone.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare n bigint := 0;
begin
  if to_regclass('public.ai_chat_drafts') is not null then execute 'select count(*) from public.ai_chat_drafts' into n; end if;
  if n > 0 and coalesce(current_setting('ari.allow_drop_chat_drafts', true), '') <> 'yes' then
    raise exception 'ai_chat_drafts has rows: set ari.allow_drop_chat_drafts = ''yes'' to drop them';
  end if;
end $$;
select cron.unschedule('ari-ai-chat-draft-prune') where exists (select 1 from cron.job where jobname = 'ari-ai-chat-draft-prune');
drop function if exists public.ari_ai_chat_draft_save(uuid, boolean, boolean);
drop function if exists public.ari_ai_chat_draft_put(bigint, text, text, bigint, text, jsonb, text);
drop function if exists public.ari_ai_chat_draft_target(text, text, text);
drop function if exists public.ari_ai_chat_draft_on();
drop table if exists public.ai_chat_drafts;
delete from supabase_migrations.schema_migrations where version = '0051';
commit;
