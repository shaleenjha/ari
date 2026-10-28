-- 0047 AI pipeline job line (PENDING; staging first, Oct 28 2026). Needs 0041 (ai layer) and 0045 (private-by-owner model).
-- Rollback: 0047_pipeline_jobs_rollback.sql. Checks: test/checks_after_0047_staging.sql.
--
-- Why (staging e2e Oct 28): the Accepted insert and the 10-min cron drafted DM1 BEFORE research existed, and one DM1 produced
-- two "DM1 ready" rows (keys draft:dm1:<id> and draft:dm1:ai:<id>). Fix = triggers only ENQUEUE, a state machine runs the work.
--
-- How it works (teaching version):
--   1. pipeline_jobs: one row per (contact, stage, input_hash). input_hash = what the stage reads, so the same input can never
--      run twice (unique key), while a NEW input (new research) makes a new row. Stages, in order:
--      research -> brief -> dm1 -> copy_check -> fact_check.
--   2. pgmq queue 'ari_pipeline': each job row gets one message {job_id}. The worker READS a message (read(), not pop()):
--      the message turns invisible for vt seconds and comes back if the worker dies, so nothing is lost (at-least-once).
--      Only ari_pipeline_finish() archives it, in the SAME transaction that marks the job done and enqueues the next stage.
--   3. People trigger: Accepted (insert or update) enqueues ONLY research. DM1 is enqueued only when brief finishes.
--      ari_pipeline_start() re-checks each stage's precondition in SQL (dm1 needs research done AND a brief), so a stray
--      message can never draft early.
--   4. Outbox: notifications.draft_id (derived from the dedupe key) + unique (person_id, kind, draft_id); ari_notify() now
--      inserts with ON CONFLICT DO NOTHING on any key, so both DM1-ready paths collapse to ONE row. The sender
--      (ari_claim_notifications, 0002) already takes only sent_at is null rows with FOR UPDATE SKIP LOCKED.
--   5. fact_check_cache: Parallel verdicts by (company_domain, claim_hash); only public company-level claims are stored.
--   6. Kick: enqueue calls ari-ai {internal:"pipeline"} through pg_net (sent after commit, so only for committed jobs), and a
--      1-minute cron re-kicks while visible messages remain. Both are no-ops while ai_budget.enabled is false.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regclass('public.ai_budget') is null or to_regprocedure('public.ari_ai_hook()') is null then
    raise exception '0047 needs 0041 (ai layer) applied first'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'notifications' and column_name = 'owner_uid') then
    raise exception '0047 needs 0045 applied first'; end if;
end $$;

create extension if not exists pgmq;
do $$ begin
  if not exists (select 1 from pgmq.list_queues() where queue_name = 'ari_pipeline') then perform pgmq.create('ari_pipeline'); end if;
end $$;

-- 1. job table -------------------------------------------------------------------------------------------------------------
create table if not exists public.pipeline_jobs (
  id bigserial primary key,
  contact_id text not null references public.people(id) on delete cascade,
  account_id uuid,
  stage text not null check (stage in ('research', 'brief', 'dm1', 'copy_check', 'fact_check')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'skipped')),
  attempt int not null default 0,
  input_hash text not null check (length(input_hash) between 8 and 80),
  msg_id bigint,
  lease_until timestamptz,      -- set by ari_pipeline_start: while now() < lease_until a running job is NOT claimed again
  output jsonb,                 -- small result + refs (ai_calls id, research count, draft id); never prompt text
  output_ref text,              -- where the stage wrote: 'research', 'account_briefs:<id>', '<person>:dm1', ...
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (contact_id, stage, input_hash)
);
create index if not exists pipeline_jobs_contact on public.pipeline_jobs(contact_id, stage, status);
alter table public.pipeline_jobs add column if not exists lease_until timestamptz;   -- re-run safe

create table if not exists public.fact_check_cache (
  company_domain text not null check (company_domain ~ '^[a-z0-9.-]{3,120}$'),
  claim_hash text not null check (claim_hash ~ '^[0-9a-f]{64}$'),
  claim text not null check (length(claim) <= 600),
  verdict jsonb not null,
  checked_at timestamptz not null default now(),
  primary key (company_domain, claim_hash)
);

