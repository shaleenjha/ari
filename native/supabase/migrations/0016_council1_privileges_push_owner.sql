-- 0016 Council call #1 (Sat 17 Oct 2026, Forge). Applied staging first, then prod. Depends on 0014 (ari_pref) and 0015 (notifications_privacy).
-- Rollback SQL for each section: native/supabase/rollbacks/0016_*.sql
-- NOTE FOR EVERY LATER MIGRATION: after section A, new tables, sequences and functions in public are NOT granted to anon or
-- authenticated automatically, and new functions are not executable by PUBLIC. Grant explicitly, e.g.
--   grant select, insert, update, delete on public.new_table to authenticated;   (+ RLS policy using is_owner())
--   grant execute on function public.new_rpc(args) to authenticated;
-- service_role keeps its default grants.

-- A. Default privileges: stop handing anon/authenticated every new object (security F7, platform F7)
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;
-- (supabase_admin's default ACL in public cannot be changed by postgres: 42501. It only applies to objects supabase_admin creates.)

-- B. Stray table rights the app never uses (28 TRUNCATE grants on authenticated)
revoke truncate, references, trigger on all tables in schema public from anon, authenticated;

-- C. Functions: anon executes nothing in public except the allow-list. Owner/worker rights unchanged.
--    Allow-list: ari_push_ack(text,text) only, because the deployed sw.js calls it with the publishable key (no session)
--    to stamp push receipt. It is revoked in 0017 together with the sw.js change (call #2/#3 deploy).
do $$
declare r record; had_auth boolean; had_svc boolean;
begin
  for r in select p.oid, p.oid::regprocedure::text sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             left join pg_depend d on d.objid = p.oid and d.deptype = 'e'
            where n.nspname = 'public' and d.objid is null and p.prokind in ('f','p')
  loop
    had_auth := has_function_privilege('authenticated', r.oid, 'execute');
    had_svc  := has_function_privilege('service_role', r.oid, 'execute');
    if had_auth then execute format('grant execute on function %s to authenticated', r.sig); end if;
    if had_svc  then execute format('grant execute on function %s to service_role', r.sig); end if;
    execute format('revoke execute on function %s from public, anon', r.sig);
  end loop;
end $$;
grant execute on function public.ari_push_ack(text, text) to anon;  -- allow-listed until 0017

-- D. Push privacy for EVERY kind (replaces 0015's replied-only body). Names, companies and brief text never reach the
--    lock screen unless ari_prefs.push_show_names = true. Count-only digests and test pings pass through unchanged.
--    url keeps the person/account id so a tap still opens the right record.
create or replace function public.notifications_privacy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('test', 'digest') or coalesce(new.dedupe_key, '') like 'digest:%' then return new; end if;
  if coalesce((public.ari_pref('push_show_names', 'false'::jsonb) #>> '{}')::boolean, false) then return new; end if;
  case new.kind
    when 'replied' then new.title := 'New reply on LinkedIn'; new.body := 'Someone you messaged wrote back. Open Ari to answer.';
    when 'accepted' then new.title := 'New connection accepted'; new.body := 'Their DM1 draft is ready in Ari.';
    when 'meeting' then new.title := 'Meeting set'; new.body := 'Open Ari to see the details.';
    when 'research_done' then new.title := 'Brief ready'; new.body := 'A new account brief is waiting in Ari.';
    when 'draft_due' then
      new.title := case when new.dedupe_key like 'draft:dm1:%' then 'DM1 ready'
                        when new.dedupe_key like 'draft:dm2:%' then 'DM2 drafted'
                        when new.dedupe_key like 'draft:dm3:%' then 'DM3 drafted'
                        else 'Draft ready' end;
      new.body := 'Ready for your review in Ari.';
    else new.title := 'Ari update'; new.body := 'Open Ari to see what changed.';
  end case;
  return new;
end $$;
revoke all on function public.notifications_privacy() from public, anon, authenticated;

-- E. is_owner() pinned to the owner's auth user id (was: JWT email + user-writable user_metadata.email_verified, missing = true)
create or replace function public.is_owner() returns boolean
language sql stable as $$
  select coalesce(auth.uid() = 'b14d1605-c766-4684-9a5b-71ffcab6967b'::uuid, false)
$$;
