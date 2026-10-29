-- 0049 Live Ask Kyte chat (PENDING, WRITTEN Oct 30 2026; staging only until Owner says otherwise). Needs 0041 (AI layer) and 0033
-- (workspace_id). Rollback: 0049_ai_chat_rollback.sql. Checks: test/checks_after_0049.sql (one statement, synthetic rows, ends in a
-- deliberate raise: "ALL 0049 CHECKS PASSED" = pass).
-- Why: Ask Kyte is answered today by a background run every 10 minutes. ari-ai action "chat" answers at once (streamed); this adds
-- what it needs in the database, and nothing else:
--   1. ai_calls.task accepts 'chat' (the spend ledger: every chat call is reserved and booked like any other AI call).
--   2. ai_chat: 30 days of chat turns (Owner's question, Kyte's answer, status, latency, the ai_calls id). Owner read, service write.
--      No prompt, no context snapshot, no model output other than the final answer is stored.
--   3. ari_ai_chat_begin(text): per-user rate limit (20 a minute, 300 a day, advisory-locked so a burst cannot race past it),
--      records the question, prunes rows older than 30 days, returns the recent turns for a multi-turn answer.
--   4. ari_ai_chat_finish(...): records the answer and its status on the same turn.
--   5. ari_ai_chat_context(question, person, account): READ-ONLY snapshot of Owner's own data (workspace Owner only): Today's moves,
--      pace this week, last 24 h changes, a people and account directory, detail for the people / accounts the question names,
--      exec track as counts only. Never personal or pending people, never deleted rows. "guard" carries the names the answer
--      must never print (the exec and the exec's assistant, read from the exec-track routes) and the linkable entities; the
--      function sends only "snapshot" to the model.
--   6. cron 'ari-ai-chat-prune' daily 02:20 IST: ai_chat rows older than 30 days.
-- Lock profile: ALTER of one check constraint on ai_calls (brief ACCESS EXCLUSIVE on a small table; lock_timeout 5s), new table,
-- new functions. No existing function, policy or grant changes. Re-runnable; the ledger row is written last.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.ai_calls') is null or to_regprocedure('public.ari_ai_budget_reserve(text, text, text, numeric, text, uuid, uuid, text)') is null
     or to_regprocedure('public.is_owner()') is null then
    raise exception '0049 needs 0041 (AI layer) applied first';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'people' and column_name = 'workspace_id') then
    raise exception '0049 needs 0033 (workspace_id) applied first';
  end if;
end $$;

-- 1. ledger task 'chat' (keeps whatever values the live constraint already allows) ----------------------------------------------
do $$
declare def text; vals text[];
begin
  select pg_get_constraintdef(oid) into def from pg_constraint where conrelid = 'public.ai_calls'::regclass and conname = 'ai_calls_task_check';
  if def is null then raise exception '0049: ai_calls_task_check not found'; end if;
  if def !~ '''chat''' then
    select array_agg(m[1] order by ord) into vals from regexp_matches(def, '''([a-z_]+)''', 'g') with ordinality as t(m, ord);
    vals := vals || array['chat'];
    execute 'alter table public.ai_calls drop constraint ai_calls_task_check';
    execute format('alter table public.ai_calls add constraint ai_calls_task_check check (task in (%s))', (select string_agg(quote_literal(v), ', ') from unnest(vals) v));
  end if;
end $$;

-- 2. chat turns ---------------------------------------------------------------------------------------------------------------
create table if not exists public.ai_chat (
  id bigserial primary key,
  at timestamptz not null default now(),
  role text not null check (role in ('user', 'assistant')),
  turn_id bigint,                                           -- assistant row: the user row it answers
  text text not null check (length(text) <= 4000),
  status text not null default 'pending' check (status in ('pending', 'ok', 'handled', 'refused', 'error')),
  call_id bigint,                                           -- ai_calls row (null for answers that needed no model call)
  first_ms int check (first_ms is null or first_ms >= 0),
  total_ms int check (total_ms is null or total_ms >= 0)
);
create index if not exists ai_chat_at on public.ai_chat(at);
revoke all on public.ai_chat from public, anon, authenticated;
revoke all on sequence public.ai_chat_id_seq from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ari_worker') then
    execute 'revoke all on public.ai_chat from ari_worker';
    execute 'revoke all on sequence public.ai_chat_id_seq from ari_worker';
  end if;
