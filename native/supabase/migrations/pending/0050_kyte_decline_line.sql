-- 0050 Kyte decline line (Owner Oct 30 2026, option A: "remove the old decline line everywhere live"). WRITTEN, NOT APPLIED ANYWHERE.
-- Rule (Owner Oct 30): Kyte never names Ari, Den, Hark, Kelvarrow or any system or vendor; the decline is exactly
-- "I can't help with that here."
-- 0019 (live on prod since Oct 17) closes app-change Queue rows at write time with the result "That's handled in Hark, not here.",
-- which the app shows in the chat thread. This migration changes ONLY that string in public.queue_block_app_change().
-- Same signature, same match, same status change, same security definer + search_path, same grants; the trigger from 0019 is
-- untouched (create or replace keeps it bound). No table, data, policy, cron or trigger change. Rows already closed keep their
-- stored text (the web app's display map shows the old line as the new one since v18.14.10).
-- Ships with 0049 (needs a short-lived PAT from Owner). Re-runnable; the ledger row is written last.
-- Rollback: 0050_kyte_decline_line_rollback.sql (restores the 0019 body byte for byte). Checks: test/checks_after_0050.sql.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regprocedure('public.queue_block_app_change()') is null then
    raise exception '0050 needs 0019 (public.queue_block_app_change) first';
  end if;
end $$;
create or replace function public.queue_block_app_change() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.action ~* '^\s*(app\s*change|app\s*fix|feature\s*request|change\s*the\s*app)' and coalesce(new.status, 'queued') in ('queued', 'working', '') then
    new.status := 'done';
    new.result := 'I can''t help with that here.';
  end if;
  return new;
end $$;
revoke all on function public.queue_block_app_change() from public, anon, authenticated;
grant execute on function public.queue_block_app_change() to service_role;
insert into supabase_migrations.schema_migrations(version, name) values ('0050', 'kyte_decline_line') on conflict do nothing;
commit;
