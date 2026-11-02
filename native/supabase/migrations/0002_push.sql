-- Ari v17 always-on push (Oct 15, 2026). Needs 0001.
-- Data changes (from the app, from Hark, or from the Sheet worker via the sync) raise rows in
-- public.notifications; the edge function "ari-push" sends them as Web Push to every active
-- subscription (Android Chrome PWA, iPhone home-screen PWA on iOS 16.4+).
-- Wiring that needs Supabase-only extensions (pg_net, pg_cron, vault) is in 0003_push_wiring.sql.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,                          -- subscriber public key (base64url)
  auth text not null,                            -- subscriber auth secret (base64url)
  platform text,                                 -- android | ios | desktop
  user_agent text,
  device text,                                   -- e.g. 'pixel', 'iphone'
  kinds text[] not null default '{accepted,replied,meeting,research_done,draft_due,test}',
  created_at timestamptz not null default now(),
  last_ok_at timestamptz,
  last_error text,
  failures int not null default 0,
  revoked_at timestamptz
);

create table public.notifications (
  id bigint generated always as identity primary key,
  kind text not null check (kind in ('accepted','replied','meeting','research_done','draft_due','test')),
  person_id text,
  account_id uuid,
  title text not null,
  body text,
  url text not null default '/ops',
  dedupe_key text unique,                        -- one push per real-world event, however often sync re-runs
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts int not null default 0,
  claimed_at timestamptz,
  delivered int not null default 0,
  error text
);
create index notifications_unsent on public.notifications(id) where sent_at is null;

create table public.app_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table public.push_subscriptions enable row level security;
alter table public.notifications enable row level security;
alter table public.app_config enable row level security;
create policy owner_all on public.push_subscriptions for all to authenticated using (public.is_owner()) with check (public.is_owner());
create policy owner_read on public.notifications for select to authenticated using (public.is_owner());
create policy owner_read on public.app_config for select to authenticated using (public.is_owner());
revoke all on public.push_subscriptions, public.notifications, public.app_config from anon;
revoke insert, update, delete on public.notifications, public.app_config from authenticated;

-- register / refresh a subscription from the phone (upsert on endpoint)
create or replace function public.register_push(p_endpoint text, p_p256dh text, p_auth text,
                                                p_platform text default null, p_device text default null,
                                                p_user_agent text default null)
returns uuid language plpgsql security invoker set search_path = public as $$
declare rid uuid;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  insert into public.push_subscriptions(endpoint, p256dh, auth, platform, device, user_agent)
  values (p_endpoint, p_p256dh, p_auth, p_platform, p_device, p_user_agent)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
     platform = coalesce(excluded.platform, push_subscriptions.platform),
     device = coalesce(excluded.device, push_subscriptions.device),
     user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
     revoked_at = null, failures = 0, last_error = null
  returning id into rid;
  return rid;
end $$;
revoke all on function public.register_push(text, text, text, text, text, text) from public, anon;
grant execute on function public.register_push(text, text, text, text, text, text) to authenticated, service_role;