revoke all on public.pipeline_jobs, public.fact_check_cache from public, anon, authenticated;
revoke all on sequence public.pipeline_jobs_id_seq from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ari_worker') then
    execute 'revoke all on public.pipeline_jobs, public.fact_check_cache from ari_worker';
    execute 'revoke all on sequence public.pipeline_jobs_id_seq from ari_worker';
  end if;
end $$;
alter table public.pipeline_jobs enable row level security;
alter table public.fact_check_cache enable row level security;
drop policy if exists owner_read on public.pipeline_jobs;
create policy owner_read on public.pipeline_jobs for select to authenticated using ((select public.is_owner()));
grant select on public.pipeline_jobs to authenticated;                    -- RLS: owner only (same model as ai_jobs)
grant select, insert, update, delete on public.pipeline_jobs, public.fact_check_cache to service_role;
grant usage, select on sequence public.pipeline_jobs_id_seq to service_role;

-- 2. outbox: one row per (person, kind, draft) ------------------------------------------------------------------------------
alter table public.notifications add column if not exists draft_id text;
create or replace function public.notifications_draft_id() returns trigger language plpgsql security definer set search_path = public as $$
declare m text[];
begin
  if new.draft_id is null and new.person_id is not null then
    m := regexp_match(coalesce(new.dedupe_key, ''), '^draft:(dm[123]):(?:ai:)?(.+)$');
    if m is not null and m[2] = new.person_id then new.draft_id := new.person_id || ':' || m[1]; end if;
  end if;
  return new;
end $$;
revoke all on function public.notifications_draft_id() from public, anon, authenticated;
drop trigger if exists a_draft_id on public.notifications;
create trigger a_draft_id before insert on public.notifications for each row execute function public.notifications_draft_id();
update public.notifications n set draft_id = n.person_id || ':' || (regexp_match(n.dedupe_key, '^draft:(dm[123]):'))[1]
 where n.draft_id is null and n.person_id is not null and n.dedupe_key ~ ('^draft:dm[123]:(ai:)?' || n.person_id || '$')
   and not exists (select 1 from public.notifications o where o.id < n.id and o.person_id = n.person_id and o.kind = n.kind
                     and o.dedupe_key ~ ('^draft:' || (regexp_match(n.dedupe_key, '^draft:(dm[123]):'))[1] || ':(ai:)?' || n.person_id || '$'));
create unique index if not exists notifications_one_per_draft on public.notifications(person_id, kind, draft_id) where draft_id is not null;
-- any unique key (dedupe_key or the draft key) now means "already queued": never an error inside a people update
create or replace function public.ari_notify(p_kind text, p_key text, p_title text, p_body text,
                                             p_url text, p_person text default null, p_account uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications(kind, dedupe_key, title, body, url, person_id, account_id)
  values (p_kind, p_key, p_title, p_body, coalesce(p_url, '/ops'), p_person, p_account)
  on conflict do nothing;
$$;
revoke all on function public.ari_notify(text, text, text, text, text, text, uuid) from public, anon, authenticated;
-- the AI path uses the SAME key as the people trigger (was draft:dm1:ai:<id>)
create or replace function public.ari_ai_notify_dm_ready(p_person text) returns void
language sql security definer set search_path = public as $$
  select ari_notify('draft_due', 'draft:dm1:' || p_person, 'DM1 ready', 'Ready for your review in Ari.', '/ops', p_person,
    (select account_id from people where id = p_person)) $$;

-- 3. enqueue / kick ----------------------------------------------------------------------------------------------------------
create or replace function public.ari_pipeline_kick() returns bigint language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from ai_budget where id = 1 and enabled) then return null; end if;
  -- clock_timestamp(), not now(): pgmq.send stamps vt with clock_timestamp(), which is LATER than now() (= transaction start),
  -- so with now() a message sent in the same transaction never looked visible and the kick never fired (staging Oct 28 2026:
  -- work waited up to 60 s for the cron). The http request itself is queued by pg_net and sent only after commit.
  if not exists (select 1 from pgmq.q_ari_pipeline where vt <= clock_timestamp()) then return null; end if;
  return net.http_post(url := (select value from app_config where key = 'gmail_fn_base') || '/ari-ai',
    headers := jsonb_build_object('content-type', 'application/json', 'x-ari-hook', public.ari_ai_hook()),
    body := '{"internal":"pipeline"}'::jsonb, timeout_milliseconds := 5000);
