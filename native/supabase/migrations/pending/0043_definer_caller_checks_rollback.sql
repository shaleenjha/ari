-- Rollback of 0043 caller checks. Re-runnable. Restores the three functions exactly as they were on prod and staging before 0043
-- (bodies verbatim from pg_get_functiondef, Oct 24 2026: ari_pref md5 2b7c7474..., ari_push_ack md5 e19f2364...; saved in
-- work/security/prod-0042-0043/00_defs_prod.json) and the authenticated EXECUTE grant on ari_account_implied (ACL back to
-- {postgres, authenticated, service_role}). Re-opens the three gaps 0043 closed: use only if 0043 broke a live path.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
-- revoke then re-grant in the original order so the ACL text is byte-identical ({postgres, authenticated, service_role}).
revoke execute on function public.ari_account_implied(uuid) from authenticated, service_role;
grant execute on function public.ari_account_implied(uuid) to authenticated;
grant execute on function public.ari_account_implied(uuid) to service_role;

create or replace function public.ari_pref(p_key text, p_default jsonb default null::jsonb)
 returns jsonb
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select coalesce((select value from public.ari_prefs where key = p_key), p_default);
$function$;

create or replace function public.ari_push_ack(p_endpoint text, p_tag text default null::text)
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  update public.push_subscriptions set last_rx_at = now(), last_rx_tag = left(p_tag, 64)
   where endpoint = p_endpoint and revoked_at is null;
$function$;

delete from supabase_migrations.schema_migrations where version = '0043';
commit;
