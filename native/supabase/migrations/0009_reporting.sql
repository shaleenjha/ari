-- Ari reporting layer (v18 data layer, Oct 16 2026). One canonical way to compute every number.
-- Definitions and example queries: plans/ari-reporting.md.
--
-- Sources, in priority order:
--   1. people per-stage timestamps (connect_sent, accepted, dm1_sent, dm2_sent, dm3_sent, replied, meeting, withdrawn).
--      Canonical. Date-only Sheet imports sit at 12:00 IST, so the IST date is always right.
--   2. log_entries stage events ('Connect sent', 'Accepted', 'DM1 sent', ...) ONLY when the person's column is empty
--      and the event was not undone later ('Undo <field>'). Earliest event wins.
--   3. account-level facts: 'Meeting set' log lines (no person), accounts.meeting_status, accounts.stage (0008, read
--      defensively through to_jsonb), account_stage_history (0008: stage moves, Meeting set, Opportunity created),
--      queue 'New signal' rows. Requires 0008.
-- Unit of counting: one person per metric per range (accounts for meeting/opp/stage_change/account_added, queue rows
-- for signal). A person who got a connect and a DM in the same range counts once in each, never twice in one.
-- Personal connections (review = 'personal') and soft-deleted rows are excluded everywhere.
-- Day/week/month are IST; weeks run Monday to Sunday.
-- Security: views are security_invoker and functions security invoker, so RLS (owner only) applies to the app;
-- Hark's service_role bypasses RLS. anon gets nothing.

-- re-runnable: drop in dependency order first
drop function if exists public.report_summary(text, date, date, text, text, text);
drop function if exists public.report_rows(text, text, date, date, text, text, text, text);
drop function if exists public.accounts_worked(date, date, text, text);
drop function if exists public.report_series(text, text, int, text, text);
drop function if exists public.report_stage_times(text, text);
drop function if exists public.report_hooks(text, date, date, text, text, int);
drop function if exists public.rpt_filtered(date, date, text, text, text, text);
drop view if exists public.rpt_events;
drop view if exists public.rpt_accounts;
drop view if exists public.rpt_people;

-- ---------- helpers ----------
create or replace function public.rpt_day(t timestamptz) returns date
language sql immutable as $$ select (t at time zone 'Asia/Kolkata')::date $$;

create or replace function public.rpt_today() returns date
language sql stable as $$ select (now() at time zone 'Asia/Kolkata')::date $$;

-- period words -> [d_from, d_to] inclusive IST dates.
-- today | yesterday | this_week | last_week | this_month | last_month | last_7d | last_14d | last_30d | last_<N>d |
-- last_<N>w (N whole weeks ending this week) | all | custom (uses p_from/p_to). Unknown word -> this_week.
create or replace function public.rpt_range(p_period text default 'this_week', p_from date default null, p_to date default null,
                                            out d_from date, out d_to date, out label text)
language plpgsql stable as $$
declare t date := public.rpt_today(); per text := lower(coalesce(nullif(btrim(p_period), ''), 'this_week')); n int;
begin
  if p_from is not null or per = 'custom' then
    d_from := coalesce(p_from, date '2000-01-01'); d_to := coalesce(p_to, t); label := d_from || '..' || d_to; return;
  end if;
  label := per;
  if per = 'today' then d_from := t; d_to := t;
  elsif per = 'yesterday' then d_from := t - 1; d_to := t - 1;
  elsif per = 'this_week' then d_from := date_trunc('week', t)::date; d_to := d_from + 6;
  elsif per = 'last_week' then d_from := date_trunc('week', t)::date - 7; d_to := d_from + 6;
  elsif per = 'this_month' then d_from := date_trunc('month', t)::date; d_to := (date_trunc('month', t) + interval '1 month')::date - 1;
  elsif per = 'last_month' then d_from := (date_trunc('month', t) - interval '1 month')::date; d_to := date_trunc('month', t)::date - 1;
  elsif per = 'all' then d_from := date '2000-01-01'; d_to := t;
  elsif per ~ '^last_[0-9]+d$' then n := substring(per from '[0-9]+')::int; d_from := t - n + 1; d_to := t;
  elsif per ~ '^last_[0-9]+w$' then n := substring(per from '[0-9]+')::int; d_from := date_trunc('week', t)::date - 7 * (n - 1); d_to := date_trunc('week', t)::date + 6;
  else d_from := date_trunc('week', t)::date; d_to := d_from + 6; label := 'this_week';
  end if;
