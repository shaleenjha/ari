-- Ari v18.1 (Oct 16 2026): one-call Report dashboard, stage filter on trends, account health score,
-- stale detector, weekly digest push. Requires 0009 (reporting layer) and 0002/0003 (push).
-- Re-runnable: drops and recreates its own objects only. Existing 0009 RPCs keep their names and results;
-- report_series gains an optional p_stage (old 5-argument calls still resolve).
-- Definitions: plans/ari-reporting.md ("v18.1 additions").

-- ---------- one evaluation of rpt_events per dashboard call ----------
-- rpt_filtered (0009) is the one place every report function reads events from. Inside report_dashboard the events are
-- read once into a transaction-local temp table and rpt_filtered reads that copy, so the 17 numbers in one call share
-- a single evaluation of the view (and of its RLS checks). Outside report_dashboard nothing changes.

create or replace function public.rpt_filtered(d_from date, d_to date, p_ae text default null, p_play text default null,
                                               p_stage text default null, p_account text default null)
returns setof public.rpt_events language plpgsql stable security invoker set search_path = public as $$
begin
  if coalesce(current_setting('ari.rpt_cache', true), '') = '1' and to_regclass('pg_temp.rpt_ev_cache') is not null then
    return query select e.* from pg_temp.rpt_ev_cache e
      where e.day between d_from and d_to
        and (p_ae is null or p_ae = '' or lower(e.ae) = lower(split_part(btrim(p_ae), ' ', 1)))
        and (p_play is null or p_play = '' or e.play ilike '%' || p_play || '%')
        and (p_stage is null or p_stage = '' or e.account_stage ilike p_stage || '%')
        and (p_account is null or p_account = '' or e.account ilike '%' || p_account || '%');
  else
    return query select e.* from public.rpt_events e
      where e.day between d_from and d_to
        and (p_ae is null or p_ae = '' or lower(e.ae) = lower(split_part(btrim(p_ae), ' ', 1)))
        and (p_play is null or p_play = '' or e.play ilike '%' || p_play || '%')
        and (p_stage is null or p_stage = '' or e.account_stage ilike p_stage || '%')
        and (p_account is null or p_account = '' or e.account ilike '%' || p_account || '%');
  end if;
end $$;
revoke all on function public.rpt_filtered(date, date, text, text, text, text) from public, anon;
grant execute on function public.rpt_filtered(date, date, text, text, text, text) to authenticated, service_role;

-- ---------- report_series: same as 0009 plus p_stage (account stage prefix, like report_summary) ----------
drop function if exists public.report_series(text, text, int, text, text);
drop function if exists public.report_series(text, text, int, text, text, text);
create or replace function public.report_series(p_metric text, p_bucket text default 'week', p_n int default 8,
                                                p_ae text default null, p_play text default null, p_stage text default null)
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
    select * from public.rpt_filtered((select min(s) from bk), (select max(e) from bk), p_ae, p_play, p_stage)
  )
  select bk.s, bk.e,
         (case lower(p_metric)
            when 'dms' then (select count(distinct metric || ref) from ev where metric in ('dm1','dm2','dm3') and day between bk.s and bk.e)
            when 'accounts_worked' then (select count(distinct account_key) from ev where metric in ('connect','accept','dm1','dm2','dm3','reply','meeting','opp','stage_manual','withdrawn') and day between bk.s and bk.e)
            when 'touches' then (select count(distinct person_id) from ev where metric in ('connect','accept','dm1','dm2','dm3','reply') and day between bk.s and bk.e)
            else (select count(distinct ref) from ev where metric = lower(p_metric) and day between bk.s and bk.e) end)::int
  from bk order by bk.s
$$;

-- ---------- account health: 0 to 100 per account ----------
-- recency 30 (last touch today = 30, falls to 0 at 14 days), accepts 20 (3+ accepted people = 20),
-- replies 20 (2+ replied people = 20), stage progress 15 (Target 0 ... Opportunity created 15),
-- coverage 15 (3 points per mapped person, 5 people = 15). Touch = connect, accept, DM, reply, withdraw,
-- meeting, opp, or a stage move Owner made. Side states (Hold, Closed lost, Not a fit) band as Parked.
-- Bands: Strong >= 70, Steady 45-69, Cooling 25-44, Cold < 25.
drop function if exists public.ari_stale(text);
drop function if exists public.account_health(text);
create or replace function public.account_health(p_ae text default null)
returns table(account_key text, account text, account_id uuid, ae text, stage text, score int, band text,
              pts_recency int, pts_accepts int, pts_replies int, pts_stage int, pts_coverage int,
              people int, accepted int, replied int, last_touch timestamptz, days_quiet int, gap text)
