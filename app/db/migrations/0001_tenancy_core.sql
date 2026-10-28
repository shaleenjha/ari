-- app 0001: tenancy + core domain. workspace_id on every tenant row from day one, composite PK/FK so a row can
-- never point across workspaces, RLS through app.is_member / app.has_role, writes only through command RPCs.
-- Applies to a fresh database (local, CI, a future app project). NOT applied to the live prod project.
create extension if not exists pgcrypto;
create schema if not exists app;
grant usage on schema app to authenticated;

-- ---------- enums ----------
create type app.role_t        as enum ('admin','manager','ae','sdr','agent');
create type app.actor_kind_t  as enum ('ari','sdr','ae','manager','admin','system');
create type app.member_status as enum ('active','invited','revoked');
create type app.account_stage_t as enum ('target','researching','mapped','engaged','meeting_set','meeting_held',
                                         'opportunity','hold','customer','closed_lost','not_a_fit');
create type app.person_stage_t  as enum ('connect_queued','connect_sent','accepted','dm1_sent','dm2_sent','dm3_sent',
                                         'replied','meeting_set','meeting_held','withdrawn','hold');
create type app.review_t        as enum ('pending','lead','personal');
create type app.task_status   as enum ('proposed','todo','ready','in_progress','blocked','done','cancelled');
create type app.task_kind     as enum ('connect','dm','follow_up','reply','research','brief','meeting_prep',
                                       'map_account','ask','handoff','review_draft','hygiene','custom');
create type app.edge_t        as enum ('blocks','spawns','relates');
create type app.meeting_source_t as enum ('linkedin','email','inbound','other');

