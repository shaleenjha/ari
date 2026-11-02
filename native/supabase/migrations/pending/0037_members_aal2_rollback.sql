-- Rollback of 0037 (members_aal2): the 0035 bodies of app.is_member / app.has_role, then drop app.aal_ok().
-- Re-runnable. Do not roll back while a factor is enrolled: it reopens the aal1 member path (Basalt H1).
begin;
set local lock_timeout = '5s';
create or replace function app.is_member(ws uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.memberships m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active')
$$;
create or replace function app.has_role(ws uuid, roles app.role_t[]) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.memberships m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active' and m.role = any(roles))
$$;
revoke all on function app.is_member(uuid), app.has_role(uuid, app.role_t[]) from public, anon;
grant execute on function app.is_member(uuid), app.has_role(uuid, app.role_t[]) to authenticated;
drop function if exists app.aal_ok();
delete from supabase_migrations.schema_migrations where version = '0037';
commit;
