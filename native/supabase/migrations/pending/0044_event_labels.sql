-- 0044 Event labels (PENDING, not applied anywhere; written Oct 27 2026, step 1 of docs/specs/09-ingest-labels.md).
-- Owner's decisions (Oct 27 2026 20:57 IST): 2 = A, the table lives in schema app of the live database so the rebuild inherits it.
-- Does not depend on 0039 to 0041 (still pending). Needs 0033 (schema app, workspace "Owner") and 0035 (app.is_member).
-- Rollback: 0044_event_labels_rollback.sql. Checks: test/checks_after_0044.sql (staging/prod-safe, ends in a deliberate raise).
--   1. app.events: one append-only row per outreach event (connect_sent, accept, dm_sent, reply, meeting_booked, withdraw,
--      profile_scan_done, signal_found) with a small labels object. Unique (workspace_id, event_type, dedupe_key) = idempotent.
--      Labels hold enums, numbers, ids, dates and a source domain only: never message text, names, emails or links.
--   2. app.event_label_vocab(): the vocabulary per event_type, the SAME JSON scripts/ingest_labels.py vocab prints
--      (scripts/test_ingest_labels.py fails if they drift). app.event_labels_check(type, labels): null = clean, else the fault.
--   3. public.ari_worker_event_record(...): the only write path for the worker (ari_worker gets nothing on schema app).
--      SECURITY DEFINER, empty search_path. Validates, then inserts or re-labels the row in place. A row labeled by Owner keeps
--      its judged reply labels forever; a code re-label never wipes judged labels a model or the worker wrote.
--      labeled_by 'shal' is not accepted here (Owner's corrections arrive through a later app RPC with its own go).
--   4. RLS: read for the owner or a workspace member (same shape as 0035); no write policy (writes only through the RPC).
--      Grants are explicit for every role incl. service_role (Supabase stops auto-granting new objects Oct 30 2026).
-- Lock profile: new objects only (create table / index / function / policy on the new table). No existing table is locked.
-- Re-runnable; the ledger row is written last, after the end state is checked.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$ begin
  if to_regnamespace('app') is null or to_regclass('app.workspaces') is null or to_regprocedure('app.is_member(uuid)') is null
     or to_regprocedure('public.is_owner()') is null then
    raise exception '0044 needs 0033 (schema app) and 0035 (app.is_member) applied first';
  end if;
  if not exists (select 1 from app.workspaces where id = 'f5a1e000-0000-4000-8000-000000000001') then
    raise exception '0044 needs workspace Owner (0033)';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ari_worker') or not exists (select 1 from pg_roles where rolname = 'service_role') then
    raise exception '0044 needs roles ari_worker and service_role';
  end if;
end $$;

-- 1. table -----------------------------------------------------------------------------------------------------------------
create table if not exists app.events (
  workspace_id uuid not null default 'f5a1e000-0000-4000-8000-000000000001' references app.workspaces(id),
  id bigint generated always as identity,
  event_type text not null check (event_type in ('connect_sent', 'accept', 'dm_sent', 'reply', 'meeting_booked', 'withdraw',
                                                 'profile_scan_done', 'signal_found')),
  dedupe_key text not null check (dedupe_key ~ '^[A-Za-z0-9:_.-]{1,120}$'),
  person_id text check (person_id ~ '^P[0-9]{1,9}$'),
  account_id uuid,
  ae text check (length(ae) <= 40),
  occurred_at timestamptz not null,
  approx boolean not null default false,
  source text not null check (source ~ '^[a-z_]{1,30}$'),
  source_ref text check (source_ref ~ '^[A-Za-z0-9:_.-]{1,120}$'),
  labels jsonb not null default '{}'::jsonb check (jsonb_typeof(labels) = 'object'),
  label_version int not null default 1 check (label_version between 1 and 1000),
  labeled_by text not null check (labeled_by in ('code', 'worker', 'haiku', 'shal')),
  confidence numeric(3,2) check (confidence between 0 and 1),
  needs_review boolean not null default false,
  created_at timestamptz not null default now(),
  labeled_at timestamptz not null default now(),
  primary key (workspace_id, id),
  constraint events_dedupe unique (workspace_id, event_type, dedupe_key),
  constraint events_subject check (person_id is not null or account_id is not null)
);
create index if not exists events_person on app.events (workspace_id, person_id, occurred_at) where person_id is not null;
create index if not exists events_type_time on app.events (workspace_id, event_type, occurred_at);
create index if not exists events_review on app.events (workspace_id, occurred_at) where needs_review;

alter table app.events enable row level security;
drop policy if exists events_read on app.events;
create policy events_read on app.events for select to authenticated
  using ((select public.is_owner()) or (select app.is_member(workspace_id)));
revoke all on app.events from public, anon, authenticated, ari_worker;
grant select on app.events to authenticated;                                    -- RLS: owner or member, read only
grant usage on schema app to service_role;
grant select, insert, update, delete on app.events to service_role;

-- 2. vocabulary + checker ----------------------------------------------------------------------------------------------------
-- VOCAB-BEGIN (generated from scripts/ingest_labels.py vocab; edit there, then regenerate this block)
create or replace function app.event_label_vocab() returns jsonb language sql immutable set search_path = '' as $f$
  select $vocab${"accept":{"accept_via":"enum:tap|gmail|list","days_to_accept":"num","persona":"enum:C-suite/founder|Security/legal|SE/solutions|Sales/rev|Product|Engineering/data|Other","play":"play","tier":"enum:Target A|Target B|Target C"},"connect_sent":{"hour_local":"int","note_tag_id":"int","persona":"enum:C-suite/founder|Security/legal|SE/solutions|Sales/rev|Product|Engineering/data|Other","play":"play","tier":"enum:Target A|Target B|Target C","weekday":"enum:mon|tue|wed|thu|fri|sat|sun","with_note":"bool"},"dm_sent":{"asset":"bool","days_since_prev":"num","draft_tag_id":"int","edited":"bool","hook_kind":"enum:launch|funding|hire|breach_fine|partnership|mcp_agent|filing|post_talk|product_change|role_pain|peer_move|hypothesis|personal|none","late_days":"num","persona":"enum:C-suite/founder|Security/legal|SE/solutions|Sales/rev|Product|Engineering/data|Other","play":"play","profile_scanned":"bool","step":"enum:1|2|3","structure":"slug","switched":"bool","tier":"enum:Target A|Target B|Target C","words_changed":"int"},"meeting_booked":{"credited_step":"enum:0|1|2|3","credited_tag_id":"int","days_from_first_touch":"num","meeting_via":"enum:reply|ae|calendar","persona":"enum:C-suite/founder|Security/legal|SE/solutions|Sales/rev|Product|Engineering/data|Other","play":"play","tier":"enum:Target A|Target B|Target C","touches_before":"int"},"profile_scan_done":{"dm1_redrafted":"bool","outcome":"enum:scanned|unavailable","owns_problem":"bool","persona":"enum:C-suite/founder|Security/legal|SE/solutions|Sales/rev|Product|Engineering/data|Other","play":"play","recent_post":"bool","role_change":"bool","tier":"enum:Target A|Target B|Target C"},"reply":{"credited_tag_id":"int","days_since_touch":"num","intent":"enum:interested|meeting|question|referral|not_now|objection|not_interested|unsubscribe|unknown","next_step":"enum:book|answer|send_asset|follow_up_later|route_referral|stop","objection_type":"enum:has_vendor|build_in_house|no_need|timing|budget|security_review|wrong_person|other","persona":"enum:C-suite/founder|Security/legal|SE/solutions|Sales/rev|Product|Engineering/data|Other","play":"play","reply_to_step":"enum:0|1|2|3","sentiment":"enum:positive|neutral|negative","text_available":"bool","tier":"enum:Target A|Target B|Target C"},"signal_found":{"hook_kind":"enum:launch|funding|hire|breach_fine|partnership|mcp_agent|filing|post_talk|product_change|role_pain|peer_move|hypothesis|personal|none","persona":"enum:C-suite/founder|Security/legal|SE/solutions|Sales/rev|Product|Engineering/data|Other","play":"play","signal_age_days":"num","source_domain":"domain","tier":"enum:Target A|Target B|Target C","used_in_draft":"bool"},"withdraw":{"days_pending":"num","persona":"enum:C-suite/founder|Security/legal|SE/solutions|Sales/rev|Product|Engineering/data|Other","play":"play","reason":"enum:auto_stale|manual","tier":"enum:Target A|Target B|Target C"}}$vocab$::jsonb
$f$;
-- VOCAB-END

-- null = clean; otherwise the first fault. Types: bool, int, num, date, slug, domain, play, enum:<a|b|...>; null always allowed.
create or replace function app.event_labels_check(p_type text, p_labels jsonb) returns text
language plpgsql immutable set search_path = '' as $f$
declare voc jsonb := app.event_label_vocab() -> p_type; k text; v jsonb; t text; s text;
begin
  if voc is null then return 'unknown event_type'; end if;
  if p_labels is null or jsonb_typeof(p_labels) <> 'object' then return 'labels is not an object'; end if;
  for k, v in select * from jsonb_each(p_labels) loop
    t := voc ->> k;
    if t is null then return 'unknown key ' || left(k, 40); end if;
    continue when jsonb_typeof(v) = 'null';
    if t = 'bool' then
      if jsonb_typeof(v) <> 'boolean' then return k || ' not bool'; end if;
    elsif t = 'int' then
      if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric <> trunc((v #>> '{}')::numeric) then return k || ' not int'; end if;
    elsif t = 'num' then
      if jsonb_typeof(v) <> 'number' then return k || ' not a number'; end if;
    else
      if jsonb_typeof(v) <> 'string' then return k || ' not text'; end if;
      s := v #>> '{}';
      if length(s) > 40 then return k || ' over 40 chars'; end if;
      if s ~* '(https?:|www\.|linkedin|@|/)' or s ~ '[0-9]{7,}' then return k || ' looks like contact data or a link'; end if;
      if t like 'enum:%' and not (s = any(string_to_array(substr(t, 6), '|'))) then return k || ' not in vocabulary'; end if;
      if t = 'slug' and s !~ '^[a-z0-9 _-]+$' then return k || ' not a slug'; end if;
      if t = 'play' and s !~ '^(Play [A-Z]|other)$' then return k || ' not a play code'; end if;
      if t = 'date' and s !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then return k || ' not a date'; end if;
      if t = 'domain' and s !~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$' then return k || ' not a bare domain'; end if;
    end if;
  end loop;
  return null;
end $f$;
revoke all on function app.event_label_vocab(), app.event_labels_check(text, jsonb) from public, anon, authenticated;
grant execute on function app.event_label_vocab(), app.event_labels_check(text, jsonb) to service_role;

-- 3. the worker's write path ---------------------------------------------------------------------------------------------------
create or replace function public.ari_worker_event_record(
  p_event_type text, p_dedupe_key text, p_person_id text, p_account_id uuid, p_ae text, p_occurred_at timestamptz,
  p_approx boolean, p_source text, p_source_ref text, p_labels jsonb, p_labeled_by text default 'code',
  p_confidence numeric default null, p_needs_review boolean default false, p_label_version int default 1)
returns jsonb language plpgsql security definer set search_path = '' as $f$
declare
  ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
  judged constant text[] := array['intent', 'objection_type', 'sentiment', 'next_step'];
  err text; e app.events; keep jsonb; lab jsonb; conf numeric; rev boolean; by_ text; id_ bigint;
begin
  if p_labeled_by is null or p_labeled_by not in ('code', 'worker', 'haiku') then
    raise exception 'labeled_by must be code, worker or haiku' using errcode = '22023'; end if;
  err := app.event_labels_check(p_event_type, coalesce(p_labels, '{}'::jsonb));
  if err is not null then raise exception 'labels refused: %', err using errcode = '22023'; end if;
  if p_labeled_by = 'code' and exists (select 1 from jsonb_each(p_labels) j where j.key = any(judged) and jsonb_typeof(j.value) <> 'null') then
    raise exception 'labels refused: code cannot set judged reply labels' using errcode = '22023'; end if;
  if p_occurred_at is null or (p_person_id is null and p_account_id is null) then
    raise exception 'event needs a time and a person or an account' using errcode = '22023'; end if;
  conf := case when p_labeled_by = 'code' then 1 else p_confidence end;
  rev := coalesce(p_needs_review, false)
         or (p_event_type = 'reply' and (coalesce(conf, 0) < 0.7 or coalesce(p_labels ->> 'intent', 'unknown') = 'unknown'
                                         or (p_labels -> 'text_available') = 'false'::jsonb));

  select * into e from app.events where workspace_id = ws and event_type = p_event_type and dedupe_key = p_dedupe_key for update;
  if not found then
    insert into app.events (workspace_id, event_type, dedupe_key, person_id, account_id, ae, occurred_at, approx, source, source_ref,
                            labels, label_version, labeled_by, confidence, needs_review)
    values (ws, p_event_type, p_dedupe_key, p_person_id, p_account_id, left(p_ae, 40), p_occurred_at, coalesce(p_approx, false),
            p_source, p_source_ref, coalesce(p_labels, '{}'::jsonb), coalesce(p_label_version, 1), p_labeled_by, conf, rev)
    on conflict on constraint events_dedupe do nothing
    returning id into id_;
    if id_ is not null then return jsonb_build_object('result', 'inserted', 'id', id_); end if;
    select * into e from app.events where workspace_id = ws and event_type = p_event_type and dedupe_key = p_dedupe_key for update;
  end if;

  -- judged labels kept from the stored row: all of them when Owner set them, else the ones the new labels leave empty
  select coalesce(jsonb_object_agg(j.key, j.value), '{}'::jsonb) into keep from jsonb_each(e.labels) j
   where j.key = any(judged) and jsonb_typeof(j.value) <> 'null'
     and (e.labeled_by = 'shal' or coalesce(jsonb_typeof(p_labels -> j.key), 'null') = 'null');
  lab := coalesce(p_labels, '{}'::jsonb) || keep;
  by_ := case when e.labeled_by = 'shal' then 'shal'
              when p_labeled_by = 'code' and e.labeled_by in ('worker', 'haiku') and keep <> '{}'::jsonb then e.labeled_by
              else p_labeled_by end;
  if by_ <> p_labeled_by then conf := e.confidence; rev := e.needs_review; end if;
  update app.events set
    labels = lab, label_version = greatest(e.label_version, coalesce(p_label_version, 1)), labeled_by = by_, confidence = conf,
    needs_review = rev,
    occurred_at = case when e.approx and not coalesce(p_approx, false) then p_occurred_at
                       when e.approx = coalesce(p_approx, false) then least(e.occurred_at, p_occurred_at) else e.occurred_at end,
    approx = e.approx and coalesce(p_approx, false),
    person_id = coalesce(e.person_id, p_person_id), account_id = coalesce(e.account_id, p_account_id), ae = coalesce(e.ae, left(p_ae, 40)),
    labeled_at = case when e.labels is distinct from lab or e.labeled_by is distinct from by_ then now() else e.labeled_at end
  where workspace_id = ws and id = e.id;
  return jsonb_build_object('result', case when e.labels is distinct from lab or e.labeled_by is distinct from by_
                                             or e.confidence is distinct from conf or e.needs_review is distinct from rev
                                           then 'updated' else 'unchanged' end, 'id', e.id);
end $f$;
revoke all on function public.ari_worker_event_record(text, text, text, uuid, text, timestamptz, boolean, text, text, jsonb, text, numeric, boolean, int)
  from public, anon, authenticated;
grant execute on function public.ari_worker_event_record(text, text, text, uuid, text, timestamptz, boolean, text, text, jsonb, text, numeric, boolean, int) to ari_worker, service_role;
commit;

-- Ledger, after the end state is checked.
begin;
set local lock_timeout = '5s';
do $$ begin
  if to_regclass('app.events') is null or not (select relrowsecurity from pg_class where oid = 'app.events'::regclass) then
    raise exception '0044: app.events missing or RLS off'; end if;
  if has_table_privilege('anon', 'app.events', 'select') or has_table_privilege('authenticated', 'app.events', 'insert')
     or has_table_privilege('ari_worker', 'app.events', 'select') or has_table_privilege('ari_worker', 'app.events', 'insert') then
    raise exception '0044: app.events open to anon / authenticated writes / ari_worker'; end if;
  if not has_function_privilege('ari_worker', 'public.ari_worker_event_record(text, text, text, uuid, text, timestamptz, boolean, text, text, jsonb, text, numeric, boolean, int)', 'execute')
     or has_function_privilege('authenticated', 'public.ari_worker_event_record(text, text, text, uuid, text, timestamptz, boolean, text, text, jsonb, text, numeric, boolean, int)', 'execute') then
    raise exception '0044: event RPC grants wrong'; end if;
  if app.event_labels_check('dm_sent', '{"structure": "x@example.com"}'::jsonb) is null then raise exception '0044: checker lets an email through'; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0044', 'event_labels') on conflict do nothing;
commit;
