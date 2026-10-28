-- 0019 (v18.5, Sat Oct 17 2026): the in-app chat never makes or accepts changes to the app itself (Owner's standing rule).
-- App changes happen only through the Hark app. Any Queue row whose action is an app-change request (from the app, the
-- Sheet sync or anyone else) is closed at write time with a short reply, so the worker never sees it as "queued".
-- Rollback: rollbacks/0019_rollback.sql
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
drop trigger if exists queue_block_app_change on public.queue;
create trigger queue_block_app_change before insert or update of action, status on public.queue
  for each row execute function public.queue_block_app_change();