end $$;

-- ---------- people, one row per counted person ----------
create or replace view public.rpt_people with (security_invoker = true) as
select p.id as person_id, p.name, p.title, p.linkedin_url, p.stage, p.review, p.lane, p.research,
       coalesce(nullif(btrim(a.company), ''), nullif(btrim(p.company), ''), '(no company)') as account,
       lower(coalesce(nullif(btrim(a.company), ''), nullif(btrim(p.company), ''), '(no company)')) as account_key,
       a.id as account_id,
       coalesce(nullif(split_part(btrim(coalesce(p.owner, '')), ' ', 1), ''), nullif(a.ae, ''), 'Unassigned') as ae,
       coalesce(p.play, a.play, 'Unassigned') as play,
       a.hook,
       p.connect_sent, p.accepted, p.dm1_sent, p.dm2_sent, p.dm3_sent, p.replied, p.meeting, p.withdrawn,
       p.stage_changed_at, p.dm, p.dm2_text, p.dm3_text, p.field_ts, p.created_at
from public.people p
left join lateral (
  select x.* from public.accounts x
  where x.deleted_at is null
    and (x.id = p.account_id or (p.account_id is null and lower(btrim(x.company)) = lower(btrim(p.company))))
  order by (x.id = p.account_id) desc limit 1
) a on true
where p.deleted_at is null and coalesce(p.review, 'lead') <> 'personal';

-- ---------- accounts: the accounts table plus companies that only exist on people rows ----------
create or replace view public.rpt_accounts with (security_invoker = true) as
with ppl as (
  select account_key, min(account) as account, count(*) as people_n,
         count(*) filter (where accepted is not null or replied is not null) as engaged_n,
         min(least(accepted, replied)) as engaged_at, min(meeting) as meeting_at,
         mode() within group (order by ae) as ae, mode() within group (order by play) as play
  from public.rpt_people group by account_key
), acc as (
  select a.id, a.company, lower(btrim(a.company)) as account_key, a.ae, a.play, a.status, a.meeting_status, a.hook,
         a.created_at, a.field_ts,
         nullif(to_jsonb(a) ->> 'stage', '') as stored_stage,
         coalesce((to_jsonb(a) ->> 'stage_changed_at')::timestamptz, (a.field_ts ->> 'stage')::timestamptz) as stored_stage_at
  from public.accounts a where a.deleted_at is null
), base as (
  select coalesce(acc.account_key, ppl.account_key) as account_key,
         coalesce(acc.company, ppl.account) as account,
         acc.id as account_id,
         coalesce(nullif(acc.ae, ''), ppl.ae, 'Unassigned') as ae,
         coalesce(acc.play, ppl.play, 'Unassigned') as play,
         acc.status, acc.meeting_status, acc.hook, acc.created_at, acc.field_ts,
         acc.stored_stage, acc.stored_stage_at,
         coalesce(ppl.people_n, 0) as people_n, coalesce(ppl.engaged_n, 0) as engaged_n, ppl.engaged_at, ppl.meeting_at
  from acc full join ppl on ppl.account_key = acc.account_key
)
select b.account_key, b.account, b.account_id, b.ae, b.play, b.status, b.meeting_status, b.hook, b.people_n, b.engaged_n,
       coalesce(b.stored_stage,
         case when b.status ilike 'hold%' then 'Hold'
              when b.meeting_status ilike 'held%' then 'Meeting held'
              when b.meeting_status ilike 'set%' or b.status ilike 'meeting%' or b.meeting_at is not null then 'Meeting set'
              when b.engaged_n > 0 then 'Engaged'
              when b.people_n >= 4 then 'Mapped'
              when b.people_n >= 1 then 'Researching'
              else 'Target' end) as stage,
       (b.stored_stage is not null) as stage_is_stored,
       coalesce(b.stored_stage_at,
         case when b.stored_stage is not null then null
              when b.meeting_status is not null and b.meeting_status <> '' then (b.field_ts ->> 'meeting_status')::timestamptz
              when b.engaged_n > 0 then b.engaged_at end,
         b.created_at) as stage_since,
       b.stored_stage_at, b.created_at
