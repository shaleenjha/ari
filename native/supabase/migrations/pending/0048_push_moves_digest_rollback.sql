-- Rollback of 0048: the 21:00 IST digest goes back to the 0002 definition (byte for byte), the three helpers are dropped,
-- the ledger row is removed. Re-runnable. Function changes only (pg_proc); no data, cron or grant on a table changes.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create or replace function public.ari_due_digest() returns int language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Kolkata')::date; n1 int; n2 int; n3 int; total int;
begin
  select count(*) filter (where accepted is not null and dm1_sent is null),
         count(*) filter (where dm1_sent is not null and dm2_sent is null and dm2_due <= today),
         count(*) filter (where dm2_sent is not null and dm3_sent is null and dm3_due <= today)
    into n1, n2, n3
    from public.people
   where coalesce(review, 'lead') = 'lead' and deleted_at is null and skipped is null
     and replied is null and meeting is null and withdrawn is null
     and stage not in ('Hold', 'Founder') and (snooze_until is null or snooze_until <= today);
  total := n1 + n2 + n3;
  if total > 0 then
    perform public.ari_notify('draft_due', 'digest:' || today, total || ' follow-up' || case when total = 1 then '' else 's' end || ' due tonight',
      concat_ws(', ', case when n1 > 0 then n1 || ' DM1' end, case when n2 > 0 then n2 || ' DM2' end, case when n3 > 0 then n3 || ' DM3' end) || '. Ready when you are.',
      '/ops', null, null);
  end if;
  return total;
end $$;
revoke all on function public.ari_due_digest() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.ari_due_digest() to service_role; end if;
end $$;
drop function if exists public.ari_move_push_copy(jsonb);
drop function if exists public.ari_move_total(date);
drop function if exists public.ari_norm_co(text);
delete from supabase_migrations.schema_migrations where version = '0048';
commit;
