-- After 0038_rollback: the pre-0038 behaviour is back (local / CI only; one transaction, rolled back).
\set ON_ERROR_STOP on
begin;
create function pg_temp.claims(uid uuid, aal text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', uid, 'aal', aal)::text, true),
         set_config('request.jwt.claim.sub', uid::text, true)
$$;
grant execute on function pg_temp.claims(uuid, text) to authenticated;
insert into public.people(id, name, company, stage) values ('PR0038', 'Rollback Person 0038', 'Rollback Co', 'Connect queued') on conflict do nothing;
do $$ begin
  if not has_table_privilege('authenticated', 'public.people', 'DELETE') then raise exception 'FAIL rollback: DELETE not restored'; end if;
  if to_regprocedure('public.ari_worker_log_repair(text,text,jsonb,jsonb)') is null then raise exception 'FAIL rollback: repair not restored'; end if;
  if not has_function_privilege('ari_worker', 'public.ari_worker_log_repair(text,text,jsonb,jsonb)', 'execute') then raise exception 'FAIL rollback: repair grant'; end if;
  if (select confdeltype from pg_constraint where conname = 'replies_person_id_fkey' and conrelid = 'public.replies'::regclass) <> 'a' then raise exception 'FAIL rollback: FK not NO ACTION'; end if;
  if exists (select 1 from cron.job where jobname = 'ari-gmail-shadow-purge') or to_regprocedure('public.ari_gmail_shadow_purge()') is not null then raise exception 'FAIL rollback: purge left'; end if;
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0038') then raise exception 'FAIL rollback: 0038 ledger row left'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0036') then raise exception 'FAIL rollback: 0036 row removed'; end if;
  if (select count(*) from cron.job where jobname in ('ari-session-expiry', 'ari-weekly-digest')) <> 2 then raise exception 'FAIL rollback: recorded cron jobs removed'; end if;
end $$;
set local role authenticated;
select pg_temp.claims('b14d1605-c766-4684-9a5b-71ffcab6967b', 'aal1');
select public.apply_op('chkrb-1', 'mark', 'people', 'PR0038', '{"field":"connect_sent"}'::jsonb) is not null;
reset role;
do $$ begin
  if not exists (select 1 from public.log_entries where person_id = 'PR0038' and detail like 'Rollback Person 0038 · %') then raise exception 'FAIL rollback: apply_op is not the 0005 body'; end if;
  raise notice 'ALL 0038 ROLLBACK CHECKS PASSED';
end $$;
rollback;
-- Final row: the Management API returns only the last statement's result, so success = HTTP 201 + this row.
select 'ALL 0038 ROLLBACK CHECKS PASSED' as result;
