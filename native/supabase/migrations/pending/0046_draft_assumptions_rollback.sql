-- Rollback for 0046 draft assumptions (Oct 28 2026). Re-runnable.
-- Drops queue.assumptions (its constraint and column grants go with it) and the ledger row. The 'AS:<pid>:<kind>' queue
-- rows exist only to hold that column, so they are deleted too. Once Owner has confirmed or struck items they are his
-- decisions: this file REFUSES while any AS row carries a non-open item unless the session sets
--   set ari.allow_drop_assumptions = 'yes';
-- first (take a verified backup before that). Policies are not touched (0046 never changed them).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'queue' and column_name = 'assumptions') then
    if exists (select 1 from public.queue q, jsonb_array_elements(q.assumptions) e where coalesce(e ->> 'status', 'open') <> 'open')
       and coalesce(current_setting('ari.allow_drop_assumptions', true), '') <> 'yes' then
      raise exception '0046 rollback: Owner has confirmed or struck items; set ari.allow_drop_assumptions = ''yes'' after a verified backup';
    end if;
  end if;
end $$;
delete from public.queue where id like 'AS:%' and action = 'Draft assumptions';
alter table public.queue drop constraint if exists queue_assumptions_shape;
alter table public.queue drop column if exists assumptions;
delete from supabase_migrations.schema_migrations where version = '0046';
commit;