-- ---------- tenancy ----------
create table app.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Kolkata',
  settings jsonb not null default '{}'::jsonb,           -- ICP, plays, banned phrases, caps
  created_at timestamptz not null default now()
);
create table app.memberships (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  user_id uuid not null,
  role app.role_t not null,
  status app.member_status not null default 'active',
  display_name text,
  timezone text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index on app.memberships (user_id, workspace_id);

-- RLS helpers: SECURITY DEFINER + STABLE, always called as (select app.is_member(workspace_id)) so they cache per statement.
create function app.is_member(ws uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.memberships m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active')
$$;
create function app.has_role(ws uuid, roles app.role_t[]) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.memberships m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active' and m.role = any(roles))
$$;
create function app.my_role(ws uuid) returns app.role_t language sql stable security definer set search_path = '' as $$
  select m.role from app.memberships m where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active'
$$;
create function app.actor_kind(ws uuid) returns app.actor_kind_t language sql stable security definer set search_path = '' as $$
  select case app.my_role(ws) when 'agent' then 'ari' when 'sdr' then 'sdr' when 'ae' then 'ae'
                              when 'manager' then 'manager' when 'admin' then 'admin' else 'system' end::app.actor_kind_t
$$;
revoke all on function app.is_member(uuid), app.has_role(uuid, app.role_t[]), app.my_role(uuid), app.actor_kind(uuid) from public;
grant execute on function app.is_member(uuid), app.has_role(uuid, app.role_t[]), app.my_role(uuid), app.actor_kind(uuid) to authenticated;

-- ---------- domain ----------
create table app.accounts (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null,
  domain text,
  stage app.account_stage_t not null default 'target',
  stage_changed_at timestamptz not null default now(),
  stage_source text not null default 'ari' check (stage_source in ('ari','user')),
  stage_pinned boolean not null default false,
  stage_reason text,
  play_id uuid,
  one_liner text, hook text, hook_date date, hook_url text,
  meeting_status text, meeting_source app.meeting_source_t, meeting_at timestamptz,
  flags text[] not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
create unique index on app.accounts (workspace_id, lower(btrim(name))) where deleted_at is null;

create table app.account_team (
  workspace_id uuid not null, account_id uuid not null, user_id uuid not null, role app.role_t not null,
  primary key (workspace_id, account_id, user_id),
  foreign key (workspace_id, account_id) references app.accounts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, user_id) references app.memberships(workspace_id, user_id) on delete cascade
);

create table app.plays (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  name text not null, description text, active boolean not null default true,
  primary key (workspace_id, id), unique (workspace_id, name)
);
alter table app.accounts add foreign key (workspace_id, play_id) references app.plays(workspace_id, id);

create table app.people (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  account_id uuid,
  owner_user_id uuid,
  full_name text not null,
  title text,
  linkedin_url text,
  linkedin_vanity text generated always as (lower(substring(linkedin_url from 'linkedin\.com/in/([^/?#]+)'))) stored,
  stage app.person_stage_t not null default 'connect_queued',
  stage_changed_at timestamptz not null default now(),
  review app.review_t not null default 'pending',
  play_id uuid,
  why_this_person text, context text, notes text,
  connect_sent_at timestamptz, accepted_at timestamptz, dm1_sent_at timestamptz,
  dm2_due date, dm2_sent_at timestamptz, dm3_due date, dm3_sent_at timestamptz,
  replied_at timestamptz, meeting_at timestamptz, withdrawn_at timestamptz,
  ts_approx text[] not null default '{}',                 -- event fields known only to the day (carried from prod 0028)
  snooze_until date, skipped_on date,
  flags text[] not null default '{}',
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, account_id) references app.accounts(workspace_id, id) on delete set null (account_id),
  foreign key (workspace_id, play_id) references app.plays(workspace_id, id)
);
create index on app.people (workspace_id, account_id);
create index on app.people (workspace_id, stage);
create unique index on app.people (workspace_id, linkedin_vanity) where linkedin_vanity is not null and deleted_at is null;

create table app.drafts (                                 -- current draft per person and kind; history in draft_revisions
  workspace_id uuid not null, person_id uuid not null,
  kind text not null check (kind in ('dm1','dm2','dm3','reply')),
  body text not null default '',
  author_kind app.actor_kind_t not null default 'ari',
  updated_at timestamptz not null default now(),
  primary key (workspace_id, person_id, kind),
  foreign key (workspace_id, person_id) references app.people(workspace_id, id) on delete cascade
);
create table app.draft_revisions (
  workspace_id uuid not null, id bigint generated always as identity, person_id uuid not null, kind text not null,
  body text not null, author_kind app.actor_kind_t not null, author_user_id uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, person_id) references app.people(workspace_id, id) on delete cascade
);
create table app.sent_messages (
  workspace_id uuid not null, id uuid not null default gen_random_uuid(), person_id uuid not null,
  kind text not null, body text not null, sent_at timestamptz not null default now(), sent_by uuid,
  primary key (workspace_id, id),
  foreign key (workspace_id, person_id) references app.people(workspace_id, id) on delete cascade
);
create table app.replies (
  workspace_id uuid not null, id uuid not null default gen_random_uuid(), person_id uuid,
  snippet text, pasted_text text, received_at timestamptz not null, source_ref text,
  status text not null default 'open' check (status in ('open','answered','meeting','not_now')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, person_id) references app.people(workspace_id, id) on delete set null (person_id)
);
create table app.account_briefs (
  workspace_id uuid not null, account_id uuid not null,
  status text not null default 'queued' check (status in ('queued','building','ready','reviewed')),
  body jsonb not null default '{}'::jsonb,                 -- thesis, why_now[{text,label verified|inference|hypothesis}], committee, angle
  quick_check jsonb not null default '[]'::jsonb, check_via text check (check_via in ('answered','skip')),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, account_id),
  foreign key (workspace_id, account_id) references app.accounts(workspace_id, id) on delete cascade
);
create table app.research (
  workspace_id uuid not null, id uuid not null default gen_random_uuid(), account_id uuid, person_id uuid,
  kind text not null, body text not null, source_url text, confidence text check (confidence in ('verified','inference','hypothesis')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, account_id) references app.accounts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.people(workspace_id, id) on delete cascade
);
create table app.memory_items (                           -- facts, style rules (was copy_guidance), objections; pgvector later
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  subject_type text not null check (subject_type in ('workspace','account','person','user')),
  subject_id uuid, kind text not null check (kind in ('fact','preference','style_rule','objection')),
  text text not null, source_url text, source_kind text, confidence numeric,
  valid_from timestamptz not null default now(), valid_to timestamptz, created_by uuid,
  primary key (workspace_id, id)
);