from base b;

-- ---------- every countable event, one row per (unit, metric) ----------
create or replace view public.rpt_events with (security_invoker = true) as
with col as (
  select r.person_id, r.account_key, m.metric, m.ts
  from public.rpt_people r
  cross join lateral (values ('connect', r.connect_sent), ('accept', r.accepted), ('dm1', r.dm1_sent), ('dm2', r.dm2_sent),
                             ('dm3', r.dm3_sent), ('reply', r.replied), ('meeting', r.meeting), ('withdrawn', r.withdrawn)) m(metric, ts)
  where m.ts is not null
), evmap(event, metric, field) as (
  values ('Connect sent', 'connect', 'connect_sent'), ('Accepted', 'accept', 'accepted'), ('DM1 sent', 'dm1', 'dm1_sent'),
         ('DM2 sent', 'dm2', 'dm2_sent'), ('DM3 sent', 'dm3', 'dm3_sent'), ('Replied', 'reply', 'replied'),
         ('Meeting', 'meeting', 'meeting'), ('Withdrawn', 'withdrawn', 'withdrawn')
), lg as (
  select l.person_id, m.metric, min(l.ts) as ts
  from public.log_entries l join evmap m on m.event = l.event
  where l.person_id is not null
    and not exists (select 1 from public.log_entries u where u.person_id = l.person_id and u.event = 'Undo ' || m.field and u.ts >= l.ts)
  group by 1, 2
), acct_meet_log as (   -- 'Meeting set' lines written for an account (no person): detail starts with the company name
  select (select ra.account_key from public.rpt_accounts ra
          where l.detail ilike ra.account || '%' order by length(ra.account) desc limit 1) as account_key,
         min(l.ts) as ts
  from public.log_entries l
  where l.event in ('Meeting set', 'Meeting') and l.person_id is null
  group by 1
), unioned as (
  select c.person_id as ref, c.person_id, c.account_key, c.metric, c.ts, 'people'::text as src from col c
  union all
  select g.person_id, g.person_id, r.account_key, g.metric, g.ts, 'log'
  from lg g join public.rpt_people r on r.person_id = g.person_id
  where not exists (select 1 from col c where c.person_id = g.person_id and c.metric = g.metric)
  union all   -- meetings are counted per account
  select x.account_key, null, x.account_key, 'meeting', x.ts, 'log' from acct_meet_log x where x.account_key is not null
  union all
  select ra.account_key, null, ra.account_key, 'meeting', coalesce((a.field_ts ->> 'meeting_status')::timestamptz, a.updated_at), 'accounts'
  from public.rpt_accounts ra join public.accounts a on a.id = ra.account_id
  where coalesce(a.meeting_status, '') ~* '^(set|held)'
    and not exists (select 1 from acct_meet_log x where x.account_key = ra.account_key)
  union all   -- account stage moves from 0008's account_stage_history (backfill rows and undone moves are not moves)
  select lower(btrim(h.company)), null, lower(btrim(h.company)), m.metric, h.created_at, 'stage_history'
  from public.account_stage_history h
  cross join lateral (values ('stage_change'), (case when h.source = 'shal' then 'stage_manual' end)) m(metric)
  where h.kind not in ('backfill') and h.undone_at is null and m.metric is not null
  union all   -- meetings / opps reached through a stage move
  select lower(btrim(h.company)), null, lower(btrim(h.company)), case when h.to_stage ilike 'opp%' then 'opp' else 'meeting' end,
         min(h.created_at), 'stage_history'
  from public.account_stage_history h
  where h.undone_at is null and h.kind <> 'backfill' and (h.to_stage ilike 'opp%' or h.to_stage = 'Meeting set')
  group by 1, 4
  union all   -- opps already standing (e.g. backfilled) when no move row exists
  select ra.account_key, null, ra.account_key, 'opp', ra.stage_since, 'accounts'
  from public.rpt_accounts ra
  where ra.stage ilike 'opp%' and ra.stage_since is not null
    and not exists (select 1 from public.account_stage_history h where lower(btrim(h.company)) = ra.account_key
                    and h.to_stage ilike 'opp%' and h.undone_at is null and h.kind <> 'backfill')
  union all   -- Ari's work: drafts written (DM text landed), research done
  select r.person_id || ':' || d.k, r.person_id, r.account_key, 'draft', (r.field_ts ->> d.k)::timestamptz, 'people'
  from public.rpt_people r cross join lateral (values ('dm'), ('dm2_text'), ('dm3_text')) d(k)
  where r.field_ts ? d.k and coalesce(to_jsonb(r) ->> d.k, '') <> ''
  union all
  select l.person_id || ':log:' || l.id, l.person_id, r.account_key, 'draft', l.ts, 'log'
  from public.log_entries l join public.rpt_people r on r.person_id = l.person_id
  where l.event ilike 'Hark draft%'
    and not exists (select 1 from public.rpt_people r2 where r2.person_id = l.person_id and r2.field_ts ? 'dm'
                    and abs(extract(epoch from (r2.field_ts ->> 'dm')::timestamptz - l.ts)) < 3600)
  union all
  select 'q:' || q.id, null, lower(btrim(q.target)), 'signal', q.created, 'queue'
  from public.queue q where q.action in ('New signal', 'Claimable')
  union all
  select ra.account_key, null, ra.account_key, 'account_added', ra.created_at, 'accounts'
  from public.rpt_accounts ra where ra.account_id is not null and ra.created_at > timestamptz '2026-10-15 23:30+05:30'
  union all   -- rows loaded by the first backfill (Oct 15 ~22:50 IST) have no real "added" date, so they are skipped
  select r.person_id, r.person_id, r.account_key, 'person_added', r.created_at, 'people' from public.rpt_people r
  where r.created_at > timestamptz '2026-10-15 23:30+05:30'
), dedup as (   -- meetings and opps: one per account, at the earliest evidence from any source
  select * from unioned where metric not in ('meeting', 'opp')
  union all
  select distinct on (metric, account_key) * from unioned where metric in ('meeting', 'opp') order by metric, account_key, ts
)
select u.metric, u.ref, u.person_id, u.account_key, u.ts, public.rpt_day(u.ts) as day, u.src,
       coalesce(rp.ae, ra.ae, 'Unassigned') as ae, coalesce(rp.play, ra.play, 'Unassigned') as play,
       coalesce(ra.stage, 'Target') as account_stage, coalesce(ra.account, rp.account, u.account_key) as account,
       rp.name as person_name
