-- 0017 (PENDING, not applied anywhere). Ship in the same release as the sw.js change (Council call #2/#3 deploy).
-- Today the deployed service worker (web/sw.js, ack()) calls rpc/ari_push_ack with only the publishable key, so anon needs EXECUTE.
-- It is SECURITY DEFINER and only stamps push_subscriptions.last_rx_at/last_rx_tag for a known endpoint URL (a capability secret),
-- so the exposure is low, but it is the last anon-callable function in public. Before applying: move the ack to the page
-- (postMessage from sw.js to an open client that calls the RPC with the user's session) or to an edge function that checks the endpoint.
-- Apply staging first, record in supabase_migrations.schema_migrations, then prod.
revoke execute on function public.ari_push_ack(text, text) from anon;
-- rollback: grant execute on function public.ari_push_ack(text, text) to anon;
