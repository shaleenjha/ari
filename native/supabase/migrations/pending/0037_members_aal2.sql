-- 0037 (S1 release 5, proposed by the auditor; number to be confirmed, see the note on Diamond's 0037).
-- Members need the two-step code too, exactly as the owner does since 0024.
-- Why: 0024 makes public.is_owner() require an aal2 session once the caller has a verified TOTP factor. 0035 ORs every owner
-- policy with app.is_member(workspace_id), which had no such check, so a Google-only (aal1) session of an enrolled member
-- passed RLS on all 42 tenant tables and app.*. Owner has no factor today, so nothing changes until a factor is enrolled.
-- Rule (same as 0024): aal2 is required only when the caller has a verified factor; an unverified (half-done) enrolment
-- does not lock anyone out.
-- app.aal_ok() is called only from inside the two SECURITY DEFINER helpers, so nobody else gets EXECUTE on it.
-- Test: pending/test/checks_after_0037.sql. Rollback: rollbacks/0037_rollback.sql (restores the 0035 bodies).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

create or replace function app.aal_ok() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified')
$$;
revoke all on function app.aal_ok() from public, anon, authenticated;

create or replace function app.is_member(ws uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select app.aal_ok() and exists (select 1 from app.memberships m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active')
$$;
create or replace function app.has_role(ws uuid, roles app.role_t[]) returns boolean language sql stable security definer set search_path = '' as $$
  select app.aal_ok() and exists (select 1 from app.memberships m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active' and m.role = any(roles))
$$;
revoke all on function app.is_member(uuid), app.has_role(uuid, app.role_t[]) from public, anon;
grant execute on function app.is_member(uuid), app.has_role(uuid, app.role_t[]) to authenticated;

do $$
begin
  if position('app.aal_ok()' in pg_get_functiondef('app.is_member(uuid)'::regprocedure)) = 0
     or position('app.aal_ok()' in pg_get_functiondef('app.has_role(uuid, app.role_t[])'::regprocedure)) = 0 then
    raise exception '0037: member helpers do not call app.aal_ok()';
  end if;
  if has_function_privilege('authenticated', 'app.aal_ok()', 'execute') or has_function_privilege('anon', 'app.aal_ok()', 'execute') then
    raise exception '0037: app.aal_ok() must not be callable directly';
  end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0037', 'members_aal2') on conflict do nothing;
commit;