from dedup u
left join public.rpt_people rp on rp.person_id = u.person_id
left join public.rpt_accounts ra on ra.account_key = u.account_key;

-- metrics counted per account instead of per person
create or replace function public.rpt_unit(p_metric text) returns text language sql immutable as $$
  select case when p_metric in ('meeting', 'opp', 'stage_change', 'stage_manual', 'account_added') then 'account'
              when p_metric = 'signal' then 'signal' else 'person' end $$;

-- filtered events for a date range (the one place filters are applied)
create or replace function public.rpt_filtered(d_from date, d_to date, p_ae text default null, p_play text default null,
                                               p_stage text default null, p_account text default null)
returns setof public.rpt_events language sql stable security invoker set search_path = public as $$
  select e.* from public.rpt_events e
  where e.day between d_from and d_to
    and (p_ae is null or p_ae = '' or lower(e.ae) = lower(split_part(btrim(p_ae), ' ', 1)))
    and (p_play is null or p_play = '' or e.play ilike '%' || p_play || '%')
    and (p_stage is null or p_stage = '' or e.account_stage ilike p_stage || '%')
    and (p_account is null or p_account = '' or e.account ilike '%' || p_account || '%')
$$;

-- ---------- report_summary: every count for a period ----------
-- counts.* = distinct units per metric; dms = dm1 + dm2 + dm3 (messages); touches = distinct people with any of
-- connect/accept/dm/reply; accounts_worked = distinct accounts with any connect/accept/DM/reply/withdraw, meeting, opp
-- or a stage move Owner made (stage_manual). Ari's automatic moves (stage_change) follow a counted touch, so they are
-- reported but do not make an account 'worked' by themselves.
-- rates: accept_rate = accepted (ever) / connects sent in range (cohort); reply_rate = replied (ever) / DM1s sent in
-- range (cohort); *_period variants divide the in-range counts.
create or replace function public.report_summary(p_period text default 'this_week', p_from date default null, p_to date default null,
                                                 p_ae text default null, p_play text default null, p_stage text default null)
