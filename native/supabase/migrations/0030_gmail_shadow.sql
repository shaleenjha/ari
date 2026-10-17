-- 0030 (v18.8.1, Sat Oct 17 2026; staging first): Ari reads Owner's Gmail through its OWN read-only Google connection, SHADOW MODE.
-- Approved by Owner Oct 17 2026 08:25 IST. Scope https://www.googleapis.com/auth/gmail.readonly only.
--   * gmail_connection (one row): which address is connected, the Vault id of its refresh token, forward-only cursor,
--     last read, failure streak. The token itself lives only in Supabase Vault (vault.secrets), never in a table column.
--   * gmail_connect_tickets / gmail_oauth_states: one-time, 10-minute values for the connect flow (edge fn ari-gmail-oauth).
--     The app asks for a ticket (owner only), opens .../ari-gmail-oauth/start?t=<ticket>; start stores state + PKCE verifier.
--   * gmail_shadow_events: ONLY parsed fields (msg id, event type, profile URL, name, exact time). Never bodies or snippets.
--   * gmail_ingest_runs: one row per 10-minute run (counts + short error), for health. 3 failures in a row -> one ops_alert push.
--   * gmail_shadow_diffs: nightly report ari.shadow-diff/v1 comparing shadow events with what the current worker recorded
--     (people.accepted + ts_approx, replies from gmail). Shadow output changes NOTHING else: no people/replies writes here.
--   * pg_cron: 'ari-gmail-ingest' every 10 min (kicks the edge fn only while connected), 'ari-gmail-shadow-diff' 00:30 IST.
-- Allowlist: only owner@example.com can be stored as the connected address (checked here AND in the edge fn).
-- app_config 'gmail_fn_base' = this project's functions URL (prod default below; staging helper sets its own ref).

