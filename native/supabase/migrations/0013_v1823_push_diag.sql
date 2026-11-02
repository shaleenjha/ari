-- 0013 (v18.2.3): push diagnostics. Oct 16: Apple accepted the 20:19 IST accept push for the iPhone (2xx, last_ok_at set)
-- but the iPhone showed nothing. Until now the backend could not tell "Apple accepted" from "the phone showed it",
-- nor whether the iPhone row is the endpoint the iPhone app holds today.
--  last_seen_at  : bumped by register_push2 on every app open (the app re-registers its current subscription)
--  last_rx_at/tag: the service worker acks every push it shows (ari_push_ack, keyed by the endpoint itself)
--  ari_test_ping : owner (app Settings) or service role (SQL) queues a real test push through Apple/Google

alter table public.push_subscriptions add column if not exists last_seen_at timestamptz;
alter table public.push_subscriptions add column if not exists last_rx_at timestamptz;
alter table public.push_subscriptions add column if not exists last_rx_tag text;

create or replace function public.register_push2(p_endpoint text, p_p256dh text, p_auth text, p_platform text default null, p_device text default null, p_user_agent text default null, p_browser text default null, p_standalone boolean default null, p_install_id text default null, p_explicit boolean default false)
 returns uuid language plpgsql set search_path to 'public' as $function$
declare rid uuid;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  insert into public.push_subscriptions(endpoint, p256dh, auth, platform, device, user_agent, browser, standalone, install_id, active, last_seen_at)
  values (p_endpoint, p_p256dh, p_auth, p_platform, p_device, p_user_agent, p_browser, p_standalone, p_install_id, true, now())
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
     platform = coalesce(excluded.platform, push_subscriptions.platform),
     device = coalesce(excluded.device, push_subscriptions.device),
     user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
     browser = coalesce(excluded.browser, push_subscriptions.browser),
     standalone = coalesce(excluded.standalone, push_subscriptions.standalone),
     install_id = coalesce(excluded.install_id, push_subscriptions.install_id),
     failures = 0, last_error = null, last_seen_at = now(),
     revoked_at = case when p_explicit or push_subscriptions.paused_reason is null then null else push_subscriptions.revoked_at end,
     active = case when p_explicit or push_subscriptions.paused_reason is null then true else push_subscriptions.active end,
     paused_reason = case when p_explicit then null else push_subscriptions.paused_reason end
  returning id into rid;
  if p_install_id is not null then
    update public.push_subscriptions set revoked_at = now(), active = false, paused_reason = 'replaced by a newer subscription'
     where id <> rid and install_id = p_install_id and revoked_at is null;
  end if;
  if coalesce(p_standalone, false) then
    update public.push_subscriptions set active = false, paused_reason = 'superseded by the installed Ari app'
     where id <> rid and revoked_at is null and active and coalesce(standalone, false) = false
       and coalesce(platform, '') = coalesce(p_platform, '');
  end if;
  return rid;
end $function$;

-- Called by sw.js (no session there) right after it shows a push. Only someone holding the endpoint URL (the push
-- service capability itself) can stamp it, and all it does is set two receipt columns.
create or replace function public.ari_push_ack(p_endpoint text, p_tag text default null)
 returns void language sql security definer set search_path to 'public' as $$
  update public.push_subscriptions set last_rx_at = now(), last_rx_tag = left(p_tag, 64)
   where endpoint = p_endpoint and revoked_at is null;
$$;
revoke all on function public.ari_push_ack(text, text) from public;
grant execute on function public.ari_push_ack(text, text) to anon, authenticated;

-- (session_user, not current_user: inside security definer current_user is always the owner)
-- A real test push to every active device (through web.push.apple.com / FCM / Expo).
-- App: Settings > Send a test ping. SQL (service role / dashboard): select public.ari_test_ping('from SQL');
create or replace function public.ari_test_ping(p_note text default null)
 returns bigint language plpgsql security definer set search_path to 'public' as $$
declare nid bigint; t text := to_char(now() at time zone 'Asia/Kolkata', 'HH24:MI:SS');
begin
  if not (public.is_owner() or coalesce(auth.role(), '') = 'service_role' or session_user::text in ('postgres', 'supabase_admin')) then
    raise exception 'not allowed'; end if;
  insert into public.notifications(kind, dedupe_key, title, body, url)
  values ('test', 'test:' || extract(epoch from clock_timestamp())::text, 'Ari test ping',
          'Sent ' || t || coalesce(' · ' || nullif(left(p_note, 60), ''), '') || '. If you can read this, pings work on this device.', '/ops')
  returning id into nid;
  return nid;
end $$;
revoke all on function public.ari_test_ping(text) from public, anon;
grant execute on function public.ari_test_ping(text) to authenticated, service_role;

drop function if exists public.push_devices();
create function public.push_devices()
 returns table(id uuid, kind text, platform text, device text, browser text, standalone boolean, active boolean, paused_reason text,
               created_at timestamptz, last_ok_at timestamptz, last_error text, endpoint_tail text, last_seen_at timestamptz, last_rx_at timestamptz)
 language sql stable set search_path to 'public' as $$
  select id, 'web', platform, device, browser, standalone, active, paused_reason, created_at, last_ok_at, last_error, right(endpoint, 16), last_seen_at, last_rx_at
    from public.push_subscriptions where revoked_at is null and public.is_owner()
  union all
  select id, 'app', platform, device, 'ari-app', true, active, null, created_at, last_ok_at, last_error, right(token, 12), null::timestamptz, null::timestamptz
    from public.push_tokens where revoked_at is null and public.is_owner()
  order by created_at desc;
$$;
revoke all on function public.push_devices() from public, anon;
grant execute on function public.push_devices() to authenticated, service_role;
