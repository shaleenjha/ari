-- 0043 caller checks on the last three SECURITY DEFINER functions any signed-in user could call (Oct 24 2026; Owner "B" 11:45 IST).
-- Found by work/security/inventory-2026-10-24.md (and the outside audits, L1): every other authenticated-callable definer function
-- already checks the caller. Signatures, return types, volatility, owner and search_path stay identical, so every caller keeps working.
-- LIVE on staging (Oct 24 2026 ~11:50 IST: applied, checks passed, rolled back twice, re-applied, passed) and PROD (Oct 24 2026 ~11:54 IST).
-- Rollback: 0043_definer_caller_checks_rollback.sql (restores the three bodies verbatim and the authenticated grant). Checks: test/checks_after_0043.sql.
--
-- Callers found before writing this (Oct 24 2026, prod and staging bodies identical, md5 in work/security/prod-0042-0043/00_defs_*.json):
--   ari_account_implied(uuid): no app caller. web/ops.html, app/, scripts/, edge functions and cron never call it. Only the
--     SECURITY DEFINER functions ari_account_stage_backfill() and ari_account_stage_reconcile() call it, and they run as postgres.
--     So: revoke execute from authenticated (the house rule for a function with no app caller). Body unchanged.
--   ari_pref(text,jsonb): web/ops.html does not call it directly, but it calls ari_today_top (SECURITY INVOKER), and ari_today15 /
--     ari_today15_meta (invoker) read it too, so authenticated must keep EXECUTE. The trigger notifications_privacy() (definer) reads
--     it when the worker, cron or the owner inserts a notification. Fix: the same filter the ari_prefs RLS policy uses
--     (is_owner() OR app.is_member(workspace_id)), applied only when the request is a signed-in (or anon) API call. A signed-in
--     stranger now gets the caller's default (p_default), never a stored setting, and never an error (same shape as hygiene_open,
--     which filters rather than raises), so Today's 15 and the push trigger behave exactly as before for the owner, worker and cron.
--   ari_push_ack(text,text): web/ops.html (live) calls it as the signed-in owner to stamp the push receipt the service worker cached.
--     Fix: only stamp a subscription the caller may see under the push_subscriptions RLS policy (is_owner() OR
--     app.is_member(workspace_id)). push_subscriptions has no user column; the workspace is the ownership key, as in its policy.
--     A stranger's call updates 0 rows and returns normally (void), so the app's error path is unchanged.
--   "Signed-in (or anon) API call" = auth.role() is 'authenticated' or 'anon' (PostgREST request claims). Worker (ari_worker),
--   service_role, cron and postgres have other or no claims and pass unchanged.
-- Lock profile: create or replace function / revoke touch pg_proc only (no table locks). CREATE OR REPLACE keeps owner and ACL.
-- Re-runnable; the ledger row is written last.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regprocedure('public.is_owner()') is null or to_regprocedure('app.is_member(uuid)') is null
     or to_regprocedure('public.ari_account_implied(uuid)') is null or to_regprocedure('public.ari_pref(text,jsonb)') is null
     or to_regprocedure('public.ari_push_ack(text,text)') is null then
    raise exception '0043 needs is_owner(), app.is_member(uuid) (0035) and the three functions';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ari_prefs' and column_name = 'workspace_id')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'push_subscriptions' and column_name = 'workspace_id') then
    raise exception '0043 needs workspace_id on ari_prefs and push_subscriptions (0033)';
  end if;
end $$;

-- 1. ari_account_implied: no app caller -> authenticated loses EXECUTE (postgres and service_role keep it).
revoke execute on function public.ari_account_implied(uuid) from authenticated, anon, public;

-- 2. ari_pref: stored value only for owner / member / non-API callers; otherwise the caller's default.
create or replace function public.ari_pref(p_key text, p_default jsonb default null::jsonb)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce((select p.value from public.ari_prefs p
                    where p.key = p_key
                      and (coalesce(auth.role(), '') not in ('authenticated', 'anon')
                           or public.is_owner() or app.is_member(p.workspace_id))), p_default);
$function$;

-- 3. ari_push_ack: stamp only a subscription the caller may see (owner or workspace member), or any for non-API callers.
create or replace function public.ari_push_ack(p_endpoint text, p_tag text default null::text)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  update public.push_subscriptions set last_rx_at = now(), last_rx_tag = left(p_tag, 64)
   where endpoint = p_endpoint and revoked_at is null
     and (coalesce(auth.role(), '') not in ('authenticated', 'anon')
          or public.is_owner() or app.is_member(workspace_id));
$function$;
commit;

-- Ledger, after the end state is checked.
begin;
set local lock_timeout = '5s';
do $$ begin
  if has_function_privilege('authenticated', 'public.ari_account_implied(uuid)', 'execute') then
    raise exception '0043: ari_account_implied still callable by authenticated'; end if;
  if position('is_owner()' in pg_get_functiondef('public.ari_pref(text,jsonb)'::regprocedure)) = 0
     or position('is_owner()' in pg_get_functiondef('public.ari_push_ack(text,text)'::regprocedure)) = 0 then
    raise exception '0043: caller check missing from ari_pref / ari_push_ack'; end if;
  if not has_function_privilege('authenticated', 'public.ari_pref(text,jsonb)', 'execute')
     or not has_function_privilege('authenticated', 'public.ari_push_ack(text,text)', 'execute') then
    raise exception '0043: authenticated lost EXECUTE on ari_pref / ari_push_ack (the live app needs it)'; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0043', 'definer_caller_checks') on conflict do nothing;
commit;