returns jsonb language sql stable security invoker set search_path = public as $$
  with rg as (select * from public.rpt_range(p_period, p_from, p_to)),
  ev as (select e.* from rg, public.rpt_filtered(rg.d_from, rg.d_to, p_ae, p_play, p_stage) e),
  touchm(m) as (values ('connect'),('accept'),('dm1'),('dm2'),('dm3'),('reply'),('meeting'),('opp'),('stage_manual'),('withdrawn')),
  c as (
    select jsonb_object_agg(m, (select count(distinct e.ref) from ev e where e.metric = m)) j
    from unnest(array['connect','accept','dm1','dm2','dm3','reply','meeting','opp','withdrawn','stage_change','stage_manual',
                      'draft','signal','account_added','person_added']) m
  ), c2 as (
    select c.j || jsonb_build_object(
      'dms', (c.j ->> 'dm1')::int + (c.j ->> 'dm2')::int + (c.j ->> 'dm3')::int,
      'touches', (select count(distinct person_id) from ev where metric in ('connect','accept','dm1','dm2','dm3','reply')),
      'accounts_worked', (select count(distinct account_key) from ev where metric in (select m from touchm)),
      'drafted_people', (select count(distinct person_id) from ev where metric = 'draft')) j
    from c
  ), coh as (
    select jsonb_build_object(
      'connects', (select count(*) from (select distinct person_id from ev where metric = 'connect') x),
      'accepted', (select count(*) from (select distinct person_id from ev where metric = 'connect') x join public.rpt_people rp using (person_id) where rp.accepted is not null),
      'dm1s', (select count(*) from (select distinct person_id from ev where metric = 'dm1') x),
      'replied', (select count(*) from (select distinct person_id from ev where metric = 'dm1') x join public.rpt_people rp using (person_id) where rp.replied is not null)) j
  ), grp as (
    select 'ae' dim, ae val, metric, ref, account_key from ev union all select 'play', play, metric, ref, account_key from ev
  ), brk as (
    select dim, coalesce(jsonb_agg(jsonb_build_object(dim, val, 'connect', cn, 'accept', ac, 'dms', dm, 'reply', rp, 'meeting', mt,
                                                      'opp', op, 'accounts_worked', aw) order by val), '[]') j
    from (
      select dim, val,
             count(distinct ref) filter (where metric = 'connect') cn, count(distinct ref) filter (where metric = 'accept') ac,
             count(distinct metric || ref) filter (where metric in ('dm1','dm2','dm3')) dm,
             count(distinct ref) filter (where metric = 'reply') rp, count(distinct ref) filter (where metric = 'meeting') mt,
             count(distinct ref) filter (where metric = 'opp') op,
             count(distinct account_key) filter (where metric in (select m from touchm)) aw
      from grp group by dim, val) s
    group by dim
  )
  select jsonb_build_object(
    'range', (select jsonb_build_object('from', d_from, 'to', d_to, 'label', label, 'today', public.rpt_today()) from rg),
    'filters', jsonb_strip_nulls(jsonb_build_object('ae', nullif(p_ae, ''), 'play', nullif(p_play, ''), 'stage', nullif(p_stage, ''))),
    'counts', c2.j,
    'rates', jsonb_build_object(
      'accept_rate', round(100.0 * (coh.j ->> 'accepted')::int / nullif((coh.j ->> 'connects')::int, 0), 1),
      'reply_rate', round(100.0 * (coh.j ->> 'replied')::int / nullif((coh.j ->> 'dm1s')::int, 0), 1),
      'accept_rate_period', round(100.0 * (c2.j ->> 'accept')::int / nullif((c2.j ->> 'connect')::int, 0), 1),
      'reply_rate_period', round(100.0 * (c2.j ->> 'reply')::int / nullif((c2.j ->> 'dm1')::int, 0), 1)),
    'cohort', coh.j,
    'by_ae', coalesce((select j from brk where dim = 'ae'), '[]'),
    'by_play', coalesce((select j from brk where dim = 'play'), '[]'))
  from c2, coh