language sql stable security invoker set search_path = public as $$
  with ev as (
    select e.account_key, max(e.ts) as lt
    from public.rpt_filtered(date '2000-01-01', date '2100-01-01') e
    where e.metric in ('connect','accept','dm1','dm2','dm3','reply','meeting','opp','stage_manual','withdrawn')
    group by 1
  ), pp as (
    select r.account_key, count(*)::int as n, count(*) filter (where r.accepted is not null)::int as acc,
           count(*) filter (where r.replied is not null)::int as rep
    from public.rpt_people r group by 1
  ), rax as materialized (select * from public.rpt_accounts
  ), b as (
    select ra.account_key, ra.account, ra.account_id, ra.ae, ra.stage, coalesce(pp.n, 0) as n, coalesce(pp.acc, 0) as acc,
           coalesce(pp.rep, 0) as rep, ev.lt,
           case when ev.lt is null then null else floor(extract(epoch from now() - ev.lt) / 86400)::int end as dq
    from rax ra
    left join pp on pp.account_key = ra.account_key
    left join ev on ev.account_key = ra.account_key
    where ra.account_key <> '(no company)'
      and (p_ae is null or p_ae = '' or lower(ra.ae) = lower(split_part(btrim(p_ae), ' ', 1)))
  ), s as (
    select b.*,
           case when dq is null then 0 else greatest(0, round(30 * (1 - least(dq, 14) / 14.0)))::int end as r,
           round(least(acc, 3) * 20 / 3.0)::int as e,
           (least(rep, 2) * 10)::int as p,
           case b.stage when 'Researching' then 3 when 'Mapped' then 6 when 'Engaged' then 9 when 'Meeting set' then 12
                        when 'Meeting held' then 14 when 'Opportunity created' then 15 when 'Customer' then 15 else 0 end as g,
           (least(n, 5) * 3)::int as c
    from b
  )
  select s.account_key, s.account, s.account_id, s.ae, s.stage, (s.r + s.e + s.p + s.g + s.c)::int,
         case when s.stage in ('Hold', 'Closed lost', 'Not a fit') then 'Parked'
              when s.r + s.e + s.p + s.g + s.c >= 70 then 'Strong' when s.r + s.e + s.p + s.g + s.c >= 45 then 'Steady'
              when s.r + s.e + s.p + s.g + s.c >= 25 then 'Cooling' else 'Cold' end,
         s.r, s.e, s.p, s.g, s.c, s.n, s.acc, s.rep, s.lt, s.dq,
         case when s.stage in ('Hold', 'Closed lost', 'Not a fit') then 'On the side'
              when s.n = 0 then 'No people mapped yet'
              when s.dq is null then 'Nobody touched yet'
              when s.dq >= 7 then 'No touch in ' || s.dq || ' days'
              when s.n < 4 then 'Only ' || s.n || ' of 4 to 5 people mapped'
              when s.acc = 0 then 'No accepts yet'
              when s.rep = 0 then 'No replies yet'
              else 'On track' end
  from s
  order by 6 desc, 2
$$;

-- ---------- stale detector: people and accounts going cold, each with a next step ----------
-- dm2_overdue / dm3_overdue (prio 1): DM sent, the next one's due date has passed, no reply.
-- accepted_no_dm1 (2): accepted more than 2 days ago, no DM1.
-- engaged_quiet (3): account stage Engaged, no touch for 7+ days.
-- connect_withdraw (4): invite pending more than 14 days: withdraw it.
-- Left out: personal and pending-review people, skipped, snoozed, Hold/Founder lane, withdrawn, replied, meeting,
-- and people at accounts that hold outreach (Meeting set/held, Opportunity, Hold, Customer, Closed lost, Not a fit).
create or replace function public.ari_stale(p_ae text default null)
returns table(kind text, prio int, person_id text, name text, title text, account text, account_key text, account_id uuid,
              ae text, since timestamptz, days int, due date, next_step text, detail text)
