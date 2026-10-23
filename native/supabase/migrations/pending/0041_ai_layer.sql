-- 0041 Live AI layer (PENDING, not applied anywhere; Oct 23 2026). Apply ONLY after S1 R7 is live (ari-ai / ari-gmail-push read
-- named keys ari_ai / ari_gmail_push, no legacy fallback). Rollback: 0041_ai_layer_rollback.sql. Checks: test/checks_after_0041.sql.
--   1. ai_budget (one row): enabled (kill switch, DEFAULT OFF), monthly_cap_usd (default 50: Opus drafts), daily_cap_usd (5).
--      Caps change by SQL only; no app or function endpoint writes this table.
--   2. ai_calls: audit of every model call (task, provider, model, tokens in/out, est. cost, person/account/job ref, status).
--      ari_ai_budget_reserve() reserves the worst-case cost under an advisory lock BEFORE a call and refuses over a cap;
--      ari_ai_call_finish() books the real usage. No prompt or output text is stored here.
--   3. ai_jobs: async deep research (queued/running/done/failed; steps jsonb = LIVE event feed {seq, at, type: status|query|
--      read|finding|error, ...}, appended per search / url read / finding; result jsonb). Realtime + SSE (ari_ai_job_events).
--   4. ai_triggers: idempotency for the event path ((kind, ref) primary key: accept by Gmail msg id, dm1 by person id).
--   5. replies.ai_triage (nullable jsonb): intent / urgency / summary from triage_reply. Expand only.
--   6. gmail_watch (one row): Gmail users.watch state for the Pub/Sub push path (history id, expiry, last push).
--   7. RPCs for the two new edge functions, all SECURITY DEFINER, service_role only, except ari_ai_caller() (authenticated:
--      tells the function whether the app caller is the owner, using is_owner() so aal2 rules apply).
--      Writes go ONLY to people.dm / dm2_text / dm3_text (+ people.extra.ai meta), replies.drafts (+ ai_triage), research rows,
--      ai_* tables, gmail_watch and notifications (generic "DM1 ready" / "Brief ready" / spend-cap ops alert).
--   8. pg_cron: 'ari-ai-events' every 10 min (fallback for the event path + stale jobs; no-op while ai_budget.enabled is false),
--      'ari-gmail-watch-renew' daily 01:45 IST (no-op until app_config gmail_watch_topic is set), 'ari-ai-prune' daily.
-- Explicit grants on every new object incl. service_role (Supabase stops auto-granting new public objects Oct 30 2026).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regprocedure('public.ari_gmail_match_person(text, text)') is null or to_regprocedure('public.is_owner()') is null
     or to_regclass('public.gmail_shadow_events') is null then
    raise exception '0041 needs 0030 (gmail shadow) applied first';
  end if;
end $$;

create table if not exists public.ai_budget (
  id int primary key default 1 check (id = 1),
  enabled boolean not null default false,
  monthly_cap_usd numeric(8,2) not null default 50 check (monthly_cap_usd > 0 and monthly_cap_usd <= 500),
  daily_cap_usd numeric(8,2) not null default 5 check (daily_cap_usd > 0 and daily_cap_usd <= 100),
  updated_at timestamptz not null default now()
);
insert into public.ai_budget(id) values (1) on conflict (id) do nothing;

create table if not exists public.ai_calls (
  id bigserial primary key,
  at timestamptz not null default now(),
  task text not null check (task in ('classify', 'triage', 'draft', 'rewrite', 'reply_draft', 'quick_research', 'deep_research', 'signal_search')),
  provider text not null check (provider in ('anthropic', 'xai', 'openai')),
  model text not null,
  tokens_in int not null default 0,
  tokens_out int not null default 0,
  reserved_usd numeric(10,5) not null default 0,
  est_cost_usd numeric(10,5) not null default 0,
  person_id text,
  account_id uuid,
  job_id uuid,
  request_key text,
  status text not null check (status in ('reserved', 'ok', 'error', 'invalid', 'refused')),
  error text,
  finished_at timestamptz
);
create index if not exists ai_calls_at on public.ai_calls(at);
create index if not exists ai_calls_person on public.ai_calls(person_id) where person_id is not null;

