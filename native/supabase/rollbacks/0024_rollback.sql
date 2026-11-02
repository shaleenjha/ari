-- Rollback for 0024: is_owner() back to the 0016E definition (uid pin only, invoker) with the same grants.
create or replace function public.is_owner() returns boolean language sql stable security invoker as $$
  select coalesce(auth.uid() = 'b14d1605-c766-4684-9a5b-71ffcab6967b'::uuid, false)
$$;
alter function public.is_owner() reset all;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;
delete from supabase_migrations.schema_migrations where version = '0024';