create table if not exists public.gmail_connection (
  id int primary key default 1 check (id = 1),
  address text,
  vault_secret_id uuid,
  status text not null default 'disconnected' check (status in ('disconnected','connected','needs_reconnect')),
  connected_at timestamptz,
  last_read_at timestamptz,
  cursor_ms bigint not null default 0,            -- newest Gmail internalDate seen (ms); only ever moves forward
  fail_streak int not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
insert into public.gmail_connection(id) values (1) on conflict do nothing;

create table if not exists public.gmail_connect_tickets (ticket text primary key, created_at timestamptz not null default now(), used_at timestamptz);
create table if not exists public.gmail_oauth_states (state text primary key, verifier text not null, created_at timestamptz not null default now(), used_at timestamptz);

create table if not exists public.gmail_shadow_events (
  msg_id text primary key,                        -- Gmail message id (idempotency key)
  kind text not null check (kind in ('accept','reply')),
  profile_url text,
  name text,
  event_at timestamptz not null,                  -- the email's own time (exact)
  ingested_at timestamptz not null default now()
);
create index if not exists gmail_shadow_events_at on public.gmail_shadow_events(event_at);

create table if not exists public.gmail_ingest_runs (
  id bigserial primary key,
  at timestamptz not null default now(),
  ok boolean not null,
  listed int, fetched int, stored int,
  error text
);
create table if not exists public.gmail_shadow_diffs (
  night date primary key,
  report jsonb not null,
  agree boolean not null,
  match_rate numeric,
  created_at timestamptz not null default now()
);

do $$ declare t text; begin
  foreach t in array array['gmail_connection','gmail_connect_tickets','gmail_oauth_states','gmail_shadow_events','gmail_ingest_runs','gmail_shadow_diffs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
  end loop;
end $$;
revoke all on sequence public.gmail_ingest_runs_id_seq from public, anon, authenticated;

insert into public.app_config(key, value) values ('gmail_fn_base', 'https://rbkrqlzlblquvgmuohro.supabase.co/functions/v1') on conflict (key) do nothing;
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'ari_gmail_hook_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ari_gmail_hook_secret', 'x-ari-hook for edge function ari-gmail-ingest');
  end if;
end $$;

-- ---------- helpers ----------
create or replace function public.ari_li_vanity(u text) returns text language sql immutable set search_path = '' as $$
  select nullif(lower(rtrim(substring(coalesce(u, '') from 'linkedin\.com/(?:comm/)?in/([^/?#"\s]+)'), '/')), '');
$$;
revoke all on function public.ari_li_vanity(text) from public, anon, authenticated;

-- vanity first, then a name that is unique among live people; anything ambiguous is "no match" (never guessed)
create or replace function public.ari_gmail_match_person(p_vanity text, p_name text) returns text
language sql stable security definer set search_path = public as $$
  with v as (select id from people where deleted_at is null and p_vanity is not null and public.ari_li_vanity(linkedin_url) = p_vanity),
       n as (select id from people where deleted_at is null and nullif(trim(p_name), '') is not null and lower(trim(name)) = lower(trim(p_name)))
  select case when (select count(*) from v) = 1 then (select id from v)
              when (select count(*) from v) = 0 and (select count(*) from n) = 1 then (select id from n) end;
$$;
revoke all on function public.ari_gmail_match_person(text, text) from public, anon, authenticated;

-- ---------- owner (app) ----------
create or replace function public.ari_gmail_connect_ticket() returns text language plpgsql security definer set search_path = public as $$
declare t text := encode(extensions.gen_random_bytes(24), 'hex');
begin
  if not public.is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from gmail_connect_tickets where created_at < now() - interval '1 day';
  insert into gmail_connect_tickets(ticket) values (t);
  return t;
end $$;
revoke all on function public.ari_gmail_connect_ticket() from public, anon;
grant execute on function public.ari_gmail_connect_ticket() to authenticated;

create or replace function public.ari_gmail_status() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare c gmail_connection; r jsonb;
begin
  if not public.is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into c from gmail_connection where id = 1;
  select jsonb_build_object(
    'status', coalesce(c.status, 'disconnected'),
    'address', c.address,
    'connected_at', c.connected_at,
    'last_read_at', c.last_read_at,
    'fail_streak', coalesce(c.fail_streak, 0),
    'events_7d', (select count(*) from gmail_shadow_events where event_at > now() - interval '7 days'),
    'nights', (select count(*) from gmail_shadow_diffs),
    'last_night', (select night from gmail_shadow_diffs order by night desc limit 1),
    'last_agree', (select agree from gmail_shadow_diffs order by night desc limit 1),
    'match_rate_7d', (select round(avg(match_rate), 3) from gmail_shadow_diffs where night > (now() at time zone 'Asia/Kolkata')::date - 8 and match_rate is not null)
  ) into r;
  return r;
end $$;
revoke all on function public.ari_gmail_status() from public, anon;
grant execute on function public.ari_gmail_status() to authenticated;

-- disconnect: deletes the stored token (Vault) and stops the 10-minute reads. Revoking at Google is a separate step.
create or replace function public.ari_gmail_disconnect() returns jsonb language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  if not public.is_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  select vault_secret_id into sid from gmail_connection where id = 1;
  if sid is not null then delete from vault.secrets where id = sid; end if;
  update gmail_connection set status = 'disconnected', vault_secret_id = null, fail_streak = 0, last_error = null, updated_at = now() where id = 1;
  return jsonb_build_object('status', 'disconnected');
end $$;
revoke all on function public.ari_gmail_disconnect() from public, anon;
grant execute on function public.ari_gmail_disconnect() to authenticated;

-- ---------- edge functions (service_role only) ----------
create or replace function public.ari_gmail_hook() returns text language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'ari_gmail_hook_secret';
$$;
revoke all on function public.ari_gmail_hook() from public, anon, authenticated;
grant execute on function public.ari_gmail_hook() to service_role;

create or replace function public.ari_gmail_ticket_take(p_ticket text) returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update gmail_connect_tickets set used_at = now()
   where ticket = p_ticket and used_at is null and created_at > now() - interval '10 minutes';
  get diagnostics n = row_count;
  return n = 1;
end $$;
revoke all on function public.ari_gmail_ticket_take(text) from public, anon, authenticated;
grant execute on function public.ari_gmail_ticket_take(text) to service_role;

create or replace function public.ari_gmail_state_put(p_state text, p_verifier text) returns void language sql security definer set search_path = public as $$
  delete from gmail_oauth_states where created_at < now() - interval '1 day';
  insert into gmail_oauth_states(state, verifier) values (p_state, p_verifier);
$$;
revoke all on function public.ari_gmail_state_put(text, text) from public, anon, authenticated;
grant execute on function public.ari_gmail_state_put(text, text) to service_role;

create or replace function public.ari_gmail_state_take(p_state text) returns text language plpgsql security definer set search_path = public as $$
declare v text;
begin
  select verifier into v from gmail_oauth_states
   where state = p_state and used_at is null and created_at > now() - interval '10 minutes' for update;
  if v is null then return null; end if;
  update gmail_oauth_states set used_at = now(), verifier = '' where state = p_state;
  return v;
end $$;
revoke all on function public.ari_gmail_state_take(text) from public, anon, authenticated;
grant execute on function public.ari_gmail_state_take(text) to service_role;

create or replace function public.ari_gmail_connect(p_address text, p_refresh_token text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare sid uuid; addr text := lower(trim(p_address));
begin
  if addr is distinct from 'owner@example.com' then raise exception 'address not allowed' using errcode = '42501'; end if;
  if coalesce(p_refresh_token, '') = '' then raise exception 'no refresh token'; end if;
  select vault_secret_id into sid from gmail_connection where id = 1;
  if sid is not null and exists (select 1 from vault.secrets where id = sid) then
    perform vault.update_secret(sid, p_refresh_token);
  else
    sid := vault.create_secret(p_refresh_token, 'ari_gmail_refresh_' || to_char(now(), 'YYYYMMDDHH24MISS'), 'Ari read-only Gmail refresh token');
  end if;
  update gmail_connection set address = addr, vault_secret_id = sid, status = 'connected', connected_at = now(),
         fail_streak = 0, last_error = null, updated_at = now() where id = 1;
  return jsonb_build_object('status', 'connected');
end $$;
revoke all on function public.ari_gmail_connect(text, text) from public, anon, authenticated;
grant execute on function public.ari_gmail_connect(text, text) to service_role;

create or replace function public.ari_gmail_ingest_config() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('status', c.status, 'cursor_ms', c.cursor_ms,
           'refresh_token', (select decrypted_secret from vault.decrypted_secrets where id = c.vault_secret_id))
  from gmail_connection c where c.id = 1;
$$;
revoke all on function public.ari_gmail_ingest_config() from public, anon, authenticated;
grant execute on function public.ari_gmail_ingest_config() to service_role;

create or replace function public.ari_gmail_known_ids(p_ids text[]) returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(msg_id), '{}') from gmail_shadow_events where msg_id = any(p_ids);
$$;
revoke all on function public.ari_gmail_known_ids(text[]) from public, anon, authenticated;
grant execute on function public.ari_gmail_known_ids(text[]) to service_role;

-- p_events: [{msg_id, kind, profile_url, name, event_at}] ; idempotent on msg_id; cursor only moves forward
create or replace function public.ari_gmail_ingest_record(p_events jsonb, p_cursor_ms bigint, p_listed int, p_fetched int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into gmail_shadow_events(msg_id, kind, profile_url, name, event_at)
  select e->>'msg_id', e->>'kind', nullif(left(e->>'profile_url', 300), ''), nullif(left(e->>'name', 200), ''), (e->>'event_at')::timestamptz
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
   where e->>'kind' in ('accept','reply') and coalesce(e->>'msg_id', '') <> '' and e->>'event_at' is not null
  on conflict (msg_id) do nothing;
  get diagnostics n = row_count;
  update gmail_connection set cursor_ms = greatest(cursor_ms, coalesce(p_cursor_ms, 0)), last_read_at = now(),
         fail_streak = 0, last_error = null, updated_at = now() where id = 1;
  insert into gmail_ingest_runs(ok, listed, fetched, stored) values (true, p_listed, p_fetched, n);
  delete from gmail_ingest_runs where at < now() - interval '30 days';
  return jsonb_build_object('stored', n);
end $$;
revoke all on function public.ari_gmail_ingest_record(jsonb, bigint, int, int) from public, anon, authenticated;
grant execute on function public.ari_gmail_ingest_record(jsonb, bigint, int, int) to service_role;

create or replace function public.ari_gmail_ingest_fail(p_error text, p_reconnect boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s int; slot text := to_char(date_trunc('hour', now()) - (extract(hour from now())::int % 12) * interval '1 hour', 'YYYYMMDDHH24');
begin
  update gmail_connection set fail_streak = fail_streak + 1, last_error = left(p_error, 300), updated_at = now(),
         status = case when p_reconnect then 'needs_reconnect' else status end
   where id = 1 returning fail_streak into s;
  insert into gmail_ingest_runs(ok, error) values (false, left(p_error, 300));
  if s >= 3 then
    perform ari_notify('ops_alert', 'ops:gmail:' || slot, 'Ari needs a look', 'Ari could not read your Gmail the last few times.', '/ops', null, null);
  end if;
  return jsonb_build_object('fail_streak', s);
end $$;
revoke all on function public.ari_gmail_ingest_fail(text, boolean) from public, anon, authenticated;
grant execute on function public.ari_gmail_ingest_fail(text, boolean) to service_role;

-- ---------- 10-minute kick (only while connected) ----------
create or replace function public.ari_gmail_ingest_kick() returns bigint language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from gmail_connection where id = 1 and status = 'connected') then return null; end if;
  return net.http_post(
    url := (select value from app_config where key = 'gmail_fn_base') || '/ari-gmail-ingest',
    headers := jsonb_build_object('content-type', 'application/json', 'x-ari-hook', public.ari_gmail_hook()),
    body := '{"source":"cron"}'::jsonb, timeout_milliseconds := 30000);
end $$;
revoke all on function public.ari_gmail_ingest_kick() from public, anon, authenticated;

-- ---------- nightly shadow diff: ari.shadow-diff/v1 (same rules as app2/jobs/src/gmail/shadow.ts) ----------
-- ids only (person ids, Gmail ids), never names or snippets. Writes gmail_shadow_diffs only.
create or replace function public.ari_gmail_shadow_diff(p_night date default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  d date := coalesce(p_night, (now() at time zone 'Asia/Kolkata')::date - 1);
  w_from timestamptz := (d::timestamp at time zone 'Asia/Kolkata');
  w_to timestamptz := ((d + 1)::timestamp at time zone 'Asia/Kolkata');
  tol int := 10; items jsonb; counts jsonb; ok boolean; rate numeric; rep jsonb;
begin
  if not exists (select 1 from gmail_connection where id = 1 and connected_at is not null) then
    return jsonb_build_object('skipped', 'not_connected');
  end if;
  with sh as (
    select e.msg_id, e.kind, e.event_at, public.ari_gmail_match_person(public.ari_li_vanity(e.profile_url), e.name) pid
      from gmail_shadow_events e where e.event_at >= w_from and e.event_at < w_to),
  pa as (select distinct on (pid) * from sh where kind = 'accept' and pid is not null order by pid, event_at),
  wa as (select id, accepted from people where deleted_at is null and accepted >= w_from and accepted < w_to),
  acc as (
    select jsonb_build_object('kind','accept','status','unmatched','sourceMsgId',msg_id,'parserAt',event_at) j
      from sh where kind = 'accept' and pid is null
    union all
    select jsonb_strip_nulls(jsonb_build_object('kind','accept',
      'status', case when p.accepted is null then 'extra_in_parser'
                     when (case when 'accepted' = any(p.ts_approx)
                                then (pa.event_at at time zone 'Asia/Kolkata')::date = (p.accepted at time zone 'Asia/Kolkata')::date
                                else abs(extract(epoch from pa.event_at - p.accepted)) <= tol * 60 end) then 'match'
                     else 'time_mismatch' end,
      'personId', pa.pid, 'sourceMsgId', pa.msg_id, 'parserAt', pa.event_at, 'workerAt', p.accepted,
      'deltaMinutes', round(extract(epoch from pa.event_at - p.accepted) / 60),
      'note', case when 'accepted' = any(p.ts_approx) then 'worker time is day-granular' end))
      from pa join people p on p.id = pa.pid
    union all
    select jsonb_build_object('kind','accept','status','missing_in_parser','personId',wa.id,'workerAt',wa.accepted)
      from wa where not exists (select 1 from pa where pa.pid = wa.id)),
  wr as (select id, person_id, gmail_id, received_at from replies where source = 'gmail' and received_at >= w_from and received_at < w_to),
  pr as (
    select sh.*, coalesce(
      (select wr.id from wr where wr.gmail_id = sh.msg_id limit 1),
      (select wr.id from wr where wr.gmail_id is null and sh.pid is not null and wr.person_id = sh.pid
          and abs(extract(epoch from sh.event_at - wr.received_at)) <= tol * 60
        order by abs(extract(epoch from sh.event_at - wr.received_at)) limit 1)) wid
      from sh where kind = 'reply'),
  rep as (
    select jsonb_strip_nulls(jsonb_build_object('kind','reply',
      'status', case when pr.pid is null then 'unmatched'
                     when wr.id is null then 'extra_in_parser'
                     when wr.person_id is distinct from pr.pid then 'person_mismatch'
                     when abs(extract(epoch from pr.event_at - wr.received_at)) <= tol * 60 then 'match'
                     else 'time_mismatch' end,
      'personId', coalesce(wr.person_id, pr.pid), 'parserPersonId', case when wr.person_id is distinct from pr.pid then pr.pid end,
      'sourceMsgId', pr.msg_id, 'workerReplyId', wr.id::text, 'parserAt', pr.event_at, 'workerAt', wr.received_at,
      'deltaMinutes', round(extract(epoch from pr.event_at - wr.received_at) / 60))) j
      from pr left join wr on wr.id = pr.wid
    union all
    select jsonb_build_object('kind','reply','status','missing_in_parser','personId',wr.person_id,'workerReplyId',wr.id::text,'workerAt',wr.received_at)
      from wr where not exists (select 1 from pr where pr.wid = wr.id)),
  allj as (select j from acc union all select j from rep)
  select coalesce(jsonb_agg(j order by j->>'status', coalesce(j->>'parserAt', j->>'workerAt')), '[]'::jsonb) into items from allj;

  select jsonb_build_object(
    'match', count(*) filter (where i->>'status' = 'match'),
    'time_mismatch', count(*) filter (where i->>'status' = 'time_mismatch'),
    'missing_in_parser', count(*) filter (where i->>'status' = 'missing_in_parser'),
    'extra_in_parser', count(*) filter (where i->>'status' = 'extra_in_parser'),
    'person_mismatch', count(*) filter (where i->>'status' = 'person_mismatch'),
    'unmatched', count(*) filter (where i->>'status' = 'unmatched')),
    case when count(*) = 0 then null else round((count(*) filter (where i->>'status' = 'match'))::numeric / count(*), 3) end
    into counts, rate from jsonb_array_elements(items) i;

  ok := (counts->>'missing_in_parser')::int + (counts->>'extra_in_parser')::int + (counts->>'person_mismatch')::int
        + (counts->>'time_mismatch')::int = 0 and (counts->>'unmatched')::int <= 1;
  rep := jsonb_build_object('schema', 'ari.shadow-diff/v1', 'workspaceId', 'shal', 'night', d,
    'window', jsonb_build_object('from', w_from, 'to', w_to), 'generatedAt', now(), 'counts', counts, 'agree', ok, 'items', items,
    'rules', jsonb_build_object('exactToleranceMin', tol, 'approxDayZone', 'Asia/Kolkata', 'maxUnmatched', 1));
  insert into gmail_shadow_diffs(night, report, agree, match_rate) values (d, rep, ok, rate)
  on conflict (night) do update set report = excluded.report, agree = excluded.agree, match_rate = excluded.match_rate, created_at = now();
  return jsonb_build_object('night', d, 'agree', ok, 'counts', counts, 'match_rate', rate);
end $$;
revoke all on function public.ari_gmail_shadow_diff(date) from public, anon, authenticated;

select cron.unschedule('ari-gmail-ingest') where exists (select 1 from cron.job where jobname = 'ari-gmail-ingest');
select cron.schedule('ari-gmail-ingest', '*/10 * * * *', $c$select public.ari_gmail_ingest_kick()$c$);
select cron.unschedule('ari-gmail-shadow-diff') where exists (select 1 from cron.job where jobname = 'ari-gmail-shadow-diff');
select cron.schedule('ari-gmail-shadow-diff', '0 19 * * *', $c$select public.ari_gmail_shadow_diff()$c$);  -- 00:30 IST

insert into supabase_migrations.schema_migrations(version, name) values ('0030', 'gmail_shadow') on conflict do nothing;
