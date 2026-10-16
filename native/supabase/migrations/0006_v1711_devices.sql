-- Ari v17.1.1 (Oct 16, 2026): pings come from Ari, not a browser. Needs 0002/0003.
-- 1. Web push subscriptions become per install: browser + standalone + install id, and an `active` switch.
--    A new installed-app subscription (standalone PWA) pauses older browser-tab subscriptions on the same platform
--    (still listed, revocable from Settings > Devices getting alerts). ari-push sends only to active, non-revoked rows.
-- 2. push_tokens: Expo push tokens from the native Ari app (owner RLS). Registering one pauses that platform's web subscriptions.

alter table public.push_subscriptions
  add column if not exists browser text,          -- chrome | brave | safari | samsung | firefox | edge | other
  add column if not exists standalone boolean,    -- true = installed app (WebAPK / Home Screen), false = browser tab
  add column if not exists install_id text,       -- random id kept in the install's localStorage
  add column if not exists active boolean not null default true,
  add column if not exists paused_reason text;

create table if not exists public.push_tokens (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,                     -- ExponentPushToken[...]
  provider text not null default 'expo',
  platform text,                                  -- android | ios
  device text,
  app_version text,
  kinds text[] not null default '{accepted,replied,meeting,research_done,draft_due,test}',
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text,
  failures int not null default 0,
  active boolean not null default true,
  revoked_at timestamptz
);
alter table public.push_tokens enable row level security;
drop policy if exists owner_all on public.push_tokens;
create policy owner_all on public.push_tokens for all to authenticated using (public.is_owner()) with check (public.is_owner());
revoke all on public.push_tokens from anon;

-- register / refresh a web subscription with install details (supersedes register_push for v17.1.1+ clients)
create or replace function public.register_push2(p_endpoint text, p_p256dh text, p_auth text,
    p_platform text default null, p_device text default null, p_user_agent text default null,
    p_browser text default null, p_standalone boolean default null, p_install_id text default null,
    p_explicit boolean default false)
returns uuid language plpgsql security invoker set search_path = public as $$
declare rid uuid;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  insert into public.push_subscriptions(endpoint, p256dh, auth, platform, device, user_agent, browser, standalone, install_id, active)
  values (p_endpoint, p_p256dh, p_auth, p_platform, p_device, p_user_agent, p_browser, p_standalone, p_install_id, true)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
     platform = coalesce(excluded.platform, push_subscriptions.platform),
     device = coalesce(excluded.device, push_subscriptions.device),
     user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
     browser = coalesce(excluded.browser, push_subscriptions.browser),
     standalone = coalesce(excluded.standalone, push_subscriptions.standalone),
     install_id = coalesce(excluded.install_id, push_subscriptions.install_id),
     failures = 0, last_error = null,
     -- a launch-time refresh never revives a subscription that was removed or superseded; only an explicit Turn on does
     revoked_at = case when p_explicit or push_subscriptions.paused_reason is null then null else push_subscriptions.revoked_at end,
     active = case when p_explicit or push_subscriptions.paused_reason is null then true else push_subscriptions.active end,
     paused_reason = case when p_explicit then null else push_subscriptions.paused_reason end
  returning id into rid;
  -- the same install re-subscribed with a new endpoint: retire its old endpoint
  if p_install_id is not null then
    update public.push_subscriptions set revoked_at = now(), active = false, paused_reason = 'replaced by a newer subscription'
     where id <> rid and install_id = p_install_id and revoked_at is null;
  end if;
  -- an installed app is now getting pings: pause browser-tab subscriptions on the same platform (revocable in Settings)
  if coalesce(p_standalone, false) then
    update public.push_subscriptions set active = false, paused_reason = 'superseded by the installed Ari app'
     where id <> rid and revoked_at is null and active and coalesce(standalone, false) = false
       and coalesce(platform, '') = coalesce(p_platform, '');
  end if;
  return rid;