end $$;

-- insert the job once per input; a new row gets exactly one queue message. p_kick false inside the worker (it keeps reading).
create or replace function public.ari_pipeline_enqueue(p_contact text, p_stage text, p_input_hash text, p_kick boolean default true)
returns jsonb language plpgsql security definer set search_path = public as $$
declare j bigint; m bigint; acc uuid;
begin
  select account_id into acc from people where id = p_contact;
  if not found then raise exception 'person not found' using errcode = 'P0002'; end if;
  -- research input = (contact, account): a null hash means "the standard research job" (the trigger and the app share it)
  if p_input_hash is null and p_stage = 'research' then p_input_hash := md5('research:v1:' || p_contact || ':' || coalesce(acc::text, '-')); end if;
  insert into pipeline_jobs(contact_id, account_id, stage, input_hash) values (p_contact, acc, p_stage, p_input_hash)
  on conflict (contact_id, stage, input_hash) do nothing returning id into j;
  if j is null then
    select id into j from pipeline_jobs where contact_id = p_contact and stage = p_stage and input_hash = p_input_hash;
    return jsonb_build_object('job_id', j, 'existing', true);
  end if;
  select pgmq.send('ari_pipeline', jsonb_build_object('job_id', j)) into m;
  update pipeline_jobs set msg_id = m where id = j;
  if p_kick then perform ari_pipeline_kick(); end if;
  return jsonb_build_object('job_id', j, 'existing', false, 'msg_id', m);
end $$;

-- Accepted -> research only. Same skip rules as people_notify (personal, deleted, Hold) and never after DM1 went out.
create or replace function public.people_pipeline_accept() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.accepted is null or (tg_op = 'UPDATE' and old.accepted is not null) then return null; end if;
  if coalesce(new.review, '') = 'personal' or new.deleted_at is not null or new.dm1_sent is not null
     or coalesce(new.stage, '') in ('Hold', 'Founder') or coalesce(new.updated_by, '') like 'backfill%' then return null; end if;
  perform ari_pipeline_enqueue(new.id, 'research', null);
  return null;
end $$;
revoke all on function public.people_pipeline_accept() from public, anon, authenticated;
drop trigger if exists pipeline_accept on public.people;
create trigger pipeline_accept after insert or update of accepted on public.people for each row execute function public.people_pipeline_accept();