end $$;
alter table public.ai_chat enable row level security;
drop policy if exists owner_read on public.ai_chat;
create policy owner_read on public.ai_chat for select to authenticated using ((select public.is_owner()));
grant select on public.ai_chat to authenticated;                            -- RLS: owner only
grant select, insert, update, delete on public.ai_chat to service_role;
grant usage, select on sequence public.ai_chat_id_seq to service_role;

-- 3. begin a turn: rate limit, record, prune, recent turns ---------------------------------------------------------------------
create or replace function public.ari_ai_chat_begin(p_text text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare per_min constant int := 20; per_day constant int := 300; n_min int; n_day int; id_ bigint; hist jsonb;
  d0 timestamptz := date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata';
begin
  if p_text is null or btrim(p_text) = '' then return jsonb_build_object('ok', false, 'reason', 'empty'); end if;
  perform pg_advisory_xact_lock(hashtext('ari_ai_chat'));
  select count(*) filter (where at > now() - interval '60 seconds'), count(*) filter (where at >= d0)
    into n_min, n_day from ai_chat where role = 'user' and at >= least(d0, now() - interval '60 seconds');
  if n_min >= per_min then return jsonb_build_object('ok', false, 'reason', 'rate_minute', 'retry_s', 60); end if;
  if n_day >= per_day then return jsonb_build_object('ok', false, 'reason', 'rate_day', 'retry_s',
    greatest(60, extract(epoch from (d0 + interval '1 day' - now()))::int)); end if;
  delete from ai_chat where id in (select id from ai_chat where at < now() - interval '30 days' order by id limit 500);
  -- the last 6 answered turns from the past 2 hours, oldest first (a follow-up question can lean on them)
  select coalesce(jsonb_agg(jsonb_build_object('q', u.text, 'a', a.text) order by u.id), '[]'::jsonb) into hist
    from (select * from ai_chat where role = 'user' and status in ('ok', 'handled') and at > now() - interval '2 hours'
          order by id desc limit 6) u
    join lateral (select text from ai_chat x where x.role = 'assistant' and x.turn_id = u.id order by x.id desc limit 1) a on true;
  insert into ai_chat(role, text, status) values ('user', left(p_text, 1500), 'pending') returning id into id_;
  return jsonb_build_object('ok', true, 'turn_id', id_, 'history', hist);
end $$;

-- 4. finish a turn -------------------------------------------------------------------------------------------------------------
create or replace function public.ari_ai_chat_finish(p_turn bigint, p_answer text, p_status text, p_call bigint default null,
  p_first_ms int default null, p_total_ms int default null) returns bigint
language plpgsql security definer set search_path = public as $$
declare id_ bigint;
begin
  if p_status not in ('ok', 'handled', 'refused', 'error') then raise exception 'bad status' using errcode = '22023'; end if;
  update ai_chat set status = p_status, call_id = p_call, first_ms = greatest(p_first_ms, 0), total_ms = greatest(p_total_ms, 0)
   where id = p_turn and role = 'user' and status = 'pending';
  if not found then raise exception 'turn not found' using errcode = 'P0002'; end if;
  if p_status in ('ok', 'handled') and coalesce(btrim(p_answer), '') <> '' then
    insert into ai_chat(role, turn_id, text, status, call_id, first_ms, total_ms)
    values ('assistant', p_turn, left(p_answer, 4000), p_status, p_call, greatest(p_first_ms, 0), greatest(p_total_ms, 0)) returning id into id_;
  end if;
  return id_;
end $$;

-- 5. the read-only snapshot ----------------------------------------------------------------------------------------------------
create or replace function public.ari_ai_chat_context(p_question text default null, p_person text default null, p_account uuid default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';       -- workspace Owner (0033)
  now_ist timestamp := now() at time zone 'Asia/Kolkata';
  sd date := ((now() at time zone 'Asia/Kolkata') - interval '6 hours')::date;     -- the shift day, as the app counts it
  wk timestamptz := date_trunc('week', (now() at time zone 'Asia/Kolkata') - interval '6 hours') at time zone 'Asia/Kolkata';
  q text := lower(left(coalesce(p_question, ''), 1500));
  lanes text[]; snap jsonb; deny text[]; ents jsonb;
begin
  -- lanes other than Owner's own (the exec track) as the people_lane_check constraint allows them; read, never typed here
  select coalesce(array_agg(lower(m[1])) filter (where lower(m[1]) <> 'shal'), '{}') into lanes
    from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([A-Za-z]+)''', 'g') m
   where c.conrelid = 'public.people'::regclass and c.conname = 'people_lane_check';

  with base as (
    select p.id, p.name, p.company, p.title, p.stage, p.route, p.lane, p.review, p.account_id, p.connect_sent, p.accepted, p.dm1_sent,
           p.dm2_due, p.dm2_sent, p.dm3_due, p.dm3_sent, p.replied, p.meeting, p.withdrawn, p.skipped, p.snooze_until, p.dm, p.dm2_text,
           p.dm3_text, p.updated_at, p.created_at,
           (coalesce(p.lane, 'shal') <> 'shal' or coalesce(p.route, '') ~* '\yvia\y' or lower(coalesce(p.stage, '')) = any(lanes)
            or coalesce(p.stage, '') ~* '^exec') as is_exec,
           a.company as acc_company, a.stage as acc_stage,
           (coalesce(a.stage, '') ~* '^(hold|customer|closed lost|not a fit)$' or coalesce(a.flags, '{}') && array['hold', 'do-not', 'dnc', 'do_not_contact']
            or coalesce(a.meeting_status, '') = 'set') as dnc
      from people p left join accounts a on a.id = p.account_id and a.deleted_at is null
     where p.deleted_at is null and coalesce(p.review, 'lead') = 'lead' and coalesce(p.workspace_id, ws) = ws
       and coalesce(btrim(p.name), '') <> ''
  ), moves as (
    select b.*, case
        when b.replied is not null and exists (select 1 from replies r where r.person_id = b.id and r.status = 'new') then 'reply'
        when b.replied is not null or b.meeting is not null or b.withdrawn is not null or b.skipped is not null or b.dm3_sent is not null then null
        when b.dm2_sent is not null then case when coalesce(b.dm3_due, (b.dm2_sent at time zone 'Asia/Kolkata')::date + 7) <= sd then 'last_note' end
        when b.dm1_sent is not null then case when coalesce(b.dm2_due, (b.dm1_sent at time zone 'Asia/Kolkata')::date + 4) <= sd then 'follow_up' end
        when b.accepted is not null then 'first_message' end as move
      from base b
     where not b.is_exec and not b.dnc and coalesce(b.stage, '') !~* '^hold$' and (b.snooze_until is null or b.snooze_until <= sd)
  ), today as (
    select m.*, row_number() over (order by case m.move when 'reply' then 1 when 'first_message' then 2 when 'follow_up' then 3 else 4 end,
           coalesce(m.replied, m.accepted, m.dm1_sent, m.dm2_sent) nulls last, m.id) as rk
      from moves m where m.move is not null
  )
  select jsonb_build_object(
    'now', to_char(now_ist, 'Dy DD Mon HH24:MI'), 'shift_day', sd,
    'pace', (select jsonb_build_object('week_connects', count(*) filter (where connect_sent >= wk), 'week_goal_connects', 75,
              'week_accepted', count(*) filter (where accepted >= wk), 'week_first_messages', count(*) filter (where dm1_sent >= wk),
              'week_follow_ups', count(*) filter (where dm2_sent >= wk or dm3_sent >= wk), 'week_replies', count(*) filter (where replied >= wk),
              'week_meetings', count(*) filter (where meeting >= wk), 'today_connects', count(*) filter (where connect_sent >= (sd::timestamp + interval '6 hours') at time zone 'Asia/Kolkata'))
              from base where not is_exec),
    'today', (select jsonb_build_object('moves_total', count(*),
              'replies', count(*) filter (where move = 'reply'), 'first_messages', count(*) filter (where move = 'first_message'),
              'follow_ups', count(*) filter (where move = 'follow_up'), 'last_notes', count(*) filter (where move = 'last_note'),
              'first_15', coalesce(jsonb_agg(jsonb_build_object('rank', rk, 'person_id', id, 'name', name, 'company', company, 'title', title,
                 'move', move, 'draft_ready', case move when 'first_message' then dm is not null when 'follow_up' then dm2_text is not null
                   when 'last_note' then dm3_text is not null else null end) order by rk) filter (where rk <= 15), '[]'::jsonb))
              from today),
    'last_24h', (select jsonb_build_object(
              'accepted', coalesce(jsonb_agg(jsonb_build_object('name', name, 'company', company)) filter (where accepted > now() - interval '24 hours'), '[]'::jsonb),
              'replied', coalesce(jsonb_agg(jsonb_build_object('name', name, 'company', company)) filter (where replied > now() - interval '24 hours'), '[]'::jsonb),
              'first_messages_sent', count(*) filter (where dm1_sent > now() - interval '24 hours'),
              'follow_ups_sent', count(*) filter (where dm2_sent > now() - interval '24 hours' or dm3_sent > now() - interval '24 hours'),
              'meetings', count(*) filter (where meeting > now() - interval '24 hours'),
              'connects_sent', count(*) filter (where connect_sent > now() - interval '24 hours'),
              'people_added', count(*) filter (where created_at > now() - interval '24 hours'))
              from base where not is_exec),
    'exec_track', (select jsonb_build_object('people', count(*), 'companies', coalesce(jsonb_agg(distinct company) filter (where company is not null), '[]'::jsonb))
              from base where is_exec),
    'people', (select coalesce(jsonb_agg(x.j order by x.u desc), '[]'::jsonb) from (
              select jsonb_build_object('id', id, 'name', name, 'company', company, 'title', title, 'stage', stage,
                'do_not_contact', dnc, 'accepted', accepted is not null, 'first_message_sent', dm1_sent is not null, 'replied', replied is not null,
                'draft_ready', dm is not null and dm1_sent is null) j, updated_at u
                from base where not is_exec order by updated_at desc limit 80) x),
    'accounts', (select coalesce(jsonb_agg(x.j order by x.u desc), '[]'::jsonb) from (
              select jsonb_build_object('id', a.id, 'company', a.company, 'stage', a.stage, 'one_liner', left(a.one_liner, 140), 'hook', left(a.hook, 180),
                'hook_date', a.hook_date, 'play', a.play,
                'do_not_contact', (coalesce(a.stage, '') ~* '^(hold|customer|closed lost|not a fit)$' or a.flags && array['hold', 'do-not', 'dnc', 'do_not_contact']
                                   or coalesce(a.meeting_status, '') = 'set'),
                'meeting_set', coalesce(a.meeting_status, '') = 'set') j, a.updated_at u
                from accounts a where a.deleted_at is null and coalesce(a.workspace_id, ws) = ws order by a.updated_at desc limit 40) x),
    'focus_people', (select coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name, 'company', b.company, 'title', b.title, 'stage', b.stage,
                'do_not_contact', b.dnc, 'connect_sent', b.connect_sent::date, 'accepted', b.accepted::date, 'first_message_sent', b.dm1_sent::date,
                'follow_up_due', b.dm2_due, 'follow_up_sent', b.dm2_sent::date, 'last_note_due', b.dm3_due, 'last_note_sent', b.dm3_sent::date,
                'replied', b.replied::date, 'meeting', b.meeting::date, 'snoozed_until', b.snooze_until,
                'why_this_person', left(p.why_this_person, 600), 'research', left(p.research, 1200), 'context', left(p.context, 500),
                'first_message_draft', left(b.dm, 600), 'follow_up_draft', left(b.dm2_text, 600), 'last_note_draft', left(b.dm3_text, 600),
                'draft_reason', left(p.extra #>> '{ai,dm,rationale}', 400), 'draft_facts', p.extra #> '{ai,dm,source_facts}',
                'latest_reply', (select jsonb_build_object('status', r.status, 'received', r.received_at::date, 'text', left(r.snippet, 400))
                                   from replies r where r.person_id = b.id order by r.received_at desc limit 1),
                'research_notes', (select coalesce(jsonb_agg(jsonb_build_object('dated', r.dated, 'summary', left(r.summary, 300))), '[]'::jsonb)
                                   from (select * from research where person_id = b.id order by fetched_at desc limit 4) r))), '[]'::jsonb)
              from (select * from base where not is_exec and (id = p_person or (length(btrim(name)) >= 4 and strpos(q, lower(btrim(name))) > 0)
                      or (length(split_part(btrim(name), ' ', 1)) >= 3 and length(coalesce(company, '')) >= 3
                          and strpos(q, lower(split_part(btrim(name), ' ', 1))) > 0 and strpos(q, lower(company)) > 0))
                    order by (id = p_person) desc, updated_at desc limit 3) b join people p on p.id = b.id),
    'focus_accounts', (select coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'company', a.company, 'stage', a.stage, 'one_liner', left(a.one_liner, 300),
                'hook', left(a.hook, 400), 'hook_date', a.hook_date, 'why_thrandvex', left(a.why_thrandvex, 800), 'play', a.play,
                'suggested_order', left(a.suggested_order, 300), 'meeting_status', a.meeting_status,
                'do_not_contact', (coalesce(a.stage, '') ~* '^(hold|customer|closed lost|not a fit)$' or a.flags && array['hold', 'do-not', 'dnc', 'do_not_contact']
                                   or coalesce(a.meeting_status, '') = 'set'),
                'brief', (select jsonb_build_object('status', ab->>'status', 'thesis', left(ab->>'thesis', 500), 'angle', left(ab->>'angle', 300),
                            'why_now', ab->'why_now') from (select to_jsonb(x) ab from account_briefs x where x.account_id = a.id) y),
                'people', (select coalesce(jsonb_agg(jsonb_build_object('name', b.name, 'title', b.title, 'stage', b.stage,
                             'first_message_sent', b.dm1_sent is not null, 'replied', b.replied is not null)), '[]'::jsonb)
                           from (select * from base where account_id = a.id and not is_exec order by updated_at desc limit 12) b),
                'exec_track_people', (select count(*) from base where account_id = a.id and is_exec),
                'research_notes', (select coalesce(jsonb_agg(jsonb_build_object('dated', r.dated, 'summary', left(r.summary, 300))), '[]'::jsonb)
                                   from (select * from research where account_id = a.id order by fetched_at desc limit 4) r))), '[]'::jsonb)
              from (select * from accounts a where a.deleted_at is null and coalesce(a.workspace_id, ws) = ws
                      and (a.id = p_account or (length(btrim(a.company)) >= 3 and strpos(q, lower(btrim(a.company))) > 0))
                    order by (a.id = p_account) desc, a.updated_at desc limit 2) a)
  ) into snap
  from (select 1) one;

  -- names the answer must never print: the exec-track routes ("<exec> via <assistant>") and the exec lanes, as words
  select coalesce(array_agg(distinct w), '{}') into deny from (
    select initcap(w) w from people p, regexp_split_to_table(coalesce(p.route, ''), '[^A-Za-z]+') w
     where p.deleted_at is null and p.route ~* '\yvia\y' and length(w) >= 3 and lower(w) not in ('via', 'and', 'the', 'direct')
    union select initcap(l) from unnest(lanes) l where length(l) >= 3 and l not in ('exec')) d;

  select coalesce(jsonb_agg(e), '[]'::jsonb) into ents from (
    select jsonb_build_object('kind', 'person', 'id', p.id, 'name', btrim(p.name)) e
      from people p where p.deleted_at is null and coalesce(p.review, 'lead') = 'lead' and coalesce(p.workspace_id, ws) = ws
       and length(btrim(coalesce(p.name, ''))) >= 4 and coalesce(p.lane, 'shal') = 'shal' and coalesce(p.route, '') !~* '\yvia\y'
       and lower(coalesce(p.stage, '')) <> all(lanes)
    union all
    select jsonb_build_object('kind', 'account', 'id', a.id::text, 'name', btrim(a.company))
      from accounts a where a.deleted_at is null and coalesce(a.workspace_id, ws) = ws and length(btrim(coalesce(a.company, ''))) >= 3) z;

  return jsonb_build_object('snapshot', snap, 'guard', jsonb_build_object('deny_names', to_jsonb(deny), 'entities', ents));
end $$;

-- grants: service_role only (the ari-ai function); nobody signed in, nobody anonymous, never the worker role --------------------
do $$
declare f text;
begin
  foreach f in array array['ari_ai_chat_begin(text)', 'ari_ai_chat_finish(bigint, text, text, bigint, int, int)',
                           'ari_ai_chat_context(text, text, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'ari_worker') then execute format('revoke all on function public.%s from ari_worker', f); end if;
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- 6. 30-day retention ----------------------------------------------------------------------------------------------------------
select cron.unschedule('ari-ai-chat-prune') where exists (select 1 from cron.job where jobname = 'ari-ai-chat-prune');
select cron.schedule('ari-ai-chat-prune', '50 20 * * *', $c$delete from public.ai_chat where at < now() - interval '30 days'$c$);  -- 02:20 IST

insert into supabase_migrations.schema_migrations(version, name) values ('0049', 'ai_chat') on conflict do nothing;
commit;
