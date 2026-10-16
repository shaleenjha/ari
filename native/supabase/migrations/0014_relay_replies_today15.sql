-- 0014 Relay: Replies (#9) and Today's 15 (#10). Board fixes 9 and 10, Oct 16 2026.
-- PURELY ADDITIVE: new tables, new functions, grants, realtime publication adds. No existing table, column,
-- function, trigger or policy is altered or replaced. Safe to re-run.
--
-- Replies (#9)
--   replies            one row per LinkedIn message notification email (Gmail) matched to a person, or per reply Owner ticked.
--                      Written by Hark (scripts/reply_ingest.py, service role) and by the owner RPCs below. Owner read only.
--   ari_replies_open() open replies for the Today pin (newest first), with person, account, snippet and 3 drafts.
--   ari_reply_paste()  Owner pastes the prospect's text (LinkedIn digest emails do not carry it): stores it, clears drafts
--                      so Hark redrafts against the real words.
--   ari_reply_done()   answered / meeting / dismissed; optional final text goes to sent_messages via ari_sent_log.
-- Push: reply_ingest.py inserts the 'replied' notification itself, BEFORE it sets people.replied, with the same
--   dedupe_key ('replied:<person id>') the people_notify trigger uses, so the existing trigger's named text is skipped
--   (on conflict do nothing) and the lock screen shows generic text unless ari_prefs.push_show_names is true.
--   Gap closed only by 0015 (NOT applied): a guard on notifications for replies that reach Supabase another way
--   (Sheet sync, worker step 0 Sheet path).
--
-- Today's 15 (#10)
--   ari_today15(p_day, p_limit)  ranked connect list, per-account daily cap (default 4, settable 4 or 5) counting
--                                invites already sent that IST day, open-invite ceiling per account, round-robin
--                                spread across accounts. Read only. Never acts on LinkedIn.
--   ari_today15_meta(p_day)      caps, sent today, weekly invites vs ceiling, per-account cap left.
--   ari_today_top(p_day)         one call for the Today screen: {replies, connects, meta}.
--
-- Settings
--   ari_prefs (key, value jsonb) + ari_pref_set(key, value) owner RPC, allow-listed keys.

-- ---------- settings ----------
create table if not exists public.ari_prefs (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text
);
alter table public.ari_prefs enable row level security;
drop policy if exists owner_read on public.ari_prefs;
create policy owner_read on public.ari_prefs for select to authenticated using ((select public.is_owner()));
revoke all on public.ari_prefs from anon, public;
revoke insert, update, delete, truncate on public.ari_prefs from authenticated;
grant select on public.ari_prefs to authenticated;

insert into public.ari_prefs(key, value, updated_by) values
  ('push_show_names', 'false'::jsonb, 'migration'),          -- lock-screen names on reply pushes (Settings toggle)
  ('today15_size', '15'::jsonb, 'migration'),
  ('today15_cap_per_account', '4'::jsonb, 'migration'),      -- 4 or 5 invites per account per IST day
  ('today15_open_cap', '8'::jsonb, 'migration'),             -- max open (unaccepted) invites per account
  ('weekly_invite_ceiling', '100'::jsonb, 'migration')       -- shown against invites sent in the last 7 days
on conflict (key) do nothing;

create or replace function public.ari_pref(p_key text, p_default jsonb default null) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from public.ari_prefs where key = p_key), p_default);
$$;

