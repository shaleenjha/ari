-- 0048 push digest = Today's move total (Owner Oct 29 2026). WRITTEN, NOT APPLIED ANYWHERE.
-- Revised Oct 29 ~22:30 IST: invite withdraw retired by Owner ("stop the withdraw feature"); old invites are no longer a move,
-- so the total is replies + messages + today's invites only, matching web/ops.html v18.14.8 items().
-- Why: the 21:00 IST digest (cron ari-due-digest -> ari_due_digest()) counted every accepted person without a first message,
-- plus DM2/DM3 by their stored due dates only, and said "27 follow-ups due tonight / 20 DM1, 7 DM3. Ready when you are."
-- The app's Today counts something else: ariV1812.items() in web/ops.html (the Today tab badge, "1 of N" and the ui5 hero all
-- read it). This migration makes the push read the same total with the same rules, and speak plain words:
--   title  "<N> move(s) ready"              N = the move total (replies + messages + today's invites)
--   body   "About <M> minutes. Replies first."   M = max(1, round(1.2 x moves to send)), the Today hero line; "Replies first."
--          only when a reply is waiting. Every move is one to send (no withdraw moves since v18.14.8).
-- What it mirrors (web/ops.html v18.14.8, model() + ariModel wrapper + ariV1812 items()), per person (not deleted, has a name,
-- not review 'personal'):
--   effective stage: queue 'send to founder' / 'take back from founder' (latest 200 queue rows, the oldest action wins, as the
--   client's forEach does), else the exec track (stage or route naming the exec, lane founder/exec), else 'Hold' when the
--   person's company matches (normCo) an account with meeting_status 'set' and they have not replied or met.
--   one item: pending review, Hold/exec stage, meeting, withdrawn or skipped -> none; replied -> Reply; DM3 sent -> none;
--   DM2 sent -> Last note when dm3_due (or DM2 + 7 days) <= day; DM1 sent -> Follow-up when dm2_due (or DM1 + 4) <= day;
--   accepted -> First message; invite sent -> none (waiting on the accept; withdraw retired); snoozed past the day -> none;
--   exec-track -> none.
--   Follow-ups at most 4 per company per day. Connects come only from Today's invites (ari_today15) less skipped/sent/exec.
--   Reply items for people who already have an open relay reply (ari_replies_open) count once, as the relay row.
--   Timestamps are compared as their UTC date (the client reads the first 10 characters of the ISO string).
--   "day" = the shift date (IST minus 6 hours), as shiftDate() in the client; Today's invites use IST today (p_day null).
-- Lock profile: create or replace function only (pg_proc). No table, policy, grant on a table, cron job or data changes.
-- Re-runnable; the ledger row is written last. Rollback: 0048_push_moves_digest_rollback.sql (restores the 0002 digest).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regprocedure('public.ari_notify(text,text,text,text,text,text,uuid)') is null
     or to_regprocedure('public.ari_today15(date,integer)') is null or to_regprocedure('public.ari_replies_open(integer)') is null
     or to_regprocedure('public.ari_due_digest()') is null then
    raise exception '0048 needs ari_notify, ari_today15, ari_replies_open and ari_due_digest (0002, 0003, 0014)';
  end if;
end $$;

-- 1. normCo() from web/ops.html, word for word (\y is the Postgres word boundary, JS \b).
create or replace function public.ari_norm_co(s text) returns text
language sql immutable set search_path = public as $$
  select regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(
                 regexp_replace(
                   regexp_replace(
                     regexp_replace(lower(coalesce(s, '')), '\(.*?\)', ' ', 'g'),
                   'https?://(www\.)?', ''),
                 '\.(com|io|ai|co|health|inc)\y', ' ', 'g'),
               '&', ' and ', 'g'),
             '[^a-z0-9 ]+', ' ', 'g'),
           '\y(inc|incorporated|llc|ltd|limited|corp|corporation|co|company|the|holdings|group|ai|technologies|technology|labs|hq)\y', ' ', 'g'),
         '\s+', '', 'g');
$$;

-- 2. The move total, the same number Today shows. Returns the parts so a check can see each one.
create or replace function public.ari_move_total(p_day date default null) returns jsonb
language sql stable security invoker set search_path = public as $$
with cfg as (select coalesce(p_day, ((now() at time zone 'Asia/Kolkata') - interval '6 hours')::date) as sd),
q200 as (select * from public.queue order by created desc limit 200),
anq as (
  select distinct on (btrim(target)) btrim(target) as target,
         case when lower(btrim(action)) = 'send to founder' then 'send' else 'back' end as act
  from q200
  where lower(btrim(action)) in ('send to founder', 'take back from founder') and coalesce(btrim(target), '') <> ''
    and coalesce(status, '') !~* '^blocked'
  order by btrim(target), created asc
),
meet as (select distinct public.ari_norm_co(company) as k from public.accounts
         where deleted_at is null and lower(btrim(coalesce(meeting_status, ''))) = 'set'),