$$;

-- ---------- report_rows: the people/accounts behind any number (tap-a-number) ----------
-- p_metric: any metric in rpt_events, or 'dms' (dm1+dm2+dm3), 'touches', 'accounts_worked',
--           'accepted_from_connects' / 'replied_from_dm1' (the rate numerators).
create or replace function public.report_rows(p_metric text, p_period text default 'this_week', p_from date default null, p_to date default null,
                                              p_ae text default null, p_play text default null, p_stage text default null, p_account text default null)
returns table(metric text, unit text, person_id text, name text, title text, account text, account_key text, ae text, play text,
              account_stage text, person_stage text, ts timestamptz, day date, src text, linkedin_url text)
language sql stable security invoker set search_path = public as $$
  with rg as (select * from public.rpt_range(p_period, p_from, p_to)),
  ev as (select e.* from rg, public.rpt_filtered(rg.d_from, rg.d_to, p_ae, p_play, p_stage, p_account) e),
  pick as (
    select e.*, row_number() over (partition by
             case when p_metric = 'accounts_worked' then e.account_key when p_metric = 'touches' then e.person_id
                  else e.metric || ':' || e.ref end
           order by e.ts) rn
    from ev e
    where case lower(p_metric)
            when 'dms' then e.metric in ('dm1','dm2','dm3')
            when 'touches' then e.metric in ('connect','accept','dm1','dm2','dm3','reply')
            when 'accounts_worked' then e.metric in ('connect','accept','dm1','dm2','dm3','reply','meeting','opp','stage_manual','withdrawn')
            when 'accepted_from_connects' then e.metric = 'connect' and exists (select 1 from public.rpt_people x where x.person_id = e.person_id and x.accepted is not null)
            when 'replied_from_dm1' then e.metric = 'dm1' and exists (select 1 from public.rpt_people x where x.person_id = e.person_id and x.replied is not null)
            else e.metric = lower(p_metric) end
  )
  select k.metric, public.rpt_unit(k.metric), k.person_id, coalesce(rp.name, k.person_name), rp.title, k.account, k.account_key,
         k.ae, k.play, k.account_stage, rp.stage, k.ts, k.day, k.src, rp.linkedin_url
  from pick k left join public.rpt_people rp on rp.person_id = k.person_id
  where k.rn = 1
  order by k.ts desc
$$;

-- ---------- accounts_worked: accounts with any touch in range, with what happened ----------
create or replace function public.accounts_worked(p_from date default null, p_to date default null, p_ae text default null, p_play text default null)
returns table(account text, account_key text, account_id uuid, ae text, play text, stage text,
              connect int, accept int, dm1 int, dm2 int, dm3 int, reply int, meeting int, opp int, stage_manual int,
              people int, people_names text[], last_touch timestamptz)