create or replace function public.ari_pref_set(p_key text, p_value jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if p_key = 'push_show_names' then
    if jsonb_typeof(p_value) <> 'boolean' then raise exception 'push_show_names takes true or false'; end if;
  elsif p_key = 'today15_cap_per_account' then
    n := (p_value #>> '{}')::int;
    if n not in (4, 5) then raise exception 'cap per account is 4 or 5'; end if;
    p_value := to_jsonb(n);
  elsif p_key in ('today15_size', 'today15_open_cap', 'weekly_invite_ceiling') then
    n := (p_value #>> '{}')::int;
    if n < 1 or n > 300 then raise exception 'out of range'; end if;
    p_value := to_jsonb(n);
  else
    raise exception 'unknown setting %', p_key;
  end if;
  insert into public.ari_prefs(key, value, updated_at, updated_by) values (p_key, p_value, now(), 'app')
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = 'app';
  return jsonb_build_object('key', p_key, 'value', p_value);
end $$;

-- ---------- replies ----------
create table if not exists public.replies (
  id bigserial primary key,
  person_id text not null references public.people(id),
  account_id uuid,
  gmail_id text unique,                       -- null for replies Owner ticked in the app (backfill/app source)
  source text not null default 'gmail' check (source in ('gmail', 'app', 'backfill')),
  received_at timestamptz not null default now(),
  msg_count int,                              -- "N new messages" from the digest
  thread_url text,                            -- https://www.linkedin.com/messaging/thread/<id>/ (tracking and login tokens stripped)
  headline text,                              -- sender headline as LinkedIn printed it
  snippet text,                               -- the prospect's words: from InMail emails, or pasted by Owner
  snippet_source text not null default 'none' check (snippet_source in ('email', 'pasted', 'none')),
  matched_by text check (matched_by in ('profile_url', 'name', 'app')),
  status text not null default 'new' check (status in ('new', 'answered', 'meeting', 'dismissed')),
  drafts jsonb,                               -- exactly 3: [{key:'book'|'answer'|'soft', label, body}]
  drafted_at timestamptz,
  answered_at timestamptz,
  answer_body text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists replies_open_idx on public.replies (status, received_at desc);
create index if not exists replies_person_idx on public.replies (person_id);
alter table public.replies enable row level security;
drop policy if exists owner_read on public.replies;
create policy owner_read on public.replies for select to authenticated using ((select public.is_owner()));
revoke all on public.replies from anon, public;
revoke insert, update, delete, truncate on public.replies from authenticated;
grant select on public.replies to authenticated;

create or replace function public.ari_replies_open(p_limit int default 20)
returns table(id bigint, person_id text, name text, title text, company text, account_id uuid, owner text,
              linkedin_url text, thread_url text, received_at timestamptz, age_min int, msg_count int,
              snippet text, snippet_source text, drafts jsonb, drafted_at timestamptz, status text, last_sent text)
language sql stable security invoker set search_path = public as $$
  select r.id, r.person_id, p.name, p.title, p.company, coalesce(r.account_id, p.account_id), p.owner,
         p.linkedin_url, r.thread_url, r.received_at, (extract(epoch from now() - r.received_at) / 60)::int, r.msg_count,
         r.snippet, r.snippet_source, r.drafts, r.drafted_at, r.status,
         (select s.body from public.sent_messages s where s.person_id = r.person_id and s.kind <> 'note' order by s.sent_at desc limit 1)
  from public.replies r join public.people p on p.id = r.person_id
  where r.status = 'new' and p.deleted_at is null and coalesce(p.review, 'lead') <> 'personal'
  order by r.received_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

create or replace function public.ari_reply_paste(p_id bigint, p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.replies;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if nullif(btrim(coalesce(p_text, '')), '') is null then raise exception 'empty text'; end if;
  update public.replies set snippet = left(btrim(p_text), 2000), snippet_source = 'pasted', drafts = null, drafted_at = null,
         status = 'new', updated_at = now()
  where id = p_id returning * into r;
  if not found then raise exception 'no such reply'; end if;
  return to_jsonb(r);
end $$;

create or replace function public.ari_reply_done(p_id bigint, p_outcome text, p_body text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.replies;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if coalesce(p_outcome, '') not in ('answered', 'meeting', 'dismissed', 'new') then raise exception 'bad outcome'; end if;
  update public.replies set status = p_outcome,
         answered_at = case when p_outcome = 'new' then null else now() end,
         answer_body = case when p_outcome = 'new' then null else coalesce(nullif(btrim(coalesce(p_body, '')), ''), answer_body) end,
         updated_at = now()
  where id = p_id returning * into r;
  if not found then raise exception 'no such reply'; end if;
  if p_outcome in ('answered', 'meeting') and nullif(btrim(coalesce(p_body, '')), '') is not null then
    perform public.ari_sent_log(r.person_id, 'reply', p_body, now());
  end if;
  return to_jsonb(r);
end $$;

-- ---------- Today's 15 ----------
-- Eligible: stage 'Connect queued', no invite yet, a lead (not personal or pending), Owner's lane (not Founder or Hold),
-- has a LinkedIn URL, not snoozed past the day, not skipped that day, account not on Hold / meeting set / flagged.
-- Score (0 to ~110): signal freshness of the account hook (50, linear to 0 at 90 days), scheduled for the day or overdue (30),
-- brief committee priority P1 20 / P2 10, DM1 already drafted 5, title seniority 5.
-- Cap: per account per IST day = today15_cap_per_account minus invites already sent there that day, and never more than
-- today15_open_cap minus open invites there. Spread: round robin, every account's best pick before anyone's second.
create or replace function public.ari_today15(p_day date default null, p_limit int default null)
returns table(rank int, person_id text, name text, title text, company text, account_id uuid, owner text, linkedin_url text,
              score numeric, wave int, why text, hook text, hook_date date, signal_age_days int, connect_day date,
              priority text, has_dm1 boolean, cap_left_after int)
language sql stable security invoker set search_path = public as $$
with cfg as (
  select coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date) as d,
         coalesce(p_limit, (public.ari_pref('today15_size', '15'::jsonb) #>> '{}')::int) as lim,
         (public.ari_pref('today15_cap_per_account', '4'::jsonb) #>> '{}')::int as cap,
         (public.ari_pref('today15_open_cap', '8'::jsonb) #>> '{}')::int as open_cap
),
prio as (
  select (pp ->> 'person_id') as person_id, min(pp ->> 'priority') as priority
  from public.account_briefs b, jsonb_array_elements(coalesce(b.committee, '[]'::jsonb)) t, jsonb_array_elements(coalesce(t -> 'people', '[]'::jsonb)) pp
  where pp ? 'person_id' group by 1
),
acct_load as (
  select coalesce(p.account_id::text, 'co:' || lower(coalesce(p.company, ''))) as akey,
         count(*) filter (where (p.connect_sent at time zone 'Asia/Kolkata')::date = (select d from cfg)) as sent_day,
         count(*) filter (where p.connect_sent is not null and p.accepted is null and p.withdrawn is null and p.replied is null) as open_inv
  from public.people p where p.deleted_at is null group by 1
),
elig as (
  select p.*, a.hook, a.hook_date, a.stage as astage,
         coalesce(p.account_id::text, 'co:' || lower(coalesce(p.company, ''))) as akey,
         pr.priority,
         case when a.hook_date is null then null else ((select d from cfg) - a.hook_date) end as age
  from public.people p
  left join public.accounts a on a.id = p.account_id
  left join prio pr on pr.person_id = p.id
  where p.deleted_at is null and p.stage = 'Connect queued' and p.connect_sent is null and p.withdrawn is null
    and coalesce(p.review, 'lead') = 'lead'
    and coalesce(p.lane, 'shal') not in ('founder', 'Founder') and coalesce(p.route, '') not ilike '%founder%'
    and nullif(btrim(coalesce(p.linkedin_url, '')), '') is not null
    and (p.snooze_until is null or p.snooze_until <= (select d from cfg))
    and (p.skipped is null or p.skipped <> (select d from cfg))
    and not (coalesce(p.flags, '{}') && array['dnc','hold','do-not'])
    and (a.id is null or (a.deleted_at is null and coalesce(a.stage, '') not in ('Hold', 'Meeting set', 'Closed')
         and coalesce(a.meeting_status, '') = '' and coalesce(array_length(a.flags, 1), 0) = 0))
),
scored as (
  select e.*,
         round(
           (case when e.age is null then 10 else greatest(0, 90 - e.age) * 50.0 / 90 end)
           + (case when e.connect_day is null then 10 when e.connect_day <= (select d from cfg) then 30 else greatest(0, 20 - 5 * (e.connect_day - (select d from cfg))) end)
           + (case e.priority when 'P1' then 20 when 'P2' then 10 else 0 end)
           + (case when coalesce(e.dm, '') <> '' then 5 else 0 end)
           + (case when e.title ~* '(chief|vp|vice president|head of|svp|director)' then 5 else 0 end), 1) as score
  from elig e
),
ranked as (
  select s.*, row_number() over (partition by s.akey order by s.score desc, s.created_at, s.id) as wave,
         greatest(0, least((select cap from cfg) - coalesce(l.sent_day, 0), (select open_cap from cfg) - coalesce(l.open_inv, 0))) as allowed
  from scored s left join acct_load l on l.akey = s.akey
),
picked as (
  select r.*, row_number() over (order by r.wave, r.score desc, r.id) as rk
  from ranked r where r.wave <= r.allowed
)
select rk::int, id, name, title, company, account_id, owner, linkedin_url, score, wave::int,
       concat_ws(' · ',
         case when hook_date is not null then 'Signal ' || age || 'd old' else 'No dated signal' end,
         case when connect_day is null then null when connect_day < (select d from cfg) then 'overdue since ' || to_char(connect_day, 'Mon DD')
              when connect_day = (select d from cfg) then 'planned today' end,
         case when priority in ('P1','P2') then priority || ' in brief' end,
         case when coalesce(dm, '') <> '' then 'DM1 ready' end),
       hook, hook_date, age::int, connect_day, priority, coalesce(dm, '') <> '', (allowed - wave)::int
from picked
where rk <= (select lim from cfg)
order by rk;
$$;

create or replace function public.ari_today15_meta(p_day date default null) returns jsonb
language sql stable security invoker set search_path = public as $$
with cfg as (
  select coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date) as d,
         (public.ari_pref('today15_cap_per_account', '4'::jsonb) #>> '{}')::int as cap,
         (public.ari_pref('today15_open_cap', '8'::jsonb) #>> '{}')::int as open_cap,
         (public.ari_pref('weekly_invite_ceiling', '100'::jsonb) #>> '{}')::int as ceiling,
         (public.ari_pref('today15_size', '15'::jsonb) #>> '{}')::int as size
),
per as (
  select coalesce(p.company, '(no company)') as company, p.account_id,
         count(*) filter (where (p.connect_sent at time zone 'Asia/Kolkata')::date = (select d from cfg)) as sent_day,
         count(*) filter (where p.connect_sent is not null and p.accepted is null and p.withdrawn is null and p.replied is null) as open_inv
  from public.people p where p.deleted_at is null group by 1, 2
)
select jsonb_build_object(
  'day', (select d from cfg),
  'size', (select size from cfg),
  'cap_per_account', (select cap from cfg),
  'open_cap', (select open_cap from cfg),
  'sent_today', (select count(*) from public.people where deleted_at is null and (connect_sent at time zone 'Asia/Kolkata')::date = (select d from cfg)),
  'sent_7d', (select count(*) from public.people where deleted_at is null and connect_sent >= ((select d from cfg) - 6)::timestamp at time zone 'Asia/Kolkata'),
  'weekly_ceiling', (select ceiling from cfg),
  'over_cap_today', coalesce((select jsonb_agg(jsonb_build_object('company', company, 'account_id', account_id, 'sent_today', sent_day) order by sent_day desc)
                              from per where sent_day > (select cap from cfg)), '[]'::jsonb),
  'accounts_today', coalesce((select jsonb_agg(jsonb_build_object('company', company, 'account_id', account_id, 'sent_today', sent_day, 'open_invites', open_inv,
                              'cap_left', greatest(0, least((select cap from cfg) - sent_day, (select open_cap from cfg) - open_inv))) order by sent_day desc)
                              from per where sent_day > 0), '[]'::jsonb)
);
$$;

create or replace function public.ari_today_top(p_day date default null) returns jsonb
language sql stable security invoker set search_path = public as $$
  select jsonb_build_object(
    'replies', coalesce((select jsonb_agg(to_jsonb(r)) from public.ari_replies_open(20) r), '[]'::jsonb),
    'connects', coalesce((select jsonb_agg(to_jsonb(c) order by c.rank) from public.ari_today15(p_day, null) c), '[]'::jsonb),
    'meta', public.ari_today15_meta(p_day),
    'push_show_names', coalesce(public.ari_pref('push_show_names', 'false'::jsonb), 'false'::jsonb),
    'as_of', now());
$$;

-- ---------- grants ----------
revoke all on function public.ari_pref(text, jsonb) from public, anon;
revoke all on function public.ari_pref_set(text, jsonb) from public, anon;
revoke all on function public.ari_replies_open(int) from public, anon;
revoke all on function public.ari_reply_paste(bigint, text) from public, anon;
revoke all on function public.ari_reply_done(bigint, text, text) from public, anon;
revoke all on function public.ari_today15(date, int) from public, anon;
revoke all on function public.ari_today15_meta(date) from public, anon;
revoke all on function public.ari_today_top(date) from public, anon;
grant execute on function public.ari_pref(text, jsonb), public.ari_pref_set(text, jsonb), public.ari_replies_open(int),
  public.ari_reply_paste(bigint, text), public.ari_reply_done(bigint, text, text), public.ari_today15(date, int),
  public.ari_today15_meta(date), public.ari_today_top(date) to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'replies') then
    alter publication supabase_realtime add table public.replies;
  end if;
end $$;