language sql stable security invoker set search_path = public as $$
  with t as (select public.rpt_today() as d),
  ra as materialized (select x.account_key, x.stage from public.rpt_accounts x),
  rpm as materialized (select * from public.rpt_people),
  pl as (
    select rp.person_id, rp.name, rp.title, rp.account, rp.account_key, rp.account_id, rp.ae, rp.connect_sent, rp.accepted,
           rp.dm1_sent, rp.dm2_sent, rp.dm3_sent, rp.dm, rp.dm2_text, rp.dm3_text, p.dm2_due, p.dm3_due
    from rpm rp
    join public.people p on p.id = rp.person_id
    left join ra on ra.account_key = rp.account_key
    where coalesce(rp.review, 'lead') = 'lead' and p.skipped is null
      and (p.snooze_until is null or p.snooze_until <= (select d from t))
      and coalesce(rp.stage, '') not in ('Hold', 'Founder', 'Withdrawn', 'Personal') and coalesce(lower(p.lane), 'shal') <> 'founder'
      and rp.withdrawn is null and rp.replied is null and rp.meeting is null
      and coalesce(ra.stage, '') not in ('Meeting set', 'Meeting held', 'Opportunity created', 'Hold', 'Customer', 'Closed lost', 'Not a fit')
      and (p_ae is null or p_ae = '' or lower(rp.ae) = lower(split_part(btrim(p_ae), ' ', 1)))
  ), x as (
    select 'dm2_overdue'::text as k, 1 as pr, pl.*, pl.dm1_sent as since_ts, coalesce(pl.dm2_due, public.rpt_day(pl.dm1_sent) + 4) as due_d,
           case when coalesce(pl.dm2_text, '') <> '' then 'Send DM2. The draft is ready' else 'Send DM2' end as ns
    from pl where pl.dm1_sent is not null and pl.dm2_sent is null and coalesce(pl.dm2_due, public.rpt_day(pl.dm1_sent) + 4) < (select d from t)
    union all
    select 'dm3_overdue', 1, pl.*, pl.dm2_sent, coalesce(pl.dm3_due, public.rpt_day(pl.dm2_sent) + 7),
           case when coalesce(pl.dm3_text, '') <> '' then 'Send DM3. The draft is ready' else 'Send DM3' end
    from pl where pl.dm2_sent is not null and pl.dm3_sent is null and coalesce(pl.dm3_due, public.rpt_day(pl.dm2_sent) + 7) < (select d from t)
    union all
    select 'accepted_no_dm1', 2, pl.*, pl.accepted, public.rpt_day(pl.accepted) + 2,
           case when coalesce(pl.dm, '') <> '' then 'Send DM1. The draft is ready' else 'Send DM1. Ask Ari for a draft' end
    from pl where pl.accepted is not null and pl.dm1_sent is null and pl.accepted < now() - interval '2 days'
    union all
    select 'connect_withdraw', 4, pl.*, pl.connect_sent, public.rpt_day(pl.connect_sent) + 14, 'Withdraw the invite'
    from pl where pl.connect_sent is not null and pl.accepted is null and pl.connect_sent < now() - interval '14 days'
  )
  select x.k, x.pr, x.person_id, x.name, x.title, x.account, x.account_key, x.account_id, x.ae, x.since_ts,
         floor(extract(epoch from now() - x.since_ts) / 86400)::int, x.due_d, x.ns,
         case x.k when 'dm2_overdue' then 'DM2 was due ' || to_char(x.due_d, 'Mon FMDD')
                  when 'dm3_overdue' then 'DM3 was due ' || to_char(x.due_d, 'Mon FMDD')
                  when 'accepted_no_dm1' then 'Accepted ' || floor(extract(epoch from now() - x.since_ts) / 86400)::int || ' days ago, no DM1'
                  else 'Invite pending ' || floor(extract(epoch from now() - x.since_ts) / 86400)::int || ' days' end
  from x
  union all
  select 'engaged_quiet', 3, null, null, null, h.account, h.account_key, h.account_id, h.ae, h.last_touch, h.days_quiet, null,
         'Touch someone at ' || h.account || ': a follow-up or a new connect',
         case when h.days_quiet is null then 'Engaged, nobody touched yet' else 'Engaged, no touch in ' || h.days_quiet || ' days' end
  from public.account_health(p_ae) h
  where h.stage = 'Engaged' and (h.days_quiet is null or h.days_quiet >= 7)
  order by 2, 11 desc nulls last, 4
$$;

-- ---------- report_dashboard: everything the Report tab needs in one call ----------
-- Keys match the app's loader: S (period summary), T/W/M (today, this week, this month), P (comparison range),
-- st (stage times), dc/dd/da (connects/DMs/accepts per day), aw (accounts worked) = part 'first';
-- wc/wa/wd/wr/wm (8-week series), hm (touches per day, heatmap), hk (hooks), health, stale = part 'more'.
-- p_part: all | first (= hero + side) | more (= trend + extra) | hero (S,T,W,M,P) | side (st,dc,dd,da,aw) | trend (wc..wm, hm) |
-- extra (hk, health, stale). The app sends hero, side, trend and extra at once (four connections in parallel), so the hero
-- paints on the first one back.
-- Every value is the existing 0009/0010 function with the same arguments, so numbers equal the single RPCs.
-- Stage filter: applied to summaries and series (account stage prefix); stage times, accounts worked and hooks
-- take AE/play only (the app filters accounts worked by stage itself), as in v18.
drop function if exists public.report_dashboard(text, date, date, text, text, text, text, date, date, int, int, date, date);
create or replace function public.report_dashboard(p_period text default 'today', p_from date default null, p_to date default null,
                                                   p_ae text default null, p_play text default null, p_stage text default null,
                                                   p_part text default 'all', p_prev_from date default null, p_prev_to date default null,
                                                   p_days int default null, p_heat_days int default null,
                                                   p_aw_from date default null, p_aw_to date default null)