create table if not exists public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('deep_research')),
  person_id text,
  account_id uuid,
  focus text check (length(focus) <= 400),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  steps jsonb not null default '[]'::jsonb,
  result jsonb,
  error text,
  dedupe_key text not null,
  attempts int not null default 0,
  lease_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  check (person_id is not null or account_id is not null)
);
create unique index if not exists ai_jobs_open_dedupe on public.ai_jobs(dedupe_key) where status in ('queued', 'running');
create index if not exists ai_jobs_status on public.ai_jobs(status, created_at);

create table if not exists public.ai_triggers (
  kind text not null check (kind in ('accept', 'dm1')),
  ref text not null,
  status text not null default 'claimed' check (status in ('claimed', 'done', 'skipped', 'needs_review', 'error')),
  attempts int not null default 1,
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (kind, ref)
);

alter table public.replies add column if not exists ai_triage jsonb;

create table if not exists public.gmail_watch (
  id int primary key default 1 check (id = 1),
  history_id text,
  expires_at timestamptz,
  renewed_at timestamptz,
  last_push_at timestamptz,
  pushes bigint not null default 0,
  last_error text,
  updated_at timestamptz not null default now()
);
insert into public.gmail_watch(id) values (1) on conflict (id) do nothing;

-- RLS + grants for 1..6 ------------------------------------------------------------------------------------------------------
revoke all on public.ai_budget, public.ai_calls, public.ai_jobs, public.ai_triggers, public.gmail_watch from public, anon, authenticated;
revoke all on sequence public.ai_calls_id_seq from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ari_worker') then
    execute 'revoke all on public.ai_budget, public.ai_calls, public.ai_jobs, public.ai_triggers, public.gmail_watch from ari_worker';
    execute 'revoke all on sequence public.ai_calls_id_seq from ari_worker';
  end if;
end $$;
do $$ declare tb text; begin
  foreach tb in array array['ai_budget', 'ai_calls', 'ai_jobs', 'ai_triggers', 'gmail_watch'] loop
    execute format('alter table public.%I enable row level security', tb);
    execute format('drop policy if exists owner_read on public.%I', tb);
    if tb <> 'ai_triggers' then   -- ai_triggers: service only, no policy
      execute format('create policy owner_read on public.%I for select to authenticated using ((select public.is_owner()))', tb); end if;
  end loop; end $$;
grant select on public.ai_budget, public.ai_calls, public.ai_jobs, public.gmail_watch to authenticated;   -- RLS: owner only
grant select, insert, update on public.ai_budget, public.ai_calls, public.ai_jobs, public.ai_triggers, public.gmail_watch to service_role;
grant usage, select on sequence public.ai_calls_id_seq to service_role;

do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ai_jobs') then
    execute 'alter publication supabase_realtime add table public.ai_jobs';
  end if;
end $$;

-- hook secret for internal calls (cron -> ari-ai, cron -> ari-gmail-push renew, ari-gmail-push -> ari-ai) ------------------
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'ari_ai_hook_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ari_ai_hook_secret', 'x-ari-hook for ari-ai / ari-gmail-push');
  end if;
end $$;
create or replace function public.ari_ai_hook() returns text language sql stable security definer set search_path = public as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'ari_ai_hook_secret' $$;
create or replace function public.ari_ai_caller() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('owner', public.is_owner()) $$;