end $$;
revoke all on function public.register_push2(text, text, text, text, text, text, text, boolean, text, boolean) from public, anon;
grant execute on function public.register_push2(text, text, text, text, text, text, text, boolean, text, boolean) to authenticated, service_role;

-- native app: register an Expo push token; pauses web pings on that platform (one ping per event, from the app)
create or replace function public.register_push_token(p_token text, p_platform text default null,
    p_device text default null, p_app_version text default null)
returns uuid language plpgsql security invoker set search_path = public as $$
declare rid uuid;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if p_token !~ '^Expo(nent)?PushToken\[.+\]$' then raise exception 'not an Expo push token'; end if;
  insert into public.push_tokens(token, platform, device, app_version)
  values (p_token, p_platform, p_device, p_app_version)
  on conflict (token) do update set platform = coalesce(excluded.platform, push_tokens.platform),
     device = coalesce(excluded.device, push_tokens.device), app_version = coalesce(excluded.app_version, push_tokens.app_version),
     revoked_at = null, failures = 0, last_error = null, active = true
  returning id into rid;
  update public.push_subscriptions set active = false, paused_reason = 'superseded by the Ari app'
   where revoked_at is null and active and coalesce(platform, '') = coalesce(p_platform, '');
  return rid;
end $$;
revoke all on function public.register_push_token(text, text, text, text) from public, anon;
grant execute on function public.register_push_token(text, text, text, text) to authenticated, service_role;

-- edge function bookkeeping for Expo tickets (DeviceNotRegistered -> revoke)
create or replace function public.ari_token_result(p_id uuid, p_ok boolean, p_error text, p_unregistered boolean default false)
returns void language sql security definer set search_path = public as $$
  update public.push_tokens set
    last_ok_at = case when p_ok then now() else last_ok_at end,
    failures = case when p_ok then 0 else failures + 1 end,
    last_error = case when p_ok then null else left(coalesce(p_error, ''), 300) end,
    revoked_at = case when p_unregistered then now() else revoked_at end,
    active = case when p_unregistered then false else active end
  where id = p_id;
$$;
revoke all on function public.ari_token_result(uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.ari_token_result(uuid, boolean, text, boolean) to service_role;

-- Settings > Devices getting alerts (owner only; no keys or endpoints leave the database)
create or replace function public.push_devices() returns table(id uuid, kind text, platform text, device text, browser text,
    standalone boolean, active boolean, paused_reason text, created_at timestamptz, last_ok_at timestamptz, last_error text, endpoint_tail text)
language sql stable security invoker set search_path = public as $$
  select id, 'web', platform, device, browser, standalone, active, paused_reason, created_at, last_ok_at, last_error, right(endpoint, 16)
    from public.push_subscriptions where revoked_at is null and public.is_owner()
  union all
  select id, 'app', platform, device, 'ari-app', true, active, null, created_at, last_ok_at, last_error, right(token, 12)
    from public.push_tokens where revoked_at is null and public.is_owner()
  order by created_at desc;
$$;
revoke all on function public.push_devices() from public, anon;
grant execute on function public.push_devices() to authenticated, service_role;

create or replace function public.push_device_set(p_id uuid, p_action text) returns text
language plpgsql security invoker set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if p_action = 'remove' then
    update public.push_subscriptions set revoked_at = now(), active = false, paused_reason = 'removed by you' where id = p_id;
    update public.push_tokens set revoked_at = now(), active = false where id = p_id;
  elsif p_action = 'pause' then
    update public.push_subscriptions set active = false, paused_reason = 'paused by you' where id = p_id;
    update public.push_tokens set active = false where id = p_id;
  elsif p_action = 'resume' then
    update public.push_subscriptions set active = true, paused_reason = null where id = p_id and revoked_at is null;
    update public.push_tokens set active = true where id = p_id and revoked_at is null;
  else raise exception 'unknown action %', p_action; end if;
  return p_action;
end $$;
revoke all on function public.push_device_set(uuid, text) from public, anon;
grant execute on function public.push_device_set(uuid, text) to authenticated, service_role;
