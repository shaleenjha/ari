-- Rollback of 0049 (live Ask Kyte chat). Re-runnable. Order: stop the prune cron, drop the three functions, drop ai_chat, take
-- 'chat' back out of ai_calls_task_check, remove the ledger row.
-- ai_chat holds up to 30 days of Owner's chat: the drop refuses while it has rows unless the session sets
--   set ari.allow_drop_chat = 'yes';
-- ai_calls rows with task 'chat' are the spend ledger and STAY. If any exist, the restored check is added NOT VALID: it holds for
-- every new row, the old 'chat' rows are kept as they are.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ declare has_rows boolean := false; begin
  if to_regclass('public.ai_chat') is not null then execute 'select exists (select 1 from public.ai_chat)' into has_rows; end if;
  if has_rows and coalesce(current_setting('ari.allow_drop_chat', true), '') <> 'yes' then
    raise exception '0049 rollback: ai_chat has rows; set ari.allow_drop_chat = ''yes'' to drop them';
  end if;
end $$;
select cron.unschedule('ari-ai-chat-prune') where exists (select 1 from cron.job where jobname = 'ari-ai-chat-prune');
drop function if exists public.ari_ai_chat_context(text, text, uuid);
drop function if exists public.ari_ai_chat_finish(bigint, text, text, bigint, int, int);
drop function if exists public.ari_ai_chat_begin(text);
drop table if exists public.ai_chat;
do $$
declare def text; vals text[];
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = 'public.ai_calls'::regclass and conname = 'ai_calls_task_check';
  if def is not null and def ~ '''chat''' then
    select array_agg(m[1] order by ord) into vals from regexp_matches(def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord) where m[1] <> 'chat';
    execute 'alter table public.ai_calls drop constraint ai_calls_task_check';
    if exists (select 1 from public.ai_calls where task = 'chat') then
      execute format('alter table public.ai_calls add constraint ai_calls_task_check check (task in (%s)) not valid', (select string_agg(quote_literal(v), ', ') from unnest(vals) v));
    else
      execute format('alter table public.ai_calls add constraint ai_calls_task_check check (task in (%s))', (select string_agg(quote_literal(v), ', ') from unnest(vals) v));
    end if;
  end if;
end $$;
delete from supabase_migrations.schema_migrations where version = '0049';
commit;