-- ---------- task graph (the shared brain's spine) ----------
create table app.tasks (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(),
  account_id uuid, person_id uuid,
  kind app.task_kind not null, title text not null, body jsonb not null default '{}'::jsonb,
  status app.task_status not null default 'todo',
  assignee_user_id uuid, assignee_role app.role_t not null,
  created_by uuid not null, created_by_kind app.actor_kind_t not null,
  priority smallint not null default 2, due_at timestamptz, snooze_until timestamptz,
  claimed_by uuid, claimed_until timestamptz,
  version int not null default 1,
  source_job_id uuid, parent_id uuid,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), done_at timestamptz,
  primary key (workspace_id, id),
  foreign key (workspace_id, account_id) references app.accounts(workspace_id, id) on delete cascade,
  foreign key (workspace_id, person_id) references app.people(workspace_id, id) on delete cascade,
  foreign key (workspace_id, parent_id) references app.tasks(workspace_id, id) on delete set null (parent_id)
);
create index on app.tasks (workspace_id, assignee_user_id, status, due_at);
create index on app.tasks (workspace_id, account_id, status);
create index on app.tasks (workspace_id, assignee_role, status);

create table app.task_edges (
  workspace_id uuid not null, from_id uuid not null, to_id uuid not null, type app.edge_t not null,
  primary key (workspace_id, from_id, to_id, type),
  check (from_id <> to_id),
  foreign key (workspace_id, from_id) references app.tasks(workspace_id, id) on delete cascade,
  foreign key (workspace_id, to_id) references app.tasks(workspace_id, id) on delete cascade
);
create table app.task_events (                            -- append-only; the cross-role feed
  workspace_id uuid not null, id bigint generated always as identity, task_id uuid not null,
  actor_id uuid, actor_kind app.actor_kind_t not null,
  type text not null check (type in ('created','status','assign','comment','nudge','claim','accepted')),
  from_value text, to_value text, payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, task_id) references app.tasks(workspace_id, id) on delete cascade
);
create index on app.task_events (workspace_id, task_id, created_at);

create table app.activity (                               -- who did what (ari / sdr / ae / ...), across all subjects
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id bigint generated always as identity,
  actor_kind app.actor_kind_t not null, actor_user_id uuid,
  verb text not null, subject_type text not null check (subject_type in ('account','person','task','brief','draft','reply','workspace')),
  subject_id uuid, payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (workspace_id, id)
);
create index on app.activity (workspace_id, subject_type, subject_id, created_at);

