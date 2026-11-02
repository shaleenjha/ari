-- 0017 (v18.4, Sat Oct 17 2026): the service worker no longer calls ari_push_ack with the publishable key (anon).
-- web/sw.js v18.4 stores the receipt in its own cache and the open page stamps it with the user's session (authenticated).
-- Last anon-callable function in public goes; authenticated keeps EXECUTE explicitly (default grants are revoked since 0016).
revoke execute on function public.ari_push_ack(text, text) from anon, public;
grant execute on function public.ari_push_ack(text, text) to authenticated, service_role;
-- rollback: native/supabase/rollbacks/0017_rollback.sql
