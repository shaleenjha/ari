-- 0024 (v18.6, Sat Oct 17 2026): two-step sign-in, server side (scoreboard #4).
-- is_owner() (used by every RLS policy) now also requires an aal2 session once the owner has a verified TOTP factor.
-- Until Owner enrols a factor in the app (Settings > Two-step sign-in) nothing changes: 0 verified factors = aal1 passes.
-- After enrolment, a Google-only (aal1) session sees nothing until the 6-digit code is entered (the app asks for it).
-- Lock-out recovery (maintenance session): delete from auth.mfa_factors where user_id = '<owner uid>'; or roll back.
create or replace function public.is_owner() returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(
    auth.uid() = 'b14d1605-c766-4684-9a5b-71ffcab6967b'::uuid
    and (coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
         or not exists (select 1 from auth.mfa_factors f
                        where f.user_id = 'b14d1605-c766-4684-9a5b-71ffcab6967b'::uuid and f.status = 'verified')),
    false)
$$;
revoke all on function public.is_owner() from public, anon;
grant execute on function public.is_owner() to authenticated, service_role;
-- rollback: native/supabase/rollbacks/0024_rollback.sql