-- ---------- event detection ----------
create or replace function public.ari_notify(p_kind text, p_key text, p_title text, p_body text,
                                             p_url text, p_person text default null, p_account uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications(kind, dedupe_key, title, body, url, person_id, account_id)
  values (p_kind, p_key, p_title, p_body, coalesce(p_url, '/ops'), p_person, p_account)
  on conflict (dedupe_key) do nothing;
$$;
revoke all on function public.ari_notify(text, text, text, text, text, text, uuid) from public, anon, authenticated;

create or replace function public.people_notify() returns trigger language plpgsql security definer set search_path = public as $$
declare
  ins boolean := tg_op = 'INSERT';
  who text := coalesce(new.name, 'Someone');
  co text := coalesce(nullif(new.company, ''), 'their company');
  url text := '/ops?open=person:' || new.id;
  research_now boolean;
begin
  if coalesce(new.updated_by, '') like 'backfill%' then return null; end if;
  if new.review = 'personal' or new.deleted_at is not null or new.stage in ('Hold', 'Founder') then return null; end if;

  if new.accepted is not null and (ins or old.accepted is null) then
    perform public.ari_notify('accepted', 'accepted:' || new.id, who || ' accepted',
      co || case when coalesce(new.dm, '') <> '' then '. DM1 draft is ready.' else '. I''m on the DM1.' end, url, new.id, new.account_id);
  end if;
  if new.replied is not null and (ins or old.replied is null) then
    perform public.ari_notify('replied', 'replied:' || new.id, who || ' replied', co || '. Open LinkedIn, I''ll draft your answer.', url, new.id, new.account_id);
  end if;
  if new.meeting is not null and (ins or old.meeting is null) then
    perform public.ari_notify('meeting', 'meeting:person:' || new.id, 'Meeting set with ' || who, co || '. Log it in SFDC.', url, new.id, new.account_id);
  end if;

  research_now := coalesce(new.research, '') in ('done', 'Draft ready')
                  and not ins and coalesce(old.research, '') ilike 'research%';
  if research_now then
    perform public.ari_notify('research_done', 'research:' || new.id || ':' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'),
      'Research done: ' || who,
      co || case when coalesce(new.dm, '') <> '' and new.dm1_sent is null then '. DM1 draft is ready to send.' else '.' end, url, new.id, new.account_id);
  elsif new.accepted is not null and new.dm1_sent is null and coalesce(new.dm, '') <> ''
        and (ins or coalesce(old.dm, '') = '') then
    perform public.ari_notify('draft_due', 'draft:dm1:' || new.id, 'DM1 ready for ' || who, co || '. Ready for you to send.', url, new.id, new.account_id);
  end if;
  if not ins and coalesce(new.dm2_text, '') <> '' and coalesce(old.dm2_text, '') = '' and new.dm2_sent is null and new.replied is null then
    perform public.ari_notify('draft_due', 'draft:dm2:' || new.id, 'DM2 drafted for ' || who,
      co || coalesce('. Due ' || to_char(new.dm2_due, 'Mon DD') || '.', '.'), url, new.id, new.account_id);
  end if;
  if not ins and coalesce(new.dm3_text, '') <> '' and coalesce(old.dm3_text, '') = '' and new.dm3_sent is null and new.replied is null then
    perform public.ari_notify('draft_due', 'draft:dm3:' || new.id, 'DM3 drafted for ' || who,
      co || coalesce('. Due ' || to_char(new.dm3_due, 'Mon DD') || '.', '.'), url, new.id, new.account_id);
  end if;
  return null;
end $$;
create trigger people_notify after insert or update on public.people for each row execute function public.people_notify();

create or replace function public.accounts_notify() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(new.updated_by, '') like 'backfill%' then return null; end if;
  if lower(coalesce(new.meeting_status, '')) = 'set'
     and (tg_op = 'INSERT' or lower(coalesce(old.meeting_status, '')) <> 'set') then
    perform public.ari_notify('meeting', 'meeting:account:' || new.id || ':' || coalesce(new.meeting_date, ''),
      'Meeting set: ' || new.company,
      concat_ws(' · ', nullif(new.meeting_person, ''), nullif(new.meeting_date, ''), nullif(new.meeting_ae, '')),
      '/ops?open=account:' || new.id, null, new.id);
  end if;
  return null;
end $$;
create trigger accounts_notify after insert or update on public.accounts for each row execute function public.accounts_notify();

-- nightly "what's due tonight" (run by pg_cron at 21:00 IST, see 0003)
create or replace function public.ari_due_digest() returns int language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Kolkata')::date; n1 int; n2 int; n3 int; total int;
begin
  select count(*) filter (where accepted is not null and dm1_sent is null),
         count(*) filter (where dm1_sent is not null and dm2_sent is null and dm2_due <= today),
         count(*) filter (where dm2_sent is not null and dm3_sent is null and dm3_due <= today)
    into n1, n2, n3
    from public.people
   where coalesce(review, 'lead') = 'lead' and deleted_at is null and skipped is null
     and replied is null and meeting is null and withdrawn is null
     and stage not in ('Hold', 'Founder') and (snooze_until is null or snooze_until <= today);
  total := n1 + n2 + n3;
  if total > 0 then
    perform public.ari_notify('draft_due', 'digest:' || today, total || ' follow-up' || case when total = 1 then '' else 's' end || ' due tonight',
      concat_ws(', ', case when n1 > 0 then n1 || ' DM1' end, case when n2 > 0 then n2 || ' DM2' end, case when n3 > 0 then n3 || ' DM3' end) || '. Ready when you are.',
      '/ops', null, null);
  end if;
  return total;
end $$;
revoke all on function public.ari_due_digest() from public, anon, authenticated;

-- ---------- sender helpers (service_role only; used by the ari-push edge function) ----------
-- claim unsent notifications atomically so overlapping invocations never double-send
create or replace function public.ari_claim_notifications(p_limit int default 50) returns setof public.notifications
language sql security definer set search_path = public as $$
  update public.notifications n set attempts = n.attempts + 1, claimed_at = now()
   where n.id in (select id from public.notifications
                   where sent_at is null and attempts < 5
                     and (claimed_at is null or claimed_at < now() - interval '2 minutes')
                   order by id for update skip locked limit p_limit)
  returning n.*;
$$;
create or replace function public.ari_finish_notifications(p_ids bigint[], p_delivered int, p_error text)
returns void language sql security definer set search_path = public as $$
  update public.notifications set sent_at = case when p_error is null or p_delivered > 0 then now() end,
         delivered = p_delivered, error = p_error, claimed_at = null
   where id = any(p_ids);
$$;
create or replace function public.ari_subscription_result(p_id uuid, p_ok boolean, p_status int, p_error text)
returns void language sql security definer set search_path = public as $$
  update public.push_subscriptions set
    last_ok_at = case when p_ok then now() else last_ok_at end,
    failures = case when p_ok then 0 else failures + 1 end,
    last_error = case when p_ok then null else left(coalesce(p_status::text, '') || ' ' || coalesce(p_error, ''), 300) end,
    revoked_at = case when p_status in (404, 410) then now() else revoked_at end
  where id = p_id;
$$;
do $$
declare f text;
begin
  foreach f in array array['public.ari_claim_notifications(int)','public.ari_finish_notifications(bigint[], int, text)',
                           'public.ari_subscription_result(uuid, boolean, int, text)'] loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
grant execute on function public.ari_due_digest() to service_role;