pp as (
  select p.id, p.company, p.review, p.stage, p.skipped, p.snooze_until, p.connect_day, p.dm2_due, p.dm3_due,
         (p.connect_sent at time zone 'UTC')::date as cs, (p.accepted at time zone 'UTC')::date as ac,
         (p.dm1_sent at time zone 'UTC')::date as d1, (p.dm2_sent at time zone 'UTC')::date as d2,
         (p.dm3_sent at time zone 'UTC')::date as d3,
         p.replied is not null as rp, p.meeting is not null as mt, p.withdrawn is not null as wd,
         (coalesce(p.stage, '') ~* 'founder' or coalesce(p.route, '') ~* 'founder' or coalesce(p.lane, '') ~* '^(founder|exec)') as is_exec,
         a.act
  from public.people p left join anq a on a.target = p.id
  where p.deleted_at is null and coalesce(p.name, '') <> '' and lower(btrim(coalesce(p.review, ''))) <> 'personal'
),
st as (
  select pp.*,
         case when act = 'send' then 'Founder'
              when act = 'back' then case when coalesce(stage, '') ~* '^founder$' then '' else coalesce(stage, '') end
              when is_exec then 'Founder'
              when public.ari_norm_co(company) in (select k from meet) and not rp and not mt and coalesce(stage, '') !~* '^hold$' then 'Hold'
              else coalesce(stage, '') end as est
  from pp
),
it as (
  select st.*,
         case when lower(btrim(coalesce(review, ''))) = 'pending' then null
              when est ~* '^(hold|founder)$' then null
              when mt or wd then null
              when skipped is not null then null
              when rp then 'REPLY'
              when d3 is not null then null
              when d2 is not null then case when coalesce(dm3_due, d2 + 7) <= (select sd from cfg) then 'DM3' end
              when d1 is not null then case when coalesce(dm2_due, d1 + 4) <= (select sd from cfg) then 'DM2' end
              when ac is not null then 'DM1'
              when cs is not null then null                     -- waiting on the accept (invite withdraw retired Oct 29)
              when est ~* 'connect queued' or est = '' then case when connect_day <= (select sd from cfg) then 'CONNECT' end
         end as tag
  from st
),
q as (
  select * from it
  where tag is not null and tag <> 'CONNECT'          -- Today's invites replace the model's connects
    and not (snooze_until is not null and snooze_until > (select sd from cfg))
    and not is_exec
),
relay as (select r.person_id from public.ari_replies_open(20) r),
dm2 as (select least(count(*), 4) as n from q where tag = 'DM2' group by lower(btrim(coalesce(company, '')))),
con as (
  select distinct t.person_id from public.ari_today15(p_day, null) t left join public.people p on p.id = t.person_id
  where p.id is null or p.deleted_at is not null
     or (p.skipped is null and p.connect_sent is null
         and not (coalesce(p.stage, '') ~* 'founder' or coalesce(p.route, '') ~* 'founder' or coalesce(p.lane, '') ~* '^(founder|exec)'))
),
n as (
  select (select count(*) from relay)::int as relay,
         (select count(*) from q where tag = 'REPLY' and id not in (select coalesce(person_id, '') from relay))::int as reply,
         (select count(*) from q where tag = 'DM1')::int as dm1,
         coalesce((select sum(n) from dm2), 0)::int as dm2,
         (select count(*) from q where tag = 'DM3')::int as dm3,
         (select count(*) from con)::int as connects
)
select jsonb_build_object(
  'day', (select sd from cfg),
  'total', relay + reply + dm1 + dm2 + dm3 + connects,
  'to_send', relay + reply + dm1 + dm2 + dm3 + connects,
  'replies', relay + reply, 'dm1', dm1, 'dm2', dm2, 'dm3', dm3, 'connects', connects)
from n;
$$;

-- 3. The push words, from the parts (Today's hero line: "About M minutes. Replies first.").
create or replace function public.ari_move_push_copy(p jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select jsonb_build_object(
    'title', x.n || ' move' || case when x.n = 1 then '' else 's' end || ' ready',
    'body', 'About ' || x.m || ' minute' || case when x.m = 1 then '' else 's' end || '.'
            || case when x.r > 0 then ' Replies first.' else '' end)
  from (select coalesce((p ->> 'total')::int, 0) as n, coalesce((p ->> 'to_send')::int, 0) as s,
               coalesce((p ->> 'replies')::int, 0) as r,
               greatest(1, round(coalesce((p ->> 'to_send')::numeric, 0) * 1.2))::int as m) x;
$$;

-- 4. The 21:00 IST digest: same cron job, same kind and dedupe key ('digest:<IST date>', one per day), new count and words.
create or replace function public.ari_due_digest() returns int language plpgsql security definer set search_path = public as $$
declare today date := (now() at time zone 'Asia/Kolkata')::date; m jsonb; c jsonb; total int;
begin
  m := public.ari_move_total(null);
  total := coalesce((m ->> 'total')::int, 0);
  if total > 0 then
    c := public.ari_move_push_copy(m);
    perform public.ari_notify('draft_due', 'digest:' || today, c ->> 'title', c ->> 'body', '/ops', null, null);
  end if;
  return total;
end $$;

revoke all on function public.ari_norm_co(text) from public, anon, authenticated;
revoke all on function public.ari_move_total(date) from public, anon, authenticated;
revoke all on function public.ari_move_push_copy(jsonb) from public, anon, authenticated;
revoke all on function public.ari_due_digest() from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.ari_move_total(date), public.ari_move_push_copy(jsonb), public.ari_norm_co(text),
      public.ari_due_digest() to service_role;
  end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0048', 'push_moves_digest') on conflict do nothing;
commit;
