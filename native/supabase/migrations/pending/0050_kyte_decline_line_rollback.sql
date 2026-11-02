-- Rollback of 0050: public.queue_block_app_change() goes back to the 0019 definition (byte for byte, old line
-- "That's handled in Hark, not here."), the ledger row is removed. Re-runnable. Function body only; trigger, grants, data unchanged.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create or replace function public.queue_block_app_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.action ~* '^\s*(app\s*change|app\s*fix|feature\s*request|change\s*the\s*app)' and coalesce(new.status, 'queued') in ('queued', 'working', '') then
    new.status := 'done';
    new.result := 'That''s handled in Hark, not here.';
  end if;
  return new;
end $$;
revoke all on function public.queue_block_app_change() from public, anon, authenticated;
grant execute on function public.queue_block_app_change() to service_role;
delete from supabase_migrations.schema_migrations where version = '0050';
commit;