language sql stable security invoker set search_path = public as $$
  select ra.account, e.account_key, ra.account_id, max(e.ae), max(e.play), coalesce(ra.stage, 'Target'),
         count(distinct e.ref) filter (where e.metric = 'connect')::int, count(distinct e.ref) filter (where e.metric = 'accept')::int,
         count(distinct e.ref) filter (where e.metric = 'dm1')::int, count(distinct e.ref) filter (where e.metric = 'dm2')::int,
         count(distinct e.ref) filter (where e.metric = 'dm3')::int, count(distinct e.ref) filter (where e.metric = 'reply')::int,
         count(distinct e.ref) filter (where e.metric = 'meeting')::int, count(distinct e.ref) filter (where e.metric = 'opp')::int,
         count(distinct e.ref) filter (where e.metric = 'stage_manual')::int,
         count(distinct e.person_id)::int, array_agg(distinct e.person_name) filter (where e.person_name is not null), max(e.ts)
  from public.rpt_filtered(coalesce(p_from, public.rpt_today()), coalesce(p_to, p_from, public.rpt_today()), p_ae, p_play) e
  left join public.rpt_accounts ra on ra.account_key = e.account_key
  where e.metric in ('connect','accept','dm1','dm2','dm3','reply','meeting','opp','stage_manual','withdrawn')
  group by ra.account, e.account_key, ra.account_id, ra.stage
  order by max(e.ts) desc
$$;

-- ---------- report_series: buckets for charts (8-week trends etc.) ----------
create or replace function public.report_series(p_metric text, p_bucket text default 'week', p_n int default 8,
                                                p_ae text default null, p_play text default null)
returns table(bucket_start date, bucket_end date, value int)
language sql stable security invoker set search_path = public as $$
  with b as (
    select case p_bucket when 'day' then g::date when 'month' then date_trunc('month', g)::date else date_trunc('week', g)::date end s
    from generate_series(
      case p_bucket when 'day' then public.rpt_today() - (p_n - 1)
                    when 'month' then (date_trunc('month', public.rpt_today()) - ((p_n - 1) || ' months')::interval)::date
                    else date_trunc('week', public.rpt_today())::date - 7 * (p_n - 1) end,
      public.rpt_today(),
      case p_bucket when 'day' then interval '1 day' when 'month' then interval '1 month' else interval '1 week' end) g
  ), bk as (
    select s, case p_bucket when 'day' then s when 'month' then (s + interval '1 month')::date - 1 else s + 6 end e from b
  ), ev as (
    select * from public.rpt_filtered((select min(s) from bk), (select max(e) from bk), p_ae, p_play)
  )
  select bk.s, bk.e,
         (case lower(p_metric)
            when 'dms' then (select count(distinct metric || ref) from ev where metric in ('dm1','dm2','dm3') and day between bk.s and bk.e)
            when 'accounts_worked' then (select count(distinct account_key) from ev where metric in ('connect','accept','dm1','dm2','dm3','reply','meeting','opp','stage_manual','withdrawn') and day between bk.s and bk.e)
            when 'touches' then (select count(distinct person_id) from ev where metric in ('connect','accept','dm1','dm2','dm3','reply') and day between bk.s and bk.e)
            else (select count(distinct ref) from ev where metric = lower(p_metric) and day between bk.s and bk.e) end)::int
  from bk order by bk.s
$$;

-- ---------- funnel and time-in-stage (current state, not range-bound) ----------
-- people: entered_at = the timestamp of the stage's own event, else stage_changed_at.
create or replace function public.report_stage_times(p_ae text default null, p_play text default null)
returns table(level text, stage text, n int, avg_days numeric, median_days numeric, max_days numeric, oldest text)
language sql stable security invoker set search_path = public as $$
  with p as (
    select r.stage, r.name || ' (' || r.account || ')' as who,
           extract(epoch from now() - coalesce(case r.stage when 'Connect sent' then r.connect_sent when 'Accepted' then r.accepted
             when 'DM1 sent' then r.dm1_sent when 'DM2 sent' then r.dm2_sent when 'DM3 sent' then r.dm3_sent when 'Replied' then r.replied
             when 'Meeting' then r.meeting when 'Withdrawn' then r.withdrawn end, r.stage_changed_at, r.created_at)) / 86400.0 as d
    from public.rpt_people r
    where (p_ae is null or lower(r.ae) = lower(split_part(btrim(p_ae), ' ', 1))) and (p_play is null or r.play ilike '%' || p_play || '%')
  ), a as (
    select ra.stage, ra.account as who, extract(epoch from now() - ra.stage_since) / 86400.0 as d
    from public.rpt_accounts ra
    where (p_ae is null or lower(ra.ae) = lower(split_part(btrim(p_ae), ' ', 1))) and (p_play is null or ra.play ilike '%' || p_play || '%')
  )
  select 'person', stage, count(*)::int, round(avg(d)::numeric, 1), round((percentile_cont(0.5) within group (order by d))::numeric, 1),
         round(max(d)::numeric, 1), (array_agg(who order by d desc))[1] from p group by stage
  union all
  select 'account', stage, count(*)::int, round(avg(d)::numeric, 1), round((percentile_cont(0.5) within group (order by d))::numeric, 1),
         round(max(d)::numeric, 1), (array_agg(who order by d desc))[1] from a group by stage
  order by 1 desc, 2