-- spend so far: open reservations count at their reserved worst case; refused calls count nothing. Month and day are IST.
create or replace function public.ari_ai_spend() returns jsonb language sql stable security definer set search_path = public as $$
  with b as (select date_trunc('month', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' m,
                    date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata' d)
  select jsonb_build_object(
    'month_usd', coalesce(sum(case when c.status = 'reserved' then c.reserved_usd else c.est_cost_usd end) filter (where c.at >= b.m), 0),
    'day_usd', coalesce(sum(case when c.status = 'reserved' then c.reserved_usd else c.est_cost_usd end) filter (where c.at >= b.d), 0))
  from b left join ai_calls c on c.at >= b.m and c.status <> 'refused'
  group by b.m, b.d $$;
create or replace function public.ari_ai_budget_reserve(p_task text, p_provider text, p_model text, p_est numeric,
  p_person text default null, p_account uuid default null, p_job uuid default null, p_request_key text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b ai_budget; sp jsonb; why text; id_ bigint; m numeric; d numeric;
begin
  perform pg_advisory_xact_lock(hashtext('ari_ai_budget'));
  select * into b from ai_budget where id = 1;
  sp := ari_ai_spend(); m := (sp->>'month_usd')::numeric; d := (sp->>'day_usd')::numeric;
  why := case when b.id is null or not b.enabled then 'disabled'
              when p_est is null or p_est <= 0 or p_est > 5 then 'bad_estimate'
              when m + p_est > b.monthly_cap_usd then 'monthly_cap'
              when d + p_est > b.daily_cap_usd then 'daily_cap' end;
  if why is not null then
    insert into ai_calls(task, provider, model, reserved_usd, person_id, account_id, job_id, request_key, status, error, finished_at)
    values (p_task, p_provider, p_model, 0, p_person, p_account, p_job, left(p_request_key, 120), 'refused', why, now());
    if why in ('monthly_cap', 'daily_cap') then
      perform ari_notify('ops_alert', 'ops:aicap:' || why || ':' || to_char(now() at time zone 'Asia/Kolkata', case when why = 'monthly_cap' then 'YYYYMM' else 'YYYYMMDD' end),
        'Ari needs a look', case when why = 'monthly_cap' then 'Drafting help is paused: this month''s spend limit is reached.'
                                 else 'Drafting help is paused until tomorrow: today''s spend limit is reached.' end, '/ops', null, null);
    end if;
    return jsonb_build_object('ok', false, 'reason', why, 'month_usd', m, 'cap_usd', coalesce(b.monthly_cap_usd, 0));
  end if;
  insert into ai_calls(task, provider, model, reserved_usd, person_id, account_id, job_id, request_key, status)
  values (p_task, p_provider, p_model, p_est, p_person, p_account, p_job, left(p_request_key, 120), 'reserved') returning id into id_;
  return jsonb_build_object('ok', true, 'call_id', id_, 'month_usd', m + p_est, 'cap_usd', b.monthly_cap_usd);
end $$;
create or replace function public.ari_ai_call_finish(p_id bigint, p_status text, p_in int, p_out int, p_cost numeric, p_error text default null)
returns void language sql security definer set search_path = public as $$
  update ai_calls set status = p_status, tokens_in = greatest(coalesce(p_in, 0), 0), tokens_out = greatest(coalesce(p_out, 0), 0),
         est_cost_usd = greatest(coalesce(p_cost, 0), 0), error = left(p_error, 200), finished_at = now()
   where id = p_id and status = 'reserved' and p_status in ('ok', 'error', 'invalid') $$;
create or replace function public.ari_ai_budget_headroom() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('enabled', b.enabled,
    'month_left', b.monthly_cap_usd - (public.ari_ai_spend()->>'month_usd')::numeric,
    'day_left', b.daily_cap_usd - (public.ari_ai_spend()->>'day_usd')::numeric)
  from ai_budget b where b.id = 1 $$;

-- context for one person (and their account). Untrusted text is passed to the model as data only. A person marked
-- personal (review = 'personal') or deleted gets nothing: the AI layer never drafts for personal connections.
create or replace function public.ari_ai_context(p_person text, p_account uuid default null) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare p people; a accounts; acc uuid;
begin
  if p_person is not null then
    select * into p from people where id = p_person and deleted_at is null;
    if not found then raise exception 'person not found' using errcode = 'P0002'; end if;
    if p.review = 'personal' then raise exception 'personal connection' using errcode = '42501'; end if;
  end if;
  acc := coalesce(p_account, p.account_id);
  if acc is not null then select * into a from accounts where id = acc and deleted_at is null; end if;
  return jsonb_build_object(
    'person', case when p.id is null then null else jsonb_build_object('id', p.id, 'name', p.name, 'first_name', split_part(btrim(p.name), ' ', 1),
      'title', p.title, 'company', p.company, 'role', p.role, 'stage', p.stage, 'why_this_person', left(p.why_this_person, 1500),
      'research', left(p.research, 4000), 'context', left(p.context, 1500), 'dm', p.dm, 'dm2_text', p.dm2_text, 'dm3_text', p.dm3_text,
      'dm1_sent', p.dm1_sent, 'accepted', p.accepted, 'linkedin_url', p.linkedin_url, 'ai', p.extra->'ai') end,
    'account', case when a.id is null then null else jsonb_build_object('id', a.id, 'company', a.company, 'one_liner', a.one_liner,
      'hook', a.hook, 'hook_date', a.hook_date, 'why_vendor', left(a.why_vendor, 1500), 'play', a.play, 'stage', a.stage) end,
    'research', coalesce((select jsonb_agg(jsonb_build_object('source_url', r.source_url, 'dated', r.dated, 'summary', left(r.summary, 600)) order by r.fetched_at desc)
       from (select * from research where (p.id is not null and person_id = p.id) or (acc is not null and account_id = acc)
             order by fetched_at desc limit 10) r), '[]'::jsonb),
    'guidance', coalesce((select jsonb_agg(jsonb_build_object('kind', g.kind, 'before', left(g.before, 400), 'after', left(g.after, 400), 'note', left(g.note, 300)))
       from (select * from copy_guidance where (p.id is not null and person_id = p.id) or (acc is not null and account_id = acc)
             or (person_id is null and account_id is null) order by created_at desc limit 12) g), '[]'::jsonb));
end $$;
create or replace function public.ari_ai_reply_context(p_reply bigint) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare r replies;
begin
  select * into r from replies where id = p_reply;
  if not found then raise exception 'reply not found' using errcode = 'P0002'; end if;
  return ari_ai_context(r.person_id, r.account_id) || jsonb_build_object('reply', jsonb_build_object('id', r.id, 'status', r.status,
    'received_at', r.received_at, 'msg_count', r.msg_count, 'headline', r.headline, 'snippet', left(r.snippet, 1200), 'drafts', r.drafts));
end $$;

-- write one DM draft. mode 'dm1_auto' (event path): only into an empty slot or over Ari's own unedited text.
-- mode 'rewrite' / 'manual' (Owner asked): only if the slot still holds p_expect (no lost edits). Never after that DM was sent.
create or replace function public.ari_ai_save_draft(p_person text, p_slot text, p_text text, p_meta jsonb, p_expect text, p_mode text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p people; cur text; sent timestamptz; prev_ai text; t text := btrim(p_text);
begin
  if p_slot not in ('dm', 'dm2_text', 'dm3_text') or p_mode not in ('dm1_auto', 'rewrite', 'manual') then raise exception 'bad slot or mode'; end if;
  if p_mode = 'dm1_auto' and p_slot <> 'dm' then raise exception 'dm1_auto writes dm only'; end if;
  if t = '' or length(t) > 1900 then return jsonb_build_object('saved', false, 'reason', 'length'); end if;
  if t ~ '[\u2014\u2013]' then return jsonb_build_object('saved', false, 'reason', 'dash'); end if;
  select * into p from people where id = p_person and deleted_at is null for update;
  if not found then return jsonb_build_object('saved', false, 'reason', 'missing'); end if;
  if p.review = 'personal' then return jsonb_build_object('saved', false, 'reason', 'personal'); end if;
  cur := case p_slot when 'dm' then p.dm when 'dm2_text' then p.dm2_text else p.dm3_text end;
  sent := case p_slot when 'dm' then p.dm1_sent when 'dm2_text' then p.dm2_sent else p.dm3_sent end;
  prev_ai := p.extra #>> array['ai', p_slot, 'text'];
  if sent is not null then return jsonb_build_object('saved', false, 'reason', 'already_sent'); end if;
  if p_mode = 'dm1_auto' and coalesce(btrim(cur), '') <> '' and cur is distinct from prev_ai then
    return jsonb_build_object('saved', false, 'reason', 'kept_existing'); end if;
  if p_mode <> 'dm1_auto' and coalesce(cur, '') is distinct from coalesce(p_expect, '') then
    return jsonb_build_object('saved', false, 'reason', 'changed'); end if;
  update people set
    dm = case when p_slot = 'dm' then t else dm end,
    dm2_text = case when p_slot = 'dm2_text' then t else dm2_text end,
    dm3_text = case when p_slot = 'dm3_text' then t else dm3_text end,
    extra = jsonb_set(coalesce(extra, '{}'::jsonb), '{ai}', coalesce(extra->'ai', '{}'::jsonb) || jsonb_build_object(p_slot,
      coalesce(p_meta, '{}'::jsonb) || jsonb_build_object('text', t, 'prev', cur, 'mode', p_mode, 'at', now()))),
    field_ts = coalesce(field_ts, '{}'::jsonb) || jsonb_build_object(p_slot, now()),
    updated_at = now(), updated_by = 'ari-ai'
  where id = p_person;
  return jsonb_build_object('saved', true);
end $$;

-- triage: the three reply drafts go through the worker's own validator (0018), plus the triage summary
create or replace function public.ari_ai_save_triage(p_reply bigint, p_drafts jsonb, p_triage jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb;
begin
  r := public.ari_worker_reply_drafts(p_reply, p_drafts);
  update replies set ai_triage = jsonb_build_object('intent', p_triage->>'intent', 'urgency', p_triage->>'urgency',
    'summary', left(p_triage->>'summary', 300), 'needs_review', coalesce((p_triage->>'needs_review')::boolean, true), 'at', now())
   where id = p_reply;
  return r;
end $$;

-- rewrite ONE reply draft (book | answer | soft) if it still holds p_expect
create or replace function public.ari_ai_save_reply_draft(p_reply bigint, p_key text, p_body text, p_expect text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r replies; i int; b text := btrim(p_body);
begin
  if p_key not in ('book', 'answer', 'soft') then raise exception 'bad key'; end if;
  if b = '' or length(b) > 300 or b ~ '[\u2014\u2013]' then return jsonb_build_object('saved', false, 'reason', 'style'); end if;
  select * into r from replies where id = p_reply and status = 'new' for update;
  if not found then return jsonb_build_object('saved', false, 'reason', 'missing'); end if;
  select o - 1 into i from jsonb_array_elements(coalesce(r.drafts, '[]'::jsonb)) with ordinality e(d, o) where d->>'key' = p_key;
  if i is null then return jsonb_build_object('saved', false, 'reason', 'missing'); end if;
  if coalesce(r.drafts #>> array[i::text, 'body'], '') is distinct from coalesce(p_expect, '') then
    return jsonb_build_object('saved', false, 'reason', 'changed'); end if;
  update replies set drafts = jsonb_set(drafts, array[i::text, 'body'], to_jsonb(b)), drafted_at = now(), updated_at = now() where id = p_reply;
  return jsonb_build_object('saved', true);
end $$;

-- research findings -> research rows (deduped by subject + url + text) + the short brief in people.extra.ai.research_brief
create or replace function public.ari_ai_save_research(p_person text, p_account uuid, p_findings jsonb, p_brief jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int; acc uuid := coalesce(p_account, (select account_id from people where id = p_person));
begin
  if p_person is null and acc is null then raise exception 'no subject'; end if;
  insert into research(person_id, account_id, source_url, dated, summary)
  select p_person, acc, left(f->>'source_url', 500), case when f->>'dated' ~ '^\d{4}-\d{2}-\d{2}$' then (f->>'dated')::date end, left(f->>'fact', 600)
    from jsonb_array_elements(coalesce(p_findings, '[]'::jsonb)) f
   where f->>'source_url' ~ '^https?://' and coalesce(btrim(f->>'fact'), '') <> ''
     and not exists (select 1 from research x where x.source_url = left(f->>'source_url', 500) and x.summary = left(f->>'fact', 600)
                       and x.person_id is not distinct from p_person and x.account_id is not distinct from acc)
   limit 12;
  get diagnostics n = row_count;
  if p_person is not null and p_brief is not null then
    update people set extra = jsonb_set(coalesce(extra, '{}'::jsonb), '{ai}', coalesce(extra->'ai', '{}'::jsonb)
      || jsonb_build_object('research_brief', p_brief || jsonb_build_object('at', now()))), updated_at = now(), updated_by = 'ari-ai'
     where id = p_person and deleted_at is null;
  end if;
  return jsonb_build_object('inserted', n);
end $$;

-- deep research jobs ----------------------------------------------------------------------------------------------------
create or replace function public.ari_ai_job_enqueue(p_person text, p_account uuid, p_focus text, p_steps jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare k text := 'deep:' || coalesce(p_person, p_account::text); j uuid;
begin
  select id into j from ai_jobs where dedupe_key = k and status in ('queued', 'running');
  if found then return jsonb_build_object('id', j, 'existing', true); end if;
  insert into ai_jobs(kind, person_id, account_id, focus, steps, dedupe_key)
  values ('deep_research', p_person, coalesce(p_account, (select account_id from people where id = p_person)), left(p_focus, 400), coalesce(p_steps, '[]'), k)
  returning id into j;
  return jsonb_build_object('id', j, 'existing', false);
end $$;

-- claim one runnable job (queued, or running with an expired lease); 5 attempts then failed
create or replace function public.ari_ai_job_claim(p_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare j ai_jobs;
begin
  update ai_jobs set status = 'failed', error = 'gave up after 5 attempts', finished_at = now(), updated_at = now()
   where attempts >= 5 and (status = 'queued' or (status = 'running' and lease_until < now()));
  update ai_jobs set status = 'running', lease_until = now() + interval '150 seconds', attempts = attempts + 1,
         started_at = coalesce(started_at, now()), updated_at = now()
   where id = (select id from ai_jobs where (p_id is null or id = p_id) and attempts < 5
                 and (status = 'queued' or (status = 'running' and lease_until < now()))
               order by created_at limit 1 for update skip locked)
  returning * into j;
  return case when j.id is null then null else to_jsonb(j) end;
end $$;
create or replace function public.ari_ai_job_update(p_id uuid, p_steps jsonb, p_status text, p_result jsonb, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare j ai_jobs;
begin
  if p_status not in ('queued', 'running', 'done', 'failed') then raise exception 'bad status'; end if;
  update ai_jobs set steps = coalesce(p_steps, steps), status = p_status, result = coalesce(p_result, result), error = left(p_error, 200),
         lease_until = case when p_status = 'running' then now() + interval '150 seconds' end,
         finished_at = case when p_status in ('done', 'failed') then now() end, updated_at = now()
   where id = p_id returning * into j;
  if j.status = 'done' then
    perform ari_notify('research_done', 'brief:ai:' || j.id, 'Brief ready', 'A new brief is waiting in Ari.', '/ops', j.person_id, j.account_id);
  end if;
end $$;

-- live feed: append events (seq + at assigned here, newest 300 kept, lease extended) / read events after a seq (SSE relay)
create or replace function public.ari_ai_job_event(p_id uuid, p_events jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare base int; n int;
begin
  if jsonb_typeof(p_events) <> 'array' or jsonb_array_length(p_events) > 50 then raise exception 'bad events'; end if;
  select coalesce(max((e->>'seq')::int), 0) into base from ai_jobs j, jsonb_array_elements(j.steps) e where j.id = p_id;
  update ai_jobs set steps = (select coalesce(jsonb_agg(e order by (e->>'seq')::int), '[]'::jsonb) from (
      select e from jsonb_array_elements(steps || coalesce((select jsonb_agg(x || jsonb_build_object('seq', coalesce(base, 0) + o, 'at', now()))
        from jsonb_array_elements(p_events) with ordinality t(x, o) where jsonb_typeof(x) = 'object' and length(x::text) <= 2000), '[]'::jsonb)) e
      order by (e->>'seq')::int desc limit 300) s),
    lease_until = case when status = 'running' then now() + interval '150 seconds' else lease_until end, updated_at = now()
  where id = p_id;
  get diagnostics n = row_count;
  return case when n = 1 then coalesce(base, 0) + jsonb_array_length(p_events) end;
end $$;
create or replace function public.ari_ai_job_events(p_id uuid, p_since int default 0) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('status', j.status, 'result', case when j.status in ('done', 'failed') then j.result end,
    'events', coalesce((select jsonb_agg(e order by (e->>'seq')::int) from jsonb_array_elements(j.steps) e
                        where (e->>'seq')::int > coalesce(p_since, 0)), '[]'::jsonb))
  from ai_jobs j where j.id = p_id $$;

-- event path idempotency ------------------------------------------------------------------------------------------------
-- true = this caller owns (kind, ref) now. An errored claim (10 min) or a stuck one (15 min) can be retried, 3 attempts in all.
create or replace function public.ari_ai_trigger_claim(p_kind text, p_ref text) returns boolean
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into ai_triggers(kind, ref) values (p_kind, p_ref) on conflict (kind, ref) do nothing;
  get diagnostics n = row_count;
  if n = 1 then return true; end if;
  update ai_triggers set status = 'claimed', attempts = attempts + 1, updated_at = now()
   where kind = p_kind and ref = p_ref and attempts < 3
     and ((status = 'error' and updated_at < now() - interval '10 minutes') or (status = 'claimed' and updated_at < now() - interval '15 minutes'));
  get diagnostics n = row_count;
  return n = 1;
end $$;
create or replace function public.ari_ai_trigger_done(p_kind text, p_ref text, p_status text, p_detail text default null) returns void
language sql security definer set search_path = public as $$
  update ai_triggers set status = p_status, detail = left(p_detail, 200), updated_at = now() where kind = p_kind and ref = p_ref $$;

-- what the event path still owes: accept emails not yet handled (with deterministic match + candidates, parsed fields only)
-- and recently accepted people (Gmail or the manual tap) with no DM1 and no dm1 trigger yet.
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
         and not exists (select 1 from ai_triggers t where t.kind = 'dm1' and t.ref = p.id and t.status <> 'error')
       order by p.accepted limit greatest(1, least(p_limit, 50))) p), '[]'::jsonb)) $$;

-- generic push: notifications_privacy() (0031/0040) turns a 'draft:dm1:%' draft_due into "DM1 ready" with no name
create or replace function public.ari_ai_notify_dm_ready(p_person text) returns void
language sql security definer set search_path = public as $$
  select ari_notify('draft_due', 'draft:dm1:ai:' || p_person, 'DM1 ready', 'Ready for your review in Ari.', '/ops', p_person,
    (select account_id from people where id = p_person)) $$;

-- Gmail push (users.watch) ----------------------------------------------------------------------------------------------
create or replace function public.ari_gmail_push_config() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'topic', (select value from app_config where key = 'gmail_watch_topic'),
    'audience', (select value from app_config where key = 'gmail_push_audience'),
    'sa_email', (select value from app_config where key = 'gmail_push_sa'),
    'watch', (select to_jsonb(w) from gmail_watch w where id = 1)) $$;
create or replace function public.ari_gmail_watch_set(p_history_id text, p_expires_ms bigint, p_error text) returns void
language sql security definer set search_path = public as $$
  update gmail_watch set history_id = coalesce(p_history_id, history_id),
         expires_at = case when p_expires_ms > 0 then to_timestamp(p_expires_ms / 1000.0) else expires_at end,
         renewed_at = case when p_error is null then now() else renewed_at end, last_error = left(p_error, 200), updated_at = now()
   where id = 1 $$;
create or replace function public.ari_gmail_watch_push(p_history_id text) returns void
language sql security definer set search_path = public as $$
  update gmail_watch set last_push_at = now(), pushes = pushes + 1, updated_at = now() where id = 1 $$;

-- cron kicks (no-ops until switched on) ----------------------------------------------------------------------------------
create or replace function public.ari_ai_kick() returns bigint language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from ai_budget where id = 1 and enabled) then return null; end if;
  return net.http_post(url := (select value from app_config where key = 'gmail_fn_base') || '/ari-ai',
    headers := jsonb_build_object('content-type', 'application/json', 'x-ari-hook', public.ari_ai_hook()),
    body := '{"internal":"process"}'::jsonb, timeout_milliseconds := 30000);
end $$;
create or replace function public.ari_gmail_watch_kick() returns bigint language plpgsql security definer set search_path = public as $$
begin
  if coalesce((select value from app_config where key = 'gmail_watch_topic'), '') = ''
     or not exists (select 1 from gmail_connection where id = 1 and status = 'connected') then return null; end if;
  return net.http_post(url := (select value from app_config where key = 'gmail_fn_base') || '/ari-gmail-push',
    headers := jsonb_build_object('content-type', 'application/json', 'x-ari-hook', public.ari_ai_hook()),
    body := '{"internal":"renew_watch"}'::jsonb, timeout_milliseconds := 30000);
end $$;
create or replace function public.ari_ai_prune() returns void language sql security definer set search_path = public as $$
  delete from ai_calls where status = 'refused' and at < now() - interval '30 days';
  delete from ai_calls where at < now() - interval '400 days';
  delete from ai_triggers where updated_at < now() - interval '30 days';
  delete from ai_jobs where status in ('done', 'failed') and finished_at < now() - interval '90 days' $$;

-- import card (spec 08): the fields duplicate detection needs, nothing else. Read only. Personal connections included on
-- purpose so an import never re-adds one; their notes, drafts and research are not returned.
create or replace function public.ari_ai_import_book() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'company', company, 'title', title, 'linkedin_url', linkedin_url)), '[]'::jsonb)
  from people where deleted_at is null $$;

-- function grants: revoke from everyone, then exactly who may call --------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['ari_ai_hook()', 'ari_ai_caller()', 'ari_ai_spend()',
    'ari_ai_budget_reserve(text, text, text, numeric, text, uuid, uuid, text)', 'ari_ai_call_finish(bigint, text, int, int, numeric, text)',
    'ari_ai_budget_headroom()', 'ari_ai_context(text, uuid)', 'ari_ai_reply_context(bigint)',
    'ari_ai_save_draft(text, text, text, jsonb, text, text)', 'ari_ai_save_triage(bigint, jsonb, jsonb)',
    'ari_ai_save_reply_draft(bigint, text, text, text)', 'ari_ai_save_research(text, uuid, jsonb, jsonb)',
    'ari_ai_job_enqueue(text, uuid, text, jsonb)', 'ari_ai_job_claim(uuid)', 'ari_ai_job_update(uuid, jsonb, text, jsonb, text)', 'ari_ai_job_event(uuid, jsonb)', 'ari_ai_job_events(uuid, int)',
    'ari_ai_trigger_claim(text, text)', 'ari_ai_trigger_done(text, text, text, text)', 'ari_ai_pending_events(int)',
    'ari_ai_notify_dm_ready(text)', 'ari_ai_import_book()', 'ari_gmail_push_config()', 'ari_gmail_watch_set(text, bigint, text)', 'ari_gmail_watch_push(text)',
    'ari_ai_kick()', 'ari_gmail_watch_kick()', 'ari_ai_prune()'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'ari_worker') then execute format('revoke all on function public.%s from ari_worker', f); end if;
    if f not in ('ari_ai_kick()', 'ari_gmail_watch_kick()', 'ari_ai_prune()') then
      execute format('grant execute on function public.%s to service_role', f);
    end if;
  end loop;
end $$;
grant execute on function public.ari_ai_caller() to authenticated;

select cron.unschedule('ari-ai-events') where exists (select 1 from cron.job where jobname = 'ari-ai-events');
select cron.schedule('ari-ai-events', '*/10 * * * *', $c$select public.ari_ai_kick()$c$);
select cron.unschedule('ari-gmail-watch-renew') where exists (select 1 from cron.job where jobname = 'ari-gmail-watch-renew');
select cron.schedule('ari-gmail-watch-renew', '15 20 * * *', $c$select public.ari_gmail_watch_kick()$c$);  -- 01:45 IST daily
select cron.unschedule('ari-ai-prune') where exists (select 1 from cron.job where jobname = 'ari-ai-prune');
select cron.schedule('ari-ai-prune', '40 20 * * *', $c$select public.ari_ai_prune()$c$);                  -- 02:10 IST daily

insert into supabase_migrations.schema_migrations(version, name) values ('0041', 'ai_layer') on conflict do nothing;
commit;