-- ---------- ops / delivery / ingest / reporting ----------
create table app.command_log (                            -- op_id idempotency for offline replays
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  op_id uuid not null, user_id uuid, command text not null, result jsonb, created_at timestamptz not null default now(),
  primary key (workspace_id, op_id)
);
create table app.jobs (                                   -- job system queue table (pgmq optional later; see docs/job-system.md)
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(), kind text not null, payload jsonb not null default '{}'::jsonb,
  status text not null default 'ready' check (status in ('ready','running','done','failed','dead')),
  attempts int not null default 0, max_attempts int not null default 5, run_after timestamptz not null default now(),
  idempotency_key text, locked_by text, locked_until timestamptz, last_error text, result jsonb, cost_usd numeric,
  created_at timestamptz not null default now(), finished_at timestamptz,
  primary key (workspace_id, id), unique (workspace_id, kind, idempotency_key)
);
create index on app.jobs (status, run_after) where status = 'ready';
create table app.ingest_events (                          -- gmail-ingest output (shadow mode first)
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(), source text not null default 'gmail', source_msg_id text not null,
  kind text not null check (kind in ('accept','reply','invite_sent','unknown')),
  parsed jsonb not null, matched_person_id uuid, match_method text check (match_method in ('profile_url','vanity','name_company','none')),
  mode text not null default 'shadow' check (mode in ('shadow','live')),
  received_at timestamptz not null, created_at timestamptz not null default now(),
  primary key (workspace_id, id), unique (workspace_id, source, source_msg_id),
  foreign key (workspace_id, matched_person_id) references app.people(workspace_id, id) on delete set null (matched_person_id)
);
create table app.hygiene_findings (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(), check_key text not null, entity_type text not null, entity_id uuid not null,
  detail jsonb not null default '{}'::jsonb, status text not null default 'open' check (status in ('open','dismissed','fixed','gone')),
  first_seen timestamptz not null default now(), last_seen timestamptz not null default now(), resolution jsonb,
  primary key (workspace_id, id), unique (workspace_id, check_key, entity_type, entity_id)
);
create table app.notifications (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id uuid not null default gen_random_uuid(), user_id uuid not null, kind text not null, title text not null, body text,
  dedupe_key text, status text not null default 'queued' check (status in ('queued','sent','failed','dead','read')),
  attempts int not null default 0, created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, user_id) references app.memberships(workspace_id, user_id) on delete cascade
);
create unique index on app.notifications (workspace_id, user_id, dedupe_key) where dedupe_key is not null;
create table app.devices (
  workspace_id uuid not null, user_id uuid not null, id uuid not null default gen_random_uuid(),
  kind text not null check (kind in ('webpush','expo')), endpoint text not null, keys jsonb, label text,
  last_ok_at timestamptz, created_at timestamptz not null default now(),
  primary key (workspace_id, id),
  foreign key (workspace_id, user_id) references app.memberships(workspace_id, user_id) on delete cascade
);
create table app.metric_facts (                           -- one dated, deduped metric event; Report RPCs group over it
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  id bigint generated always as identity, metric text not null, occurred_at timestamptz not null, approx boolean not null default false,
  user_id uuid, account_id uuid, person_id uuid, value numeric not null default 1, dims jsonb not null default '{}'::jsonb,
  dedupe_key text,
  primary key (workspace_id, id), unique (workspace_id, metric, dedupe_key)
);
create index on app.metric_facts (workspace_id, metric, occurred_at);
create table app.usage_days (
  workspace_id uuid not null, user_id uuid not null, day date not null,
  seconds int not null default 0 check (seconds between 0 and 86400), opens int not null default 0,
  primary key (workspace_id, user_id, day),
  foreign key (workspace_id, user_id) references app.memberships(workspace_id, user_id) on delete cascade
);

-- ---------- RLS: read = member of the workspace; writes only through RPCs ----------
do $$ declare t text; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'app' and c.relkind = 'r' loop
    execute format('alter table app.%I enable row level security', t);
    execute format('alter table app.%I force row level security', t);
    execute format('revoke all on app.%I from public, anon, authenticated', t);
    execute format('grant select on app.%I to authenticated', t);
  end loop;
end $$;
create policy ws_read on app.workspaces for select to authenticated using ((select app.is_member(id)));
create policy own_or_ws_read on app.memberships for select to authenticated using ((select app.is_member(workspace_id)));
do $$ declare t text; begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'app' and c.relkind = 'r' and c.relname not in ('workspaces','memberships','usage_days','notifications','devices') loop
    execute format('create policy ws_read on app.%I for select to authenticated using ((select app.is_member(workspace_id)))', t);
  end loop;
end $$;
-- personal rows: only the user's own
create policy own_read on app.usage_days    for select to authenticated using (user_id = (select auth.uid()) and (select app.is_member(workspace_id)));
create policy own_read on app.notifications for select to authenticated using (user_id = (select auth.uid()) and (select app.is_member(workspace_id)));
create policy own_read on app.devices       for select to authenticated using (user_id = (select auth.uid()) and (select app.is_member(workspace_id)));
