-- Ari v17 push wiring (Supabase-only: pg_net, pg_cron, vault). Needs 0002.
-- Secrets are NOT in this file. Create them once (values from Hark's vault), e.g.:
--   select vault.create_secret('<random>', 'ari_push_hook_secret');
--   select vault.create_secret('<VAPID private JWK json>', 'ari_vapid_private_jwk');
--   insert into public.app_config(key, value) values ('vapid_public_key', '<base64url P-256 public key>');
create extension if not exists pg_net;
create extension if not exists pg_cron;

-- config for the edge function (service_role only)
create or replace function public.ari_push_config() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'hook_secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ari_push_hook_secret'),
    'vapid_private_jwk', (select decrypted_secret from vault.decrypted_secrets where name = 'ari_vapid_private_jwk'),
    'vapid_public_key', (select value from public.app_config where key = 'vapid_public_key'),
    'subject', 'mailto:ops@example.com');
$$;
revoke all on function public.ari_push_config() from public, anon, authenticated;
grant execute on function public.ari_push_config() to service_role;

-- poke the edge function (async via pg_net; the request goes out after commit)
create or replace function public.ari_push_kick() returns bigint
language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://rbkrqlzlblquvgmuohro.supabase.co/functions/v1/ari-push',
    headers := jsonb_build_object('content-type', 'application/json',
                 'x-ari-hook', (select decrypted_secret from vault.decrypted_secrets where name = 'ari_push_hook_secret')),
    body := '{"source":"db"}'::jsonb,
    timeout_milliseconds := 15000);
$$;
revoke all on function public.ari_push_kick() from public, anon, authenticated;
grant execute on function public.ari_push_kick() to service_role;

create or replace function public.notifications_kick() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.ari_push_kick();
  return null;
end $$;
create trigger notifications_kick after insert on public.notifications for each statement execute function public.notifications_kick();

-- 21:00 IST (15:30 UTC) "N follow-ups due tonight"; every 5 min retry anything unsent
select cron.schedule('ari-due-digest', '30 15 * * *', $$select public.ari_due_digest()$$);
select cron.schedule('ari-push-retry', '*/5 * * * *',
  $$select public.ari_push_kick() where exists (select 1 from public.notifications where sent_at is null and attempts < 5)$$);