returns jsonb language plpgsql volatile security invoker set search_path = public as $$
declare
  rg record; t date := public.rpt_today(); n_len int; pf date; pt date; nd int; nh int; af date; at2 date;
  part text := lower(coalesce(nullif(p_part, ''), 'all')); r jsonb := '{}'::jsonb; t0 timestamptz := clock_timestamp();
begin
  if to_regclass('pg_temp.rpt_ev_cache') is null then
    create temp table rpt_ev_cache on commit drop as select * from public.rpt_events;
  else
    truncate pg_temp.rpt_ev_cache; insert into pg_temp.rpt_ev_cache select * from public.rpt_events;
  end if;
  perform set_config('ari.rpt_cache', '1', true);
  select * into rg from public.rpt_range(p_period, p_from, p_to);
  n_len := greatest(1, least(rg.d_to, t) - rg.d_from + 1);
  pt := coalesce(p_prev_to, rg.d_from - 1); pf := coalesce(p_prev_from, pt - n_len + 1);
  nd := greatest(1, least(coalesce(p_days, 7), 400)); nh := greatest(1, least(coalesce(p_heat_days, 84), 400));
  af := coalesce(p_aw_from, rg.d_from); at2 := coalesce(p_aw_to, least(rg.d_to, t));
  if part in ('all', 'first', 'hero') then
    r := r || jsonb_build_object(
      'S', public.report_summary(p_period, p_from, p_to, p_ae, p_play, p_stage),
      'T', public.report_summary('today', null, null, p_ae, p_play, p_stage),
      'W', public.report_summary('this_week', null, null, p_ae, p_play, p_stage),
      'M', public.report_summary('this_month', null, null, p_ae, p_play, p_stage),
      'P', public.report_summary('custom', pf, pt, p_ae, p_play, p_stage));
  end if;
  if part in ('all', 'first', 'side') then
    r := r || jsonb_build_object(
      'st', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.report_stage_times(p_ae, p_play) x),
      'dc', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('connect', 'day', nd, p_ae, p_play, p_stage) x),
      'dd', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('dms', 'day', nd, p_ae, p_play, p_stage) x),
      'da', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('accept', 'day', nd, p_ae, p_play, p_stage) x),
      'aw', case when rg.d_from <= t then (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.accounts_worked(af, at2, p_ae, p_play) x) else '[]'::jsonb end);
  end if;
  if part in ('all', 'more', 'trend') then
    r := r || jsonb_build_object(
      'wc', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('connect', 'week', 8, p_ae, p_play, p_stage) x),
      'wa', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('accept', 'week', 8, p_ae, p_play, p_stage) x),
      'wd', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('dms', 'week', 8, p_ae, p_play, p_stage) x),
      'wr', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('reply', 'week', 8, p_ae, p_play, p_stage) x),
      'wm', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('meeting', 'week', 8, p_ae, p_play, p_stage) x),
      'hm', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('touches', 'day', nh, p_ae, p_play, p_stage) x));
  end if;
  if part in ('all', 'more', 'extra') then
    r := r || jsonb_build_object(
      'hk', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.report_hooks('last_8w', null, null, p_ae, p_play, 1) x),
      'health', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.account_health(p_ae) x),
      'stale', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.ari_stale(p_ae) x));
  end if;
  perform set_config('ari.rpt_cache', '', true);
  return r || jsonb_build_object('part', part, 'range', jsonb_build_object('from', rg.d_from, 'to', rg.d_to, 'today', t, 'prev_from', pf, 'prev_to', pt),
                                 'ms', round(extract(epoch from clock_timestamp() - t0) * 1000));
end $$;