-- a failed job is never silent (review #50): ONE ops_alert per job in the outbox (dedupe key ops:pipeline:<job id>).
-- The push text names only the stage, never the contact (it shows on a lock screen).
create or replace function public.ari_pipeline_alert(p_job bigint) returns void language plpgsql security definer set search_path = public as $$
declare j pipeline_jobs;
begin
  select * into j from pipeline_jobs where id = p_job;
  if not found then return; end if;
  perform ari_notify('ops_alert', 'ops:pipeline:' || j.id, 'Ari needs a look',
    'A draft step (' || j.stage || ') stopped. Open Ari to retry.', '/ops', j.contact_id, j.account_id);
end $$;
revoke all on function public.ari_pipeline_alert(bigint) from public, anon, authenticated;

-- 4. worker RPCs ---------------------------------------------------------------------------------------------------------------
-- read up to p_qty messages; each is invisible for p_vt seconds (comes back if not archived). Joined with its job.
create or replace function public.ari_pipeline_read(p_qty int default 5, p_vt int default 120) returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return coalesce((select jsonb_agg(jsonb_build_object('msg_id', r.msg_id, 'read_ct', r.read_ct, 'job', to_jsonb(j)) order by r.msg_id)
    from pgmq.read('ari_pipeline', greatest(30, least(p_vt, 300)), greatest(1, least(p_qty, 10))) r
    left join pipeline_jobs j on j.id = (r.message->>'job_id')::bigint), '[]'::jsonb);
end $$;

-- review #51: an earlier draft of 0047 made ari_pipeline_start(bigint, bigint) and an 8-arg ari_pipeline_finish. A new argument
-- list is a NEW function in Postgres, so on a DB that ran that draft the old ones would stay (no lease, no fence, no retry, no
-- alert) and a 2-arg call would be ambiguous. Drop them first; on a fresh DB these are no-ops.
drop function if exists public.ari_pipeline_start(bigint, bigint);
drop function if exists public.ari_pipeline_finish(bigint, bigint, text, jsonb, text, text, text, text);

-- claim a job for this message and re-check its precondition. ok=false + reason when it must wait or stop.
-- Lease (review #50): a job that is 'running' with lease_until in the future belongs to a live run; a redelivered message
-- (pgmq vt ran out, or a parallel read) gets ok=false 'running' and the worker makes NO model call. A lease that ran out
-- means the run died: the job is claimed again (attempt + 1). After 4 such deliveries the job fails with an alert.
create or replace function public.ari_pipeline_start(p_job bigint, p_msg bigint, p_lease int default 150) returns jsonb
language plpgsql security definer set search_path = public as $$
declare j pipeline_jobs; why text; rc int;
begin
  select * into j from pipeline_jobs where id = p_job for update;
  if not found then perform pgmq.archive('ari_pipeline', p_msg); return jsonb_build_object('ok', false, 'reason', 'gone', 'final', true); end if;
  if j.status in ('done', 'failed', 'skipped') then                       -- a redelivered message for finished work
    perform pgmq.archive('ari_pipeline', p_msg); return jsonb_build_object('ok', false, 'reason', 'already_' || j.status, 'final', true); end if;
  if j.status = 'running' and j.lease_until > now() then                  -- live run holds it: never twice
    return jsonb_build_object('ok', false, 'reason', 'running', 'final', false); end if;
  rc := coalesce((select q.read_ct from pgmq.q_ari_pipeline q where q.msg_id = p_msg), 0);
  if j.status = 'running' and rc >= 4 then                               -- lease ran out again and again: the run keeps dying
    update pipeline_jobs set status = 'failed', error = 'gave up: run stopped mid-way ' || rc || ' times', lease_until = null,
           finished_at = now(), updated_at = now() where id = p_job;
    perform pgmq.archive('ari_pipeline', p_msg); perform ari_pipeline_alert(p_job);
    return jsonb_build_object('ok', false, 'reason', 'gave_up_lease', 'final', true);
  end if;
  why := case
    when not exists (select 1 from people p where p.id = j.contact_id and p.deleted_at is null and coalesce(p.review, '') <> 'personal') then 'contact_unavailable'
    when j.stage = 'brief' and not exists (select 1 from pipeline_jobs r where r.contact_id = j.contact_id and r.stage = 'research' and r.status = 'done') then 'wait_research'
    when j.stage = 'dm1' and not exists (select 1 from pipeline_jobs r where r.contact_id = j.contact_id and r.stage = 'research' and r.status = 'done') then 'wait_research'
    when j.stage = 'dm1' and not exists (select 1 from pipeline_jobs b where b.contact_id = j.contact_id and b.stage = 'brief' and b.status = 'done')
                         and not exists (select 1 from account_briefs a where a.account_id = j.account_id and a.status = 'ready') then 'wait_brief'
    when j.stage = 'dm1' and exists (select 1 from people p where p.id = j.contact_id and p.dm1_sent is not null) then 'dm1_already_sent'
    when j.stage in ('copy_check', 'fact_check') and not exists (select 1 from pipeline_jobs d where d.contact_id = j.contact_id and d.stage = 'dm1' and d.status = 'done') then 'wait_dm1'
  end;
  if why in ('contact_unavailable', 'dm1_already_sent') then
    update pipeline_jobs set status = 'skipped', error = why, lease_until = null, finished_at = now(), updated_at = now() where id = p_job;
    perform pgmq.archive('ari_pipeline', p_msg); return jsonb_build_object('ok', false, 'reason', why, 'final', true);
  end if;
  if why is not null and rc >= 8 then
    update pipeline_jobs set status = 'failed', error = 'gave up: ' || why, lease_until = null, finished_at = now(), updated_at = now() where id = p_job;
    perform pgmq.archive('ari_pipeline', p_msg); perform ari_pipeline_alert(p_job);
    return jsonb_build_object('ok', false, 'reason', 'gave_up_' || why, 'final', true);
  end if;
  if why is not null then return jsonb_build_object('ok', false, 'reason', why, 'final', false); end if;   -- message reappears after vt
  update pipeline_jobs set status = 'running', attempt = attempt + 1, started_at = coalesce(started_at, now()),
         lease_until = now() + make_interval(secs => greatest(30, least(coalesce(p_lease, 150), 300))), updated_at = now() where id = p_job
  returning * into j;
  return jsonb_build_object('ok', true, 'job', to_jsonb(j));
end $$;

-- finish one job: status + output, enqueue the next stage (if any) and archive the message, all in one transaction.
-- p_status 'queued' = give it back (transient error): the message is NOT archived and reappears after its vt.
-- p_attempt fences the finish to the claim that ran (a run whose lease expired and was re-claimed cannot overwrite it).
-- Failure policy (review #50): a failed research job gets ONE retry job, sent with a 5-minute delay (bounded: the retry's own
-- failure is final). Every other final failure raises one ops_alert (ari_pipeline_alert), so nothing fails silently.
create or replace function public.ari_pipeline_finish(p_job bigint, p_msg bigint, p_status text, p_output jsonb, p_output_ref text,
  p_error text, p_next_stage text default null, p_next_hash text default null, p_attempt int default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare j pipeline_jobs; nxt jsonb; rj bigint; rm bigint; rh text;
begin
  if p_status not in ('done', 'failed', 'skipped', 'queued') then raise exception 'bad status'; end if;
  update pipeline_jobs set status = p_status, output = coalesce(p_output, output), output_ref = coalesce(left(p_output_ref, 200), output_ref),
         error = left(p_error, 300), lease_until = null, finished_at = case when p_status <> 'queued' then now() end, updated_at = now()
   where id = p_job and status = 'running' and (p_attempt is null or attempt = p_attempt) returning * into j;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_running'); end if;
  if p_status = 'done' and p_next_stage is not null then
    nxt := ari_pipeline_enqueue(j.contact_id, p_next_stage, p_next_hash, false);
  end if;
  if p_status = 'failed' then
    rh := md5('research:v1:retry1:' || j.contact_id || ':' || coalesce(j.account_id::text, '-'));
    if j.stage = 'research' and j.input_hash <> rh
       and (select count(*) from pipeline_jobs r where r.contact_id = j.contact_id and r.stage = 'research') < 2 then
      insert into pipeline_jobs(contact_id, account_id, stage, input_hash) values (j.contact_id, j.account_id, 'research', rh)
      on conflict (contact_id, stage, input_hash) do nothing returning id into rj;
      if rj is not null then
        select pgmq.send('ari_pipeline', jsonb_build_object('job_id', rj), 300) into rm;
        update pipeline_jobs set msg_id = rm where id = rj;
        nxt := jsonb_build_object('retry_job', rj, 'delay_s', 300);
      end if;
    end if;
    if rj is null then perform ari_pipeline_alert(j.id); end if;            -- final failure: visible, deduped per job
  end if;
  if p_status <> 'queued' then perform pgmq.archive('ari_pipeline', p_msg); end if;
  return jsonb_build_object('ok', true, 'next', nxt);
end $$;

-- brief stage input: the contact's research brief + research rows (person and account) + the account and its people
create or replace function public.ari_pipeline_brief_context(p_contact text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'person', jsonb_build_object('id', p.id, 'name', p.name, 'title', p.title, 'company', p.company, 'research_brief', p.extra #> '{ai,research_brief}'),
    'account', (select jsonb_build_object('id', a.id, 'company', a.company, 'domain', a.domain, 'hook', a.hook, 'hook_date', a.hook_date,
                  'hook_url', a.hook_url, 'why_thrandvex', left(a.why_thrandvex, 800)) from accounts a where a.id = p.account_id and a.deleted_at is null),
    'research', coalesce((select jsonb_agg(jsonb_build_object('source_url', r.source_url, 'dated', r.dated, 'fact', left(r.summary, 600)) order by r.fetched_at desc)
       from (select * from research r where r.person_id = p.id or (p.account_id is not null and r.account_id = p.account_id)
             order by fetched_at desc limit 12) r), '[]'::jsonb),
    'people', coalesce((select jsonb_agg(jsonb_build_object('person_id', c.id, 'name', c.name, 'title', c.title) order by c.id)
       from (select * from people c where c.account_id = p.account_id and c.deleted_at is null and coalesce(c.review, '') <> 'personal'
             order by c.id limit 12) c), '[]'::jsonb))
  from people p where p.id = p_contact and p.deleted_at is null $$;

-- write a server-built brief (the TS builder already ran the brief_upsert.py checks; ari_worker_brief_write re-checks the
-- same rules in SQL except sequences, which the server stage does not write yet: they stay [] until the worker builds them)
create or replace function public.ari_pipeline_brief_write(p_account uuid, p_brief jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare t text := p_brief::text; u text; i jsonb; errs text[] := '{}';
begin
  if p_brief is null or jsonb_typeof(p_brief) <> 'object' then raise exception 'brief must be a json object'; end if;
  if not exists (select 1 from accounts where id = p_account and deleted_at is null) then raise exception 'unknown account'; end if;
  if coalesce(p_brief->>'thesis', '') = '' then errs := errs || 'missing thesis'::text; end if;
  if jsonb_typeof(p_brief->'why_now') <> 'array' or jsonb_array_length(p_brief->'why_now') = 0 then errs := errs || 'missing why_now'::text; end if;
  if jsonb_typeof(p_brief->'committee') <> 'array' or jsonb_array_length(p_brief->'committee') = 0 then errs := errs || 'missing committee'::text; end if;
  if jsonb_typeof(p_brief->'quick_check') <> 'array' or jsonb_array_length(p_brief->'quick_check') not between 1 and 2 then errs := errs || 'quick_check needs 1 or 2 items'::text; end if;
  if errs = '{}' then
    for i in select * from jsonb_array_elements(p_brief->'why_now') loop
      if coalesce(i->>'label', '') not in ('Verified', 'Inference', 'Hypothesis') then errs := errs || 'why_now label'::text; end if;
      if i->>'label' = 'Verified' and i->>'kind' = 'trigger' and (coalesce(i->>'url', '') = '' or coalesce(i->>'date', '') = '') then
        errs := errs || 'a Verified trigger needs a date and a url'::text; end if;
    end loop;
    for i in select * from jsonb_array_elements(p_brief->'quick_check') loop
      if jsonb_typeof(i->'answer') <> 'number' or (i->>'answer')::int < 0 or (i->>'answer')::int >= jsonb_array_length(i->'options') then
        errs := errs || 'quick_check answer out of range'::text; end if;
    end loop;
  end if;
  if t ~ '[\u2014\u2013]' then errs := errs || 'contains a dash'::text; end if;
  for u in select jsonb_path_query(p_brief, 'strict $.**.url') #>> '{}' loop
    if u is not null and u <> '' and u !~ '^https://' then errs := errs || ('url must be https: ' || left(u, 80)); end if;
  end loop;
  if length(t) > 100000 then errs := errs || 'brief too large'::text; end if;
  if errs <> '{}' then raise exception 'NOT WRITTEN: %', array_to_string(errs, '; '); end if;
  perform set_config('ari.actor', 'ari-ai', true);
  insert into account_briefs(account_id, status, thesis, why_now, data_flow, committee, angle, soft_angles, quick_check, sequences)
  values (p_account, 'ready', p_brief->>'thesis', p_brief->'why_now', '[]', p_brief->'committee', coalesce(p_brief->>'angle', ''),
          coalesce(p_brief->'soft_angles', '[]'), p_brief->'quick_check', '[]')
  on conflict (account_id) do update set (status, thesis, why_now, committee, angle, soft_angles, quick_check) =
    (excluded.status, excluded.thesis, excluded.why_now, excluded.committee, excluded.angle, excluded.soft_angles, excluded.quick_check)
  where account_briefs.status <> 'ready' or account_briefs.updated_by = 'ari-ai';   -- never overwrite a worker-built brief
  return jsonb_build_object('written', found, 'account_id', p_account);
end $$;

-- copy / fact check results onto the DM1 meta (people.extra.ai.dm.checks.<kind>); a FLAG or a false claim forces needs_review
create or replace function public.ari_pipeline_save_checks(p_contact text, p_kind text, p_result jsonb, p_needs_review boolean) returns void
language sql security definer set search_path = public as $$
  update people set extra = jsonb_set(coalesce(extra, '{}'::jsonb), '{ai,dm}', coalesce(extra #> '{ai,dm}', '{}'::jsonb)
      || jsonb_build_object('checks', coalesce(extra #> '{ai,dm,checks}', '{}'::jsonb) || jsonb_build_object(p_kind, p_result || jsonb_build_object('at', now())))
      || case when p_needs_review then jsonb_build_object('needs_review', true) else '{}'::jsonb end, true),
    updated_at = now(), updated_by = 'ari-ai'
  where id = p_contact and deleted_at is null and p_kind in ('copy_check', 'fact_check') and extra #> '{ai,dm}' is not null $$;

create or replace function public.ari_pipeline_fact_get(p_domain text, p_hashes text[]) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(claim_hash, verdict), '{}'::jsonb) from fact_check_cache
   where company_domain = lower(p_domain) and claim_hash = any(p_hashes) and checked_at > now() - interval '30 days' $$;
create or replace function public.ari_pipeline_fact_put(p_domain text, p_hash text, p_claim text, p_verdict jsonb) returns void
language sql security definer set search_path = public as $$
  insert into fact_check_cache(company_domain, claim_hash, claim, verdict) values (lower(p_domain), p_hash, left(p_claim, 600), p_verdict)
  on conflict (company_domain, claim_hash) do update set verdict = excluded.verdict, claim = excluded.claim, checked_at = now() $$;

-- the event path no longer drafts DM1 itself: anyone it would have drafted for goes into the pipeline (research first)
create or replace function public.ari_ai_pending_events(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'accepts', coalesce((select jsonb_agg(x) from (
      select e.msg_id, e.name, e.profile_url, e.event_at,
             public.ari_gmail_match_person(public.ari_li_vanity(e.profile_url), e.name) as match,
             coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'title', c.title, 'company', c.company,
                 'stage', c.stage, 'vanity', public.ari_li_vanity(c.linkedin_url)))
               from (select * from people c where c.deleted_at is null and coalesce(c.review, '') <> 'personal'
                       and ((e.profile_url is not null and public.ari_li_vanity(c.linkedin_url) = public.ari_li_vanity(e.profile_url))
                            or lower(btrim(c.name)) = lower(btrim(e.name))) limit 5) c), '[]'::jsonb) as candidates
        from gmail_shadow_events e
       where e.kind = 'accept' and e.event_at > now() - interval '3 days'
         and not exists (select 1 from ai_triggers t where t.kind = 'accept' and t.ref = e.msg_id and t.status <> 'error')
       order by e.event_at limit greatest(1, least(p_limit, 50))) x), '[]'::jsonb),
    'dm1_needed', coalesce((select jsonb_agg(p.id) from (
      select p.id from people p
       where p.deleted_at is null and p.accepted > now() - interval '3 days' and p.dm1_sent is null
         and coalesce(btrim(p.dm), '') = '' and coalesce(p.review, '') <> 'personal'
         and not exists (select 1 from pipeline_jobs j where j.contact_id = p.id)
       order by p.accepted limit greatest(1, least(p_limit, 50))) p), '[]'::jsonb)) $$;

-- grants ------------------------------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['ari_pipeline_kick()', 'ari_pipeline_enqueue(text, text, text, boolean)', 'ari_pipeline_read(int, int)',
    'ari_pipeline_start(bigint, bigint, int)', 'ari_pipeline_finish(bigint, bigint, text, jsonb, text, text, text, text, int)',
    'ari_pipeline_alert(bigint)',
    'ari_pipeline_brief_context(text)', 'ari_pipeline_brief_write(uuid, jsonb)', 'ari_pipeline_save_checks(text, text, jsonb, boolean)',
    'ari_pipeline_fact_get(text, text[])', 'ari_pipeline_fact_put(text, text, text, jsonb)', 'ari_ai_pending_events(int)',
    'ari_ai_notify_dm_ready(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'ari_worker') then execute format('revoke all on function public.%s from ari_worker', f); end if;
    if f not in ('ari_pipeline_kick()', 'ari_pipeline_alert(bigint)') then execute format('grant execute on function public.%s to service_role', f); end if;
  end loop;
end $$;

select cron.unschedule('ari-pipeline') where exists (select 1 from cron.job where jobname = 'ari-pipeline');
select cron.schedule('ari-pipeline', '* * * * *', $c$select public.ari_pipeline_kick()$c$);

insert into supabase_migrations.schema_migrations(version, name) values ('0047', 'pipeline_jobs') on conflict do nothing;
commit;
notify pgrst, 'reload schema';