$$;

-- ---------- best hooks and DM1 variants by reply rate ----------
-- hook = the account's hook line; dm1_variant = people.extra.variant when the worker tags one, else the DM1's angle
-- (Hiring signal, Funding / deal, Launch / release, Their post / talk, News / filing, Other angle) read from its text. Cohort = DM1s sent in range.
create or replace function public.report_hooks(p_period text default 'last_8w', p_from date default null, p_to date default null,
                                               p_ae text default null, p_play text default null, p_min_sent int default 1)
returns table(kind text, label text, dm1_sent int, replied int, reply_rate numeric, accepted int)
language sql stable security invoker set search_path = public as $$
  with rg as (select * from public.rpt_range(p_period, p_from, p_to)),
  c as (
    select distinct e.person_id from rg, public.rpt_filtered(rg.d_from, rg.d_to, p_ae, p_play) e where e.metric = 'dm1'
  ), x as (
    select rp.*, coalesce(nullif(p.extra ->> 'variant', ''),
             case when coalesce(rp.dm, '') = '' then '(no DM text)'
                  when rp.dm ~* '\mhiring|job post|open role|\mrole\M' then 'Hiring signal'
                  when rp.dm ~* 'rais|funding|series [a-e]|acqui|\mdeal|partnership' then 'Funding / deal'
                  when rp.dm ~* 'launch|releas|shipped|announc|rolled out|\mGA\M' then 'Launch / release'
                  when rp.dm ~* '\mpost|talk|podcast|webinar|interview|keynote|panel|wrote|article|blog' then 'Their post / talk'
                  when rp.dm ~* '\mnews|report|filing|10-k|press' then 'News / filing'
                  else 'Other angle' end) as opener
    from c join public.rpt_people rp using (person_id) join public.people p on p.id = rp.person_id
  )
  select * from (
    select 'hook'::text as k, coalesce(nullif(hook, ''), '(no hook)') as l, count(*)::int as sent, count(*) filter (where replied is not null)::int as rep,
           round(100.0 * count(*) filter (where replied is not null) / nullif(count(*), 0), 1) as rr, count(*) filter (where accepted is not null)::int as acc
    from x group by 2
    union all
    select 'dm1_variant', coalesce(nullif(opener, ''), '(no DM text)'), count(*)::int, count(*) filter (where replied is not null)::int,
           round(100.0 * count(*) filter (where replied is not null) / nullif(count(*), 0), 1), count(*) filter (where accepted is not null)::int
    from x group by 2
  ) s where s.sent >= p_min_sent
  order by 1, 5 desc nulls last, 3 desc
$$;

-- ---------- grants: owner (via RLS) and Hark; never anon ----------
do $$
declare f text;
begin
  foreach f in array array[
    'public.rpt_day(timestamptz)', 'public.rpt_today()', 'public.rpt_range(text, date, date)', 'public.rpt_unit(text)',
    'public.rpt_filtered(date, date, text, text, text, text)',
    'public.report_summary(text, date, date, text, text, text)',
    'public.report_rows(text, text, date, date, text, text, text, text)',
    'public.accounts_worked(date, date, text, text)',
    'public.report_series(text, text, int, text, text)',
    'public.report_stage_times(text, text)',
    'public.report_hooks(text, date, date, text, text, int)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on public.rpt_people, public.rpt_accounts, public.rpt_events from public, anon;
grant select on public.rpt_people, public.rpt_accounts, public.rpt_events to authenticated, service_role;

notify pgrst, 'reload schema';