-- ---------- weekly digest push (Friday evening your time) ----------
-- Builds "this week" from report_summary + ari_stale and queues one notification of kind 'digest'
-- (dedupe weekly:<monday>, so a second run in the same week does nothing). The notifications insert trigger from
-- 0003 pokes the ari-push edge function, which delivers to every active subscription that accepts 'digest'.
-- p_dry = true returns the text without queueing anything. NOT scheduled by this migration; to switch it on run
-- (pg_cron, UTC; 13:30 UTC = 19:00 IST Friday):
--   select cron.schedule('ari-weekly-digest', '30 13 * * 5', $c$select public.ari_weekly_digest()$c$);
alter table public.notifications drop constraint if exists notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('accepted','replied','meeting','research_done','draft_due','digest','test'));
alter table public.push_subscriptions alter column kinds set default '{accepted,replied,meeting,research_done,draft_due,digest,test}'::text[];
update public.push_subscriptions set kinds = kinds || '{digest}'::text[] where kinds is not null and not ('digest' = any(kinds)) and 'draft_due' = any(kinds);
do $$ begin
  if to_regclass('public.push_tokens') is not null then
    execute $q$alter table public.push_tokens alter column kinds set default '{accepted,replied,meeting,research_done,draft_due,digest,test}'::text[]$q$;
    execute $q$update public.push_tokens set kinds = kinds || '{digest}'::text[] where kinds is not null and not ('digest' = any(kinds)) and 'draft_due' = any(kinds)$q$;
  end if;
end $$;

drop function if exists public.ari_weekly_digest(boolean);
create or replace function public.ari_weekly_digest(p_dry boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare s jsonb; c jsonb; t date := public.rpt_today(); wk date := date_trunc('week', public.rpt_today())::date;
        n_stale int; title text; body text; k text; mt int; ar numeric;
begin
  s := public.report_summary('this_week'); c := s -> 'counts';
  select count(*) into n_stale from public.ari_stale();
  mt := coalesce((c ->> 'meeting')::int, 0); ar := (s -> 'rates' ->> 'accept_rate_period')::numeric;
  title := 'Your week: ' || coalesce(c ->> 'connect', '0') || ' of 75 connects';
  body := coalesce(c ->> 'dms', '0') || ' DMs, ' || coalesce(c ->> 'accept', '0') || ' accepts'
          || coalesce(' (' || round(ar) || '% of connects)', '') || ', '
          || coalesce(c ->> 'reply', '0') || ' repl' || case when coalesce((c ->> 'reply')::int, 0) = 1 then 'y' else 'ies' end || ', '
          || mt || ' meeting' || case when mt = 1 then '' else 's' end || ' of 3 to 4.'
          || case when n_stale > 0 then ' ' || n_stale || ' going cold, first steps are in Today.' else ' Nothing going cold.' end;
  k := 'weekly:' || wk;
  if not p_dry then
    perform public.ari_notify('digest', k, title, body, '/ops?open=report', null, null);
  end if;
  return jsonb_build_object('title', title, 'body', body, 'key', k, 'dry', p_dry, 'week_from', wk, 'as_of', t,
                            'counts', c, 'stale', n_stale);
end $$;

-- ---------- RLS speed: evaluate is_owner() once per query, not once per row ----------
-- Same predicate (owner only); wrapping it in a scalar subquery lets Postgres run it as an initPlan.
-- Before: report_summary as the owner ~1.7 s (35 ms as service role); the dashboard hit the 8 s statement timeout.
do $$
declare p record; q text;
begin
  for p in select schemaname, tablename, policyname, qual, with_check from pg_policies where schemaname = 'public' loop
    q := null;
    if p.qual = 'is_owner()' and p.with_check = 'is_owner()' then
      q := format('alter policy %I on %I.%I using ((select public.is_owner())) with check ((select public.is_owner()))', p.policyname, p.schemaname, p.tablename);
    elsif p.qual = 'is_owner()' and p.with_check is null then
      q := format('alter policy %I on %I.%I using ((select public.is_owner()))', p.policyname, p.schemaname, p.tablename);
    elsif p.qual is null and p.with_check = 'is_owner()' then
      q := format('alter policy %I on %I.%I with check ((select public.is_owner()))', p.policyname, p.schemaname, p.tablename);
    end if;
    if q is not null then execute q; end if;
  end loop;
end $$;

-- ---------- grants: owner (RLS) and Hark; digest is service_role only ----------
do $$
declare f text;
begin
  foreach f in array array[
    'public.report_series(text, text, int, text, text, text)',
    'public.account_health(text)',
    'public.ari_stale(text)',
    'public.report_dashboard(text, date, date, text, text, text, text, date, date, int, int, date, date)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
revoke all on function public.ari_weekly_digest(boolean) from public, anon, authenticated;
grant execute on function public.ari_weekly_digest(boolean) to service_role;

notify pgrst, 'reload schema';
