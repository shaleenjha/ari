-- Ari v17 schema (Oct 15, 2026). Supersedes the unapplied Oct 15 draft (copy at work/v17/0001_init.pre_v17.sql).
-- Mirrors the Sheet "Outbound HQ" (tabs People, Accounts, Queue, Log, Brief, Emails, Book) so the Sheet can
-- become a mirror. Single user: Google sign-in allowlist, RLS on every table.
-- Hark writes with the service_role key (bypasses RLS); the app uses the anon key + Owner's session.
-- Sync semantics: every mirror row carries updated_at, updated_by and field_ts (per-field last-write time)
-- so two phones + the Sheet worker resolve by last write per field. Writes from the app go through
-- public.apply_op(op_id, ...) which is idempotent on op_id (ops table).

create extension if not exists pgcrypto;

-- ---------- access ----------
create or replace function public.is_owner() returns boolean
language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'owner@example.com'
     and coalesce((auth.jwt() -> 'user_metadata' ->> 'email_verified')::boolean, true)
$$;

-- who wrote a row: apply_op/sync set it explicitly; otherwise 'app' for Owner's session, 'hark' for service_role
-- ('x-ari-actor' request header lets Hark's sync say 'sheet' or 'backfill' through PostgREST)
create or replace function public.current_actor() returns text language sql stable as $$
  select coalesce(nullif(current_setting('ari.actor', true), ''),
                  case when auth.role() = 'service_role'
                       then nullif(left(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-ari-actor', 40), '') end,
                  case when auth.role() = 'authenticated' then 'app' else 'hark' end)
$$;

-- stamps updated_at / updated_by and per-field write times on every update of a mirror table
create or replace function public.touch_row() returns trigger language plpgsql as $$
declare o jsonb; n jsonb; k text; ts jsonb;
begin
  if tg_op = 'INSERT' then
    new.updated_at := coalesce(new.updated_at, now());
    new.updated_by := coalesce(new.updated_by, public.current_actor());
    new.field_ts := coalesce(new.field_ts, '{}'::jsonb);
    return new;
  end if;
  o := to_jsonb(old); n := to_jsonb(new); ts := coalesce(new.field_ts, '{}'::jsonb);
  new.updated_at := now();
  if new.updated_by is not distinct from old.updated_by then new.updated_by := public.current_actor(); end if;
  for k in select jsonb_object_keys(n) loop
    if k not in ('updated_at','updated_by','field_ts','created_at','extra')
       and (n -> k) is distinct from (o -> k)
       and (ts ->> k) is not distinct from (old.field_ts ->> k) then
      ts := ts || jsonb_build_object(k, now());
    end if;
  end loop;
  new.field_ts := ts;
  return new;
end $$;

-- ---------- plays (market tags) ----------
create table public.plays (
  name text primary key,
  description text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into public.plays (name, description) values
  ('AI Data Economy', 'Companies whose product is training/eval data or RL environments (e.g. Merquavel, Provannique, Luvrastine, Revaquorn). Proposed split, awaiting Owner''s confirm.'),
  ('AI Data Sanitization', 'Companies sanitizing their own sensitive data before training, inference or sharing. Proposed split, awaiting Owner''s confirm.');

-- ---------- Sheet mirror: Accounts ----------
create table public.accounts (
  id uuid primary key default gen_random_uuid(),
  company text not null,                         -- Sheet key (case-insensitive unique)
  owner text,                                    -- AE full name, e.g. Idris Mockwright
  ae text generated always as (split_part(coalesce(owner, ''), ' ', 1)) stored,
  one_liner text,
  hook text,
  hook_date date,
  hook_url text,
  why_thrandvex text,
  suggested_order text,
  status text,                                   -- Active | Hold | ...
  play text references public.plays(name) on update cascade,
  meeting_status text,                           -- '' | set | held | ...
  meeting_source text,
  meeting_date text,                             -- free text as typed (date or date+time)
  meeting_person text,
  meeting_ae text,
  meeting_notes text,
  flags text[] not null default '{}',
  extra jsonb not null default '{}'::jsonb,      -- Sheet columns not modelled above (lossless mirror)
  sheet_row int,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  field_ts jsonb not null default '{}'::jsonb
);
create unique index accounts_company_key on public.accounts (lower(btrim(company)));

-- ---------- Sheet mirror: People ----------
create sequence public.people_app_seq;
create table public.people (
  id text primary key default ('PA' || lpad(nextval('public.people_app_seq')::text, 4, '0')),  -- Sheet ids P001...; app-made PA0001...
  account_id uuid references public.accounts(id) on delete set null,
  company text,
  owner text,
  name text not null,
  title text,
  linkedin_url text,
  role text,
  route text,                                    -- Direct | Founder via Aide
  connect_day date,
  stage text not null default 'Connect queued',  -- Connect queued | Connect sent | Accepted | DM1 sent | DM2 sent | DM3 sent | Replied | Meeting | Withdrawn | Hold | Founder
  stage_changed_at timestamptz,
  dm text,                                       -- DM1 draft
  dm2_text text,
  dm3_text text,
  connect_sent timestamptz,                      -- per-stage timestamps (Sheet shows the IST date)
  accepted timestamptz,
  dm1_sent timestamptz,
  dm2_due date,
  dm2_sent timestamptz,
  dm3_due date,
  dm3_sent timestamptz,
  replied timestamptz,
  meeting timestamptz,
  withdrawn timestamptz,
  next_action text,
  notes text,
  source text,
  review text check (review in ('lead','pending','personal')),
  research text,                                 -- research status: Researching | Researching now | Draft ready | done | No signal yet | Flagged, no draft | ...
  why_this_person text,                          -- Sheet column "why"
  snooze_until date,
  skipped date,
  play text references public.plays(name) on update cascade,   -- overrides the account's play when set
  lane text not null default 'shal' check (lane in ('shal','founder','wren')),
  flags text[] not null default '{}',
  extra jsonb not null default '{}'::jsonb,
  sheet_row int,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  field_ts jsonb not null default '{}'::jsonb
);
create index on public.people(account_id);
create index on public.people(stage);
create index on public.people(review);
create index on public.people(updated_at);

-- stage_changed_at follows stage
create or replace function public.people_stage_ts() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then new.stage_changed_at := now(); end if;
  return new;
end $$;
create trigger people_stage_ts before insert or update on public.people for each row execute function public.people_stage_ts();

-- ---------- Sheet mirror: Queue (asks / chat / jobs for Hark) ----------
create sequence public.queue_app_seq;
create table public.queue (
  id text primary key default ('QA' || lpad(nextval('public.queue_app_seq')::text, 4, '0')),   -- Sheet ids Q0001...; app-made QA0001...
  created timestamptz not null default now(),
  action text not null,                          -- Ask | Chat | App change | Draft DM1 | Draft reply | New signal | ...
  target text,
  details text,
  status text not null default 'queued',         -- queued | running | done | failed
  result text,
  context jsonb not null default '{}'::jsonb,    -- app screen/entity context for chat items
  extra jsonb not null default '{}'::jsonb,
  sheet_row int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  field_ts jsonb not null default '{}'::jsonb
);
create index on public.queue(status, created);

-- ---------- Sheet mirror: Log (append-only activity) ----------
create table public.log_entries (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  person_id text,
  event text not null,
  detail text,
  source text not null default 'app' check (source in ('sheet','app','hark','backfill')),
  sheet_key text unique,                         -- dedupe key for Sheet rows (md5 of row + occurrence)
  created_at timestamptz not null default now()
);
create index on public.log_entries(ts);
create index on public.log_entries(person_id, ts);

-- ---------- Sheet mirror: Brief (key/value) ----------
create table public.brief (
  key text primary key,
  value text,
  updated_at timestamptz not null default now(),
  updated_by text,
  field_ts jsonb not null default '{}'::jsonb
);

-- ---------- Sheet mirror: Emails ----------
create table public.emails (
  id text primary key,
  created timestamptz,
  to_name text, to_email text, company text, subject text, body text,
  status text,
  extra jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text,
  field_ts jsonb not null default '{}'::jsonb
);

-- ---------- Sheet mirror: Book (AE books; worker-owned, Sheet -> DB only) ----------
create table public.book (
  key text primary key,                          -- lower(company) + '#' + occurrence
  company text not null,
  owner text,
  tier text, flag text, cluster text, fit text,
  last_checked text, last_signal text, website text,
  play text references public.plays(name) on update cascade,
  sheet_row int,
  updated_at timestamptz not null default now()
);

do $$
declare t text;
begin
  foreach t in array array['accounts','people','queue','brief','emails'] loop
    execute format('create trigger touch_row before insert or update on public.%I for each row execute function public.touch_row()', t);
  end loop;
end $$;

-- ---------- idempotent ops from phones ----------
create table public.ops (
  op_id text primary key,                        -- client-generated (uuid); a repeat is ignored
  kind text not null,                            -- set | mark | undo | insert
  target_table text not null,
  target_id text,
  payload jsonb not null default '{}'::jsonb,
  client_ts timestamptz,                         -- when Owner tapped (device clock)
  device text,                                   -- e.g. 'pixel', 'iphone'
  status text not null default 'applied' check (status in ('applied','partial','stale','error')),
  result jsonb,
  created_at timestamptz not null default now()
);
create index on public.ops(created_at);

-- ---------- native-app tables (kept from the Oct 15 draft) ----------
create table public.research (
  id uuid primary key default gen_random_uuid(),
  person_id text references public.people(id) on delete cascade,
  account_id uuid references public.accounts(id) on delete cascade,
  source_url text not null,
  dated date,
  summary text not null,
  fetched_at timestamptz not null default now(),
  check (person_id is not null or account_id is not null)
);

create table public.decisions (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  context text,
  options jsonb not null default '[]',
  ari_opinion text,
  status text not null default 'open' check (status in ('open','answered','applied','expired')),
  answer text,
  answered_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.threads (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('main','item')),
  entity_type text check (entity_type in ('person','account','task','decision','note','step','screen','app')),
  entity_id text,
  title text not null,
  last_message_at timestamptz,
  archived boolean not null default false,
  check ((kind = 'main') = (entity_type is null)),
  unique (entity_type, entity_id)
);
create unique index threads_one_main on public.threads ((kind)) where kind = 'main';

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  origin text not null default 'system' check (origin in ('chat','system','wren')),
  thread_id uuid references public.threads(id) on delete set null,
  status text not null default 'queued' check (status in ('queued','running','needs_you','done','failed')),
  steps text[] not null default '{}',
  current_step int not null default 0,
  eta_minutes int,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table public.task_events (
  id bigint generated always as identity primary key,
  task_id uuid not null references public.tasks(id) on delete cascade,
  ts timestamptz not null default now(),
  step int,
  text text not null
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid references public.threads(id) on delete set null,
  author text not null check (author in ('you','ari')),
  body text not null,
  kind text not null default 'text' check (kind in ('text','voice','media','file','task_card')),
  screen text,
  entity_type text check (entity_type in ('person','account','task','decision','note','step','screen','app')),
  entity_id text,
  context jsonb not null default '{}'::jsonb,
  tags jsonb not null default '[]'::jsonb,
  task_id uuid references public.tasks(id) on delete set null,
  person_ids text[] not null default '{}',
  client_id text unique,
  status text not null default 'sent' check (status in ('sent','seen','answered')),
  created_at timestamptz not null default now(),
  check ((entity_type is null) = (entity_id is null))
);
create index on public.messages(created_at);
create index on public.messages(entity_type, entity_id, created_at);
create index on public.messages using gin (tags jsonb_path_ops);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  storage_path text not null,
  mime text, size int, sha256 text
);

create table public.ari_notes (
  id uuid primary key default gen_random_uuid(),
  body text not null,
  needs_you boolean not null default false,
  action jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.events (
  id bigint generated always as identity primary key,
  ts timestamptz not null default now(),
  actor text not null check (actor in ('you','system')),
  verb text not null,
  person_id text, account_id uuid,
  payload jsonb not null default '{}',
  prev_hash text,
  hash text
);
create index on public.events(person_id, ts);

create or replace function public.events_chain() returns trigger language plpgsql as $$
declare p text;
begin
  select hash into p from public.events order by id desc limit 1;
  new.prev_hash := p;
  new.hash := encode(extensions.digest(coalesce(p,'') || new.ts::text || new.actor || new.verb ||
              coalesce(new.person_id,'') || new.payload::text, 'sha256'), 'hex');
  return new;
end $$;
create trigger events_chain before insert on public.events for each row execute function public.events_chain();

create table public.targets (
  week date not null, metric text not null, min int, max int,
  primary key (week, metric)
);

create table public.app_changes (
  id uuid primary key default gen_random_uuid(),
  request text not null, diff_ref text,
  channel text not null default 'preview' check (channel in ('preview','production')),
  approved_at timestamptz, created_at timestamptz not null default now()
);

-- sync bookkeeping (service_role only; RLS on, no policies for the app)
create table public.sync_state (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- ---------- apply_op: the one write path for phones ----------
-- p_kind:
--   'set'    patch fields of one row: p_table in (people, accounts, queue, brief), p_id = row id
--            (accounts: uuid or company name). Per-field last-write-wins on p_client_ts.
--   'mark'   people stage tick: p_patch = {"field": "connect_sent|accepted|dm1_sent|dm2_sent|dm3_sent|replied|meeting|withdrawn"}
--            (same cadence as Apps Script mark(): DM2 +4d, DM3 +7d, DM1 due the day they accept)
--   'undo'   clear a stage tick: p_patch = {"field": ...}; stage falls back to the latest remaining tick
--   'insert' new row in queue | people | log_entries (p_patch = the row; ids default)
-- Returns {ok, duplicate, applied[], stale[], row}.
create or replace function public.apply_op(p_op_id text, p_kind text, p_table text, p_id text,
                                           p_patch jsonb default '{}'::jsonb,
                                           p_client_ts timestamptz default now(),
                                           p_device text default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  prev jsonb; res jsonb; rowj jsonb; k text; applied text[] := '{}'; stale text[] := '{}';
  keycol text; rid text; cur jsonb; filt jsonb := '{}'::jsonb; ts jsonb := '{}'::jsonb; sets text := '';
  f text; today date := (now() at time zone 'Asia/Kolkata')::date; tsv timestamptz := coalesce(p_client_ts, now());
  stage_by jsonb := '{"connect_sent":"Connect sent","accepted":"Accepted","dm1_sent":"DM1 sent","dm2_sent":"DM2 sent","dm3_sent":"DM3 sent","replied":"Replied","meeting":"Meeting","withdrawn":"Withdrawn"}';
  p record; actor text := 'app' || coalesce(':' || p_device, '');
  allowed text[];
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  insert into public.ops(op_id, kind, target_table, target_id, payload, client_ts, device)
  values (p_op_id, p_kind, p_table, p_id, coalesce(p_patch, '{}'), p_client_ts, p_device)
  on conflict (op_id) do nothing;
  if not found then
    select result into prev from public.ops where op_id = p_op_id;
    return coalesce(prev, '{}'::jsonb) || jsonb_build_object('duplicate', true);
  end if;
  perform set_config('ari.actor', actor, true);

  if p_kind in ('mark','undo') then
    if p_table <> 'people' then raise exception 'mark/undo only on people'; end if;
    f := p_patch ->> 'field';
    if not stage_by ? f then raise exception 'bad field %', f; end if;
    select * into p from public.people where id = p_id for update;
    if not found then raise exception 'person not found: %', p_id; end if;
    if p_kind = 'mark' then
      if to_jsonb(p) ->> f is not null then
        res := jsonb_build_object('ok', true, 'already', true);
      else
        execute format('update public.people set %I = $1, stage = $2 where id = $3', f) using tsv, stage_by ->> f, p_id;
        if f = 'accepted' then
          update public.people set next_action = 'DM1 on ' || to_char(today, 'YYYY-MM-DD') where id = p_id;
        elsif f = 'dm1_sent' then
          update public.people set dm2_due = today + 4, dm3_due = today + 7,
                 next_action = 'DM2 on ' || to_char(today + 4, 'YYYY-MM-DD') where id = p_id;
        elsif f = 'dm2_sent' then
          update public.people set next_action = 'DM3 on ' || to_char(coalesce(p.dm3_due, today + 3), 'YYYY-MM-DD') where id = p_id;
        elsif f = 'dm3_sent' then
          update public.people set next_action = 'Sequence done. Park or try another angle.' where id = p_id;
        elsif f = 'replied' then
          update public.people set next_action = 'Hark drafting your answer' where id = p_id;
          insert into public.queue(action, target, details, updated_by)
          values ('Draft reply', p_id, p.name || ' (' || coalesce(p.company,'') || ') replied on LinkedIn. Paste their reply in the Hark chat for a sharper draft.', actor);
        elsif f = 'meeting' then
          update public.people set next_action = 'Log meeting in SFDC' where id = p_id;
        elsif f = 'withdrawn' then
          update public.people set next_action = '' where id = p_id;
        end if;
        insert into public.log_entries(ts, person_id, event, detail, source)
        values (tsv, p_id, stage_by ->> f, p.name || ' · ' || coalesce(p.company,''), 'app');
        res := jsonb_build_object('ok', true, 'applied', jsonb_build_array(f));
      end if;
    else
      execute format('update public.people set %I = null where id = $1', f) using p_id;
      update public.people x set stage = coalesce(
        case when x.meeting is not null then 'Meeting' when x.replied is not null then 'Replied'
             when x.dm3_sent is not null then 'DM3 sent' when x.dm2_sent is not null then 'DM2 sent'
             when x.dm1_sent is not null then 'DM1 sent' when x.accepted is not null then 'Accepted'
             when x.connect_sent is not null then 'Connect sent' end, 'Connect queued')
      where id = p_id;
      insert into public.log_entries(ts, person_id, event, detail, source) values (tsv, p_id, 'Undo ' || f, p.name, 'app');
      res := jsonb_build_object('ok', true, 'applied', jsonb_build_array(f));
    end if;
    select to_jsonb(x) into rowj from public.people x where id = p_id;

  elsif p_kind = 'insert' then
    if p_table not in ('queue','people','log_entries') then raise exception 'insert not allowed on %', p_table; end if;
    filt := jsonb_strip_nulls(p_patch || case when p_table = 'log_entries' then '{}'::jsonb
                                              else jsonb_build_object('updated_by', actor) end);
    select string_agg(format('%I', key), ', ') into sets from jsonb_object_keys(filt) key;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) returning to_jsonb(%I.*)',
                   p_table, sets, sets, p_table, p_table) using filt into rowj;
    res := jsonb_build_object('ok', true, 'applied', '["insert"]'::jsonb);

  elsif p_kind = 'set' then
    if p_table not in ('people','accounts','queue','brief') then raise exception 'set not allowed on %', p_table; end if;
    keycol := case p_table when 'brief' then 'key' else 'id' end;
    rid := p_id;
    if p_table = 'accounts' and rid !~* '^[0-9a-f-]{36}$' then
      select id::text into rid from public.accounts where lower(btrim(company)) = lower(btrim(p_id));
      if rid is null then  -- like Apps Script setAccount: create the account row
        insert into public.accounts(company, updated_by) values (btrim(p_id), actor) returning id::text into rid;
      end if;
    end if;
    if p_table = 'brief' then
      insert into public.brief(key, updated_by) values (rid, actor) on conflict (key) do nothing;
    end if;
    execute format('select to_jsonb(t) from public.%I t where %I::text = $1 for update', p_table, keycol) into cur using rid;
    if cur is null then raise exception '% not found: %', p_table, p_id; end if;
    for k in select jsonb_object_keys(p_patch) loop
      if k in ('id','key','created_at','updated_at','updated_by','field_ts','sheet_row','ae') or not (cur ? k) then
        raise exception 'field not editable: %', k;
      end if;
      if (cur -> 'field_ts' ->> k) is not null and (cur -> 'field_ts' ->> k)::timestamptz > tsv then
        stale := stale || k;
      else
        applied := applied || k;
        filt := filt || jsonb_build_object(k, p_patch -> k);
        ts := ts || jsonb_build_object(k, tsv);
        sets := sets || format('%I = r.%I, ', k, k);
      end if;
    end loop;
    if array_length(applied, 1) > 0 then
      execute format('update public.%I t set %s field_ts = t.field_ts || $2, updated_by = $3 from jsonb_populate_record(null::public.%I, $1) r where t.%I::text = $4 returning to_jsonb(t.*)',
                     p_table, sets, p_table, keycol)
        using filt, ts, actor, rid into rowj;
      if p_table = 'accounts' and filt ->> 'meeting_status' = 'set' then
        insert into public.log_entries(ts, person_id, event, detail, source)
        values (tsv, null, 'Meeting set', concat_ws(' · ', rowj ->> 'company', rowj ->> 'meeting_source', rowj ->> 'meeting_person', rowj ->> 'meeting_date'), 'app');
      elsif p_table = 'people' then
        insert into public.log_entries(ts, person_id, event, detail, source)
        values (tsv, rid, 'Ari edit ' || array_to_string(applied, ','), concat_ws(' / ', rowj ->> 'name', rowj ->> 'company'), 'app');
      end if;
    else
      rowj := cur;
    end if;
    res := jsonb_build_object('ok', true, 'applied', to_jsonb(applied), 'stale', to_jsonb(stale));
  else
    raise exception 'unknown op kind %', p_kind;
  end if;

  res := res || jsonb_build_object('row', rowj, 'duplicate', false);
  update public.ops set result = res - 'row',
         status = case when cardinality(stale) > 0 and cardinality(applied) = 0 then 'stale'
                       when cardinality(stale) > 0 then 'partial' else 'applied' end
   where op_id = p_op_id;
  return res;
end $$;
revoke all on function public.apply_op(text, text, text, text, jsonb, timestamptz, text) from public, anon;
grant execute on function public.apply_op(text, text, text, text, jsonb, timestamptz, text) to authenticated, service_role;

-- ---------- reports come from the log ----------
create view public.weekly_metrics with (security_invoker = true) as
select date_trunc('week', ts at time zone 'Asia/Kolkata')::date as week,
       count(*) filter (where event = 'Connect sent') as connects,
       count(*) filter (where event = 'Accepted')     as accepts,
       count(*) filter (where event in ('DM1 sent','DM2 sent','DM3 sent')) as dms,
       count(*) filter (where event = 'Replied')      as replies,
       count(*) filter (where event in ('Meeting','Meeting set')) as meetings
from public.log_entries group by 1;

-- ---------- row-level security: owner only, everywhere ----------
do $$
declare t text;
begin
  foreach t in array array['plays','accounts','people','queue','log_entries','brief','emails','book','ops',
                           'research','decisions','threads','tasks','task_events','messages','attachments',
                           'ari_notes','events','targets','app_changes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy owner_all on public.%I for all to authenticated using (public.is_owner()) with check (public.is_owner())', t);
  end loop;
end $$;
alter table public.sync_state enable row level security;   -- service_role only

-- append-only tables, even for the owner
drop policy owner_all on public.events;
create policy owner_read on public.events for select to authenticated using (public.is_owner());
create policy owner_insert on public.events for insert to authenticated with check (public.is_owner());
revoke update, delete on public.events from authenticated, anon;
revoke delete on public.ops from authenticated, anon;   -- ops are written through apply_op (security invoker)
drop policy owner_all on public.log_entries;
create policy owner_read on public.log_entries for select to authenticated using (public.is_owner());
create policy owner_insert on public.log_entries for insert to authenticated with check (public.is_owner());
revoke update, delete on public.log_entries from authenticated, anon;

-- anon gets nothing anywhere
revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on public.sync_state from authenticated;

-- ---------- realtime ----------
alter publication supabase_realtime add table public.people, public.accounts, public.queue, public.brief, public.log_entries;

insert into public.threads (kind, title) values ('main', 'Ari');
