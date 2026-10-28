# 03 · app database migration (E1 to E3)

Pending, not applied. Source: `native/supabase/migrations/pending/` (sha256 in section 9). Renumbered Oct 17 2026 (Otto's `0032_accept_ingest.sql` lands first): E1 is **0033**, E2 **0034**, E3 **0035**. Rewritten lock-safe the same day per the approved section 5 (Owner's decisions, 23:21 IST). All six files are generated (`test/gen_e12.py` for 0033/0034, `test/gen_e3.py` for 0035), so the SQL below is an excerpt: the header comments are dropped, every phase shows its first per-table transaction and a count of the rest, and two literals are redacted: `<owner-uid>` and `<owner-name>`. The workspace id is a synthetic constant.

## 1. Rules

1. Zero DROP of tables or columns in the forward files. Nothing renamed.
2. Nullable additions only: one column, `workspace_id uuid` with a constant default, on 42 tenant tables (`backup_runs` excluded; 0032's `gmail_events` and `scan_runs` not included, open decision in section 6). E2 tightens only that new column. No existing column changes.
3. The live app (reads as the owner, `authenticated` over PostgREST) and the worker (`ari_worker`) work unchanged. The owner still passes `is_owner()`; the 11 `ari_worker` policies and the 2 owner-only policies from 0032 are untouched; `ari_worker` gets nothing on `app`. Visible differences: `select=*` has one extra key, `ari_worker_columns()` lists it, and changing `workspace_id` is refused (42501).
4. Many short transactions per file: a precheck, then one transaction per table per phase, each with `lock_timeout = 5s` and `statement_timeout = 60s`, then the ledger row only once every table is in the end state. Re-runnable and resumable. One file = one Management API request (explicit `begin ... commit` blocks in one simple-protocol query are separate transactions; section 5). Staging, a day of syncs, then prod in a window.
5. Rollback runs in reverse apply order; each rollback mirrors the per-table structure, refuses to run out of order, and is re-runnable.

## 2. E1 · 0033_app2_e1_tenancy.sql

```sql
-- ---------- precheck ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare mx text;
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0026') then
    raise exception '0033 precheck: 0026 (health_alerts) is not applied';
  end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0032') then
    raise exception '0033 precheck: 0032 (accept_ingest) is not applied; it must land before app E1';
  end if;
  select max(version) into mx from supabase_migrations.schema_migrations;
  if mx > '0035' then raise exception '0033 precheck: max(version) is %, expected 0032 (or 0033..0035 on a re-run)', mx; end if;
end $$;
commit;
-- ---------- app schema, types, tables, seed (no lock on any public table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated;   -- E3 policies call app.is_member(); nothing in app is granted to anon or ari_worker

do $$ begin
  create type app.role_t as enum ('admin','manager','ae','sdr','agent');
exception when duplicate_object then null; end $$;
do $$ begin
  create type app.member_status as enum ('active','invited','revoked');
exception when duplicate_object then null; end $$;

create table if not exists app.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  timezone text not null default 'Asia/Kolkata',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create table if not exists app.memberships (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  user_id uuid not null,
  role app.role_t not null,
  status app.member_status not null default 'active',
  display_name text,
  timezone text,
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index if not exists memberships_user_ws_idx on app.memberships (user_id, workspace_id);
alter table app.workspaces enable row level security;
alter table app.workspaces force row level security;
alter table app.memberships enable row level security;
alter table app.memberships force row level security;
revoke all on app.workspaces, app.memberships from public, anon, authenticated;
grant select on app.workspaces, app.memberships to authenticated;   -- rows visible only once E3 adds the member policies

insert into app.workspaces (id, name) values ('f5a1e000-0000-4000-8000-000000000001', '<owner-name>') on conflict (id) do nothing;
insert into app.memberships (workspace_id, user_id, role, display_name)
values ('f5a1e000-0000-4000-8000-000000000001', '<owner-uid>', 'sdr', '<owner-name>')
on conflict (workspace_id, user_id) do nothing;
commit;
-- ---------- add workspace_id (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.account_briefs add column if not exists workspace_id uuid default 'f5a1e000-0000-4000-8000-000000000001'::uuid;
comment on column public.account_briefs.workspace_id is 'app tenancy (0033 E1). Every row belongs to workspace <owner-name> until app adds members.';
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- ledger (only when every table has the column) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare n int;
begin
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and column_name = 'workspace_id' and table_name = any(array['account_briefs', 'account_stage_history', 'accounts', 'app_changes', 'app_config', 'app_usage', 'ari_notes', 'ari_prefs', 'attachments', 'book', 'brief', 'copy_guidance', 'decisions', 'draft_edits', 'draft_tags', 'emails', 'events', 'gmail_connect_tickets', 'gmail_connection', 'gmail_ingest_runs', 'gmail_oauth_states', 'gmail_shadow_diffs', 'gmail_shadow_events', 'hygiene_findings', 'log_entries', 'messages', 'notifications', 'ops', 'people', 'plays', 'push_subscriptions', 'push_tokens', 'queue', 'replies', 'research', 'scan_heartbeat', 'sent_messages', 'sync_state', 'targets', 'task_events', 'tasks', 'threads']);
  if n <> 42 then raise exception '0033: % of 42 tables have workspace_id; re-run this file', n; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0033', 'app2_e1_tenancy') on conflict do nothing;
commit;
```

DOWN · 0033_app2_e1_tenancy_rollback.sql (run only after 0035 and 0034 are rolled back; its precheck enforces it):

```sql
-- ---------- precheck: E2 must be rolled back first ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version in ('0034', '0035')) then
    raise exception '0033 rollback precheck: 0034/0035 still in the ledger; roll them back first';
  end if;
  if exists (select 1 from pg_trigger where tgname = 'ws_guard' and not tgisinternal) then
    raise exception '0033 rollback precheck: ws_guard triggers still exist; run 0034_app2_e2_backfill_rollback.sql first';
  end if;
end $$;
commit;
-- ---------- drop workspace_id (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.account_briefs drop column if exists workspace_id;
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- app schema ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop table if exists app.memberships;
drop table if exists app.workspaces;
drop type if exists app.member_status;
drop type if exists app.role_t;
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'app') then
    revoke usage on schema app from authenticated;
  end if;
end $$;
drop schema if exists app;   -- no cascade: fails loudly if anything else was put in app
delete from supabase_migrations.schema_migrations where version = '0033';
commit;
```

## 3. E2 · 0034_app2_e2_backfill.sql

Phase-major: every table finishes a phase before the next starts. A guard, B batched backfill (1,000 rows per transaction, 2 per table per run, then one read-only check), C constraints NOT VALID, D VALIDATE, E SET NOT NULL using the validated check, F unique index.

```sql
-- ---------- precheck ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare n int;
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0033') then
    raise exception '0034 precheck: 0033 (app E1) is not applied';
  end if;
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and column_name = 'workspace_id' and table_name = any(array['account_briefs', 'account_stage_history', 'accounts', 'app_changes', 'app_config', 'app_usage', 'ari_notes', 'ari_prefs', 'attachments', 'book', 'brief', 'copy_guidance', 'decisions', 'draft_edits', 'draft_tags', 'emails', 'events', 'gmail_connect_tickets', 'gmail_connection', 'gmail_ingest_runs', 'gmail_oauth_states', 'gmail_shadow_diffs', 'gmail_shadow_events', 'hygiene_findings', 'log_entries', 'messages', 'notifications', 'ops', 'people', 'plays', 'push_subscriptions', 'push_tokens', 'queue', 'replies', 'research', 'scan_heartbeat', 'sent_messages', 'sync_state', 'targets', 'task_events', 'tasks', 'threads']);
  if n <> 42 then raise exception '0034 precheck: % of 42 tables have workspace_id', n; end if;
  if not exists (select 1 from app.workspaces where id = 'f5a1e000-0000-4000-8000-000000000001') then raise exception '0034 precheck: workspace <owner-name> missing'; end if;
end $$;
commit;
-- ---------- guard function (no lock on any public table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create or replace function app.ws_guard() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.workspace_id := coalesce(new.workspace_id, 'f5a1e000-0000-4000-8000-000000000001'::uuid);
    return new;
  end if;
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace_id cannot change (% row)', tg_table_name using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function app.ws_guard() from public, anon, authenticated;
commit;
-- ---------- A guard trigger (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'ws_guard' and tgrelid = 'public.account_briefs'::regclass) then
    create trigger ws_guard before insert or update of workspace_id on public.account_briefs for each row execute function app.ws_guard();
  end if;
end $$;
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- B backfill batch 1 of 2 (at most 1000 rows each) (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
lock table public.account_briefs in row exclusive mode;
do $$
declare n int;
begin
  if exists (select 1 from public.account_briefs where workspace_id is null) then
    perform set_config('session_replication_role', 'replica', true);
    update public.account_briefs set workspace_id = 'f5a1e000-0000-4000-8000-000000000001'::uuid
     where ctid = any (array(select ctid from public.account_briefs where workspace_id is null limit 1000));
    get diagnostics n = row_count;
    perform set_config('session_replication_role', 'origin', true);
    raise notice '0034: backfilled % row(s) in account_briefs', n;
  end if;
end $$;
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- B backfill batch 2 of 2 (at most 1000 rows each) (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
lock table public.account_briefs in row exclusive mode;
do $$
declare n int;
begin
  if exists (select 1 from public.account_briefs where workspace_id is null) then
    perform set_config('session_replication_role', 'replica', true);
    update public.account_briefs set workspace_id = 'f5a1e000-0000-4000-8000-000000000001'::uuid
     where ctid = any (array(select ctid from public.account_briefs where workspace_id is null limit 1000));
    get diagnostics n = row_count;
    perform set_config('session_replication_role', 'origin', true);
    raise notice '0034: backfilled % row(s) in account_briefs', n;
  end if;
end $$;
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- B check: stop (keeping the batches above) if any null is left; re-running the file continues the backfill ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare t text; has_null boolean; left_ text := '';
begin
  foreach t in array array['account_briefs', 'account_stage_history', 'accounts', 'app_changes', 'app_config', 'app_usage', 'ari_notes', 'ari_prefs', 'attachments', 'book', 'brief', 'copy_guidance', 'decisions', 'draft_edits', 'draft_tags', 'emails', 'events', 'gmail_connect_tickets', 'gmail_connection', 'gmail_ingest_runs', 'gmail_oauth_states', 'gmail_shadow_diffs', 'gmail_shadow_events', 'hygiene_findings', 'log_entries', 'messages', 'notifications', 'ops', 'people', 'plays', 'push_subscriptions', 'push_tokens', 'queue', 'replies', 'research', 'scan_heartbeat', 'sent_messages', 'sync_state', 'targets', 'task_events', 'tasks', 'threads'] loop
    execute format('select exists (select 1 from public.%I where workspace_id is null)', t) into has_null;
    if has_null then left_ := left_ || ' ' || t; end if;
  end loop;
  if left_ <> '' then raise exception '0034: null workspace_id still left in:%; re-run this file to continue the backfill', left_; end if;
end $$;
commit;
-- ---------- C constraints NOT VALID (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if not exists (select 1 from pg_attribute where attrelid = 'public.account_briefs'::regclass and attname = 'workspace_id' and attnotnull)
     and not exists (select 1 from pg_constraint where conrelid = 'public.account_briefs'::regclass and conname = 'account_briefs_ws_nn') then
    alter table public.account_briefs add constraint account_briefs_ws_nn check (workspace_id is not null) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.account_briefs'::regclass and conname = 'account_briefs_workspace_fk') then
    alter table public.account_briefs add constraint account_briefs_workspace_fk foreign key (workspace_id) references app.workspaces(id) not valid;
  end if;
end $$;
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- D validate (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if exists (select 1 from pg_constraint where conrelid = 'public.account_briefs'::regclass and conname = 'account_briefs_ws_nn' and not convalidated) then
    alter table public.account_briefs validate constraint account_briefs_ws_nn;
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.account_briefs'::regclass and conname = 'account_briefs_workspace_fk' and not convalidated) then
    alter table public.account_briefs validate constraint account_briefs_workspace_fk;
  end if;
end $$;
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- E set not null, drop helper check (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if not exists (select 1 from pg_attribute where attrelid = 'public.account_briefs'::regclass and attname = 'workspace_id' and attnotnull) then
    alter table public.account_briefs alter column workspace_id set not null;   -- proven by the validated account_briefs_ws_nn: no scan
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.account_briefs'::regclass and conname = 'account_briefs_ws_nn') then
    alter table public.account_briefs drop constraint account_briefs_ws_nn;
  end if;
end $$;
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- F unique (workspace_id, pk) index (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare pk text;
begin
  if to_regclass('public.account_briefs_ws_pk_uidx') is null then
    select string_agg(format('%I', a.attname), ', ' order by k.ord) into pk
      from pg_index i
      cross join lateral unnest(i.indkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
     where i.indrelid = 'public.account_briefs'::regclass and i.indisprimary;
    if pk is null then raise exception '0034: public.account_briefs has no primary key'; end if;
    execute format('create unique index if not exists account_briefs_ws_pk_uidx on public.account_briefs (workspace_id, %s)', pk);
  end if;
end $$;
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- ledger (only when every table is in the end state) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare t text; bad text := '';
begin
  foreach t in array array['account_briefs', 'account_stage_history', 'accounts', 'app_changes', 'app_config', 'app_usage', 'ari_notes', 'ari_prefs', 'attachments', 'book', 'brief', 'copy_guidance', 'decisions', 'draft_edits', 'draft_tags', 'emails', 'events', 'gmail_connect_tickets', 'gmail_connection', 'gmail_ingest_runs', 'gmail_oauth_states', 'gmail_shadow_diffs', 'gmail_shadow_events', 'hygiene_findings', 'log_entries', 'messages', 'notifications', 'ops', 'people', 'plays', 'push_subscriptions', 'push_tokens', 'queue', 'replies', 'research', 'scan_heartbeat', 'sent_messages', 'sync_state', 'targets', 'task_events', 'tasks', 'threads'] loop
    if not exists (select 1 from pg_attribute where attrelid = format('public.%I', t)::regclass and attname = 'workspace_id' and attnotnull)
       or to_regclass(format('public.%I', t || '_ws_pk_uidx')) is null
       or not exists (select 1 from pg_constraint where conrelid = format('public.%I', t)::regclass and conname = t || '_workspace_fk' and convalidated)
       or exists (select 1 from pg_constraint where conrelid = format('public.%I', t)::regclass and conname = t || '_ws_nn')
       or not exists (select 1 from pg_trigger where tgname = 'ws_guard' and tgrelid = format('public.%I', t)::regclass) then
      bad := bad || ' ' || t;
    end if;
  end loop;
  if bad <> '' then raise exception '0034: not finished on:%; re-run this file', bad; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0034', 'app2_e2_backfill') on conflict do nothing;
commit;
```

DOWN · 0034_app2_e2_backfill_rollback.sql (after 0035 is rolled back; leaves 0033 in place):

```sql
-- ---------- precheck: E3 must be rolled back first ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
begin
  if exists (select 1 from supabase_migrations.schema_migrations where version = '0035') then
    raise exception '0034 rollback precheck: 0035 still in the ledger; run 0035_app2_e3_dual_rls_rollback.sql first';
  end if;
end $$;
commit;
-- ---------- undo E2 (one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop trigger if exists ws_guard on public.account_briefs;
alter table public.account_briefs drop constraint if exists account_briefs_workspace_fk;
alter table public.account_briefs drop constraint if exists account_briefs_ws_nn;
drop index if exists public.account_briefs_ws_pk_uidx;
alter table public.account_briefs alter column workspace_id drop not null;
commit;
-- ... 41 more transactions of the same form, one per table ...
-- ---------- guard function + ledger ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop function if exists app.ws_guard();
delete from supabase_migrations.schema_migrations where version = '0034';
commit;
```

E2 cannot fail on current data: the E1 default fills every row (backfill expected 0), `(workspace_id, pk)` is unique because `pk` is, and every row points at the one workspace. If nulls do exist (explicit-null inserts between 0033 and phase A), phase A stops new ones, phase B fills old ones with `touch_row` and `ws_guard` skipped, and the request asks for a re-run until none are left. BEFORE INSERT triggers run before the NOT NULL check, so explicit-null inserts still succeed. `ws_guard` is SECURITY DEFINER and FK checks bypass RLS, so `ari_worker` needs no rights on `app`.

**ws_guard behaviour change** (also in the README): created only if missing (a re-run no longer drops and re-creates it, so it cannot change the trigger definition; the function body is still `create or replace`); it goes live first, table by table, before the backfill and NOT NULL; the backfill skips it via `session_replication_role = replica`, set only when that table has nulls.

## 4. E3 · 0035_app2_e3_dual_rls.sql

Generated by `test/gen_e3.py` from a post-0032 database (head from `test/e3_head.sql`):

```python
owner_all = [r for r in rows if r['roles'] == ['authenticated'] and 'is_owner()' in ((r['using'] or '') + (r['check'] or ''))]
owner = [r for r in owner_all if r['t'] in TABLES]          # the 42 tenant tables: made dual
owner_only = [r for r in owner_all if r['t'] not in TABLES]  # 0032's gmail_events, scan_runs: untouched
assert all(r['roles'] == ['ari_worker'] for r in rows if r not in owner_all)   # anything else stops generation
DUAL = lambda e: f"({e}) or (select app.is_member(workspace_id))" if e else e
# forward, one transaction per table:  drop policy if exists <n> on public.<t>; create policy <n> ... using (DUAL(using)) with check (DUAL(check));
# rollback, one transaction per table: drop policy if exists <n> on public.<t>; create policy <n> ... using (using) with check (check);  -- verbatim pg_get_expr
```

```sql
-- ---------- precheck: the target has exactly the policy shape this file was generated from (else stop; regenerate) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare n int;
begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0034') then
    raise exception '0035 precheck: 0034 (app E2) is not applied';
  end if;
  select count(*) into n from pg_policies where schemaname = 'public' and roles = '{authenticated}'
    and (coalesce(qual, '') || coalesce(with_check, '')) like '%is_owner()%';
  if n <> 39 then raise exception '0035 precheck: expected 39 owner policies on public, found %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and roles = '{authenticated}' and tablename = any(array['account_briefs', 'account_stage_history', 'accounts', 'app_changes', 'app_config', 'app_usage', 'ari_notes', 'ari_prefs', 'attachments', 'book', 'brief', 'copy_guidance', 'decisions', 'draft_edits', 'draft_tags', 'emails', 'events', 'gmail_connect_tickets', 'gmail_connection', 'gmail_ingest_runs', 'gmail_oauth_states', 'gmail_shadow_diffs', 'gmail_shadow_events', 'hygiene_findings', 'log_entries', 'messages', 'notifications', 'ops', 'people', 'plays', 'push_subscriptions', 'push_tokens', 'queue', 'replies', 'research', 'scan_heartbeat', 'sent_messages', 'sync_state', 'targets', 'task_events', 'tasks', 'threads'])
    and (coalesce(qual, '') || coalesce(with_check, '')) like '%is_owner()%';
  if n <> 37 then raise exception '0035 precheck: expected 37 owner policies on the 42 tenant tables, found %', n; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and roles <> '{authenticated}' and roles <> '{ari_worker}';
  if n <> 0 then raise exception '0035 precheck: % policies for roles other than authenticated/ari_worker', n; end if;
end $$;
commit;
-- ---------- helpers + app.* member policies (no lock on any public table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
create or replace function app.is_member(ws uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.memberships m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active')
$$;
create or replace function app.has_role(ws uuid, roles app.role_t[]) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from app.memberships m
                 where m.workspace_id = ws and m.user_id = auth.uid() and m.status = 'active' and m.role = any(roles))
$$;
revoke all on function app.is_member(uuid), app.has_role(uuid, app.role_t[]) from public, anon;
grant execute on function app.is_member(uuid), app.has_role(uuid, app.role_t[]) to authenticated;

drop policy if exists ws_read on app.workspaces;
create policy ws_read on app.workspaces for select to authenticated using ((select app.is_member(id)));
drop policy if exists own_or_ws_read on app.memberships;
create policy own_or_ws_read on app.memberships for select to authenticated using ((select app.is_member(workspace_id)));
commit;
-- ---------- owner policies, now dual (37 policies on 35 tables; one transaction per table) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop policy if exists owner_read on public.account_briefs;
create policy owner_read on public.account_briefs as permissive for select to authenticated
  using ((( SELECT public.is_owner() AS is_owner)) or (select app.is_member(workspace_id)));
commit;
-- ... 34 more transactions of the same form, one per table ...
-- ---------- ledger (only when every owner policy on a tenant table carries the member clause) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$
declare n int;
begin
  select count(*) into n from pg_policies where schemaname = 'public' and roles = '{authenticated}' and tablename = any(array['account_briefs', 'account_stage_history', 'accounts', 'app_changes', 'app_config', 'app_usage', 'ari_notes', 'ari_prefs', 'attachments', 'book', 'brief', 'copy_guidance', 'decisions', 'draft_edits', 'draft_tags', 'emails', 'events', 'gmail_connect_tickets', 'gmail_connection', 'gmail_ingest_runs', 'gmail_oauth_states', 'gmail_shadow_diffs', 'gmail_shadow_events', 'hygiene_findings', 'log_entries', 'messages', 'notifications', 'ops', 'people', 'plays', 'push_subscriptions', 'push_tokens', 'queue', 'replies', 'research', 'scan_heartbeat', 'sent_messages', 'sync_state', 'targets', 'task_events', 'tasks', 'threads'])
    and (coalesce(qual, '') || coalesce(with_check, '')) like '%is_owner()%'
    and ((qual is not null and qual not like '%app.is_member(%workspace_id)%')
      or (with_check is not null and with_check not like '%app.is_member(%workspace_id)%'));
  if n <> 0 then raise exception '0035: % owner policies still without the member clause; re-run this file', n; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0035', 'app2_e3_dual_rls') on conflict do nothing;
commit;
```

Affected policies (all `to authenticated`; name, command, permissiveness unchanged; policy text identical to the pre-renumber draft):

- `owner_all` (20): accounts, app_changes, ari_notes, attachments, book, brief, decisions, emails, messages, ops, people, plays, push_subscriptions, push_tokens, queue, research, targets, task_events, tasks, threads.
- `owner_read` (15): account_briefs, account_stage_history, app_config, app_usage, ari_prefs, copy_guidance, draft_edits, draft_tags, events, hygiene_findings, log_entries, notifications, replies, scan_heartbeat, sent_messages.
- `owner_insert` (2): events, log_entries.

37 policies on 35 tables, 35 transactions (events and log_entries swap both policies in one). The six `gmail_*` tables and `sync_state` have no owner policy, so they get no member path. `gmail_events` and `scan_runs` (0032) keep their owner-only `owner_read`.

DOWN · 0035_app2_e3_dual_rls_rollback.sql (generated, all 37 restored verbatim):

```sql
-- ---------- owner policies, restored (35 tables) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
drop policy if exists owner_read on public.account_briefs;
create policy owner_read on public.account_briefs as permissive for select to authenticated
  using (( SELECT public.is_owner() AS is_owner));
commit;
-- ... 34 more transactions of the same form, one per table ...
-- ---------- app.* policies, helpers, ledger ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regclass('app.workspaces') is not null then drop policy if exists ws_read on app.workspaces; end if;
  if to_regclass('app.memberships') is not null then drop policy if exists own_or_ws_read on app.memberships; end if;
  if to_regtype('app.role_t') is not null then drop function if exists app.has_role(uuid, app.role_t[]); end if;
end $$;
drop function if exists app.is_member(uuid);
delete from supabase_migrations.schema_migrations where version = '0035';
commit;
```

## 5. Zero-downtime proof

Lock levels measured with `pg_locks` inside each statement's transaction on a local prod-shape table (`test/lock_local.sh`), not only taken from the docs. Each transaction covers one table, so a lock is held on that table only, for that transaction.

| # | Statement | Lock on live `public` table | Blocks the app | Flag |
|---|---|---|---|---|
| E1.1 | `app` schema, types, tables, index, RLS, grants, seed | none on public | no | no |
| E1.2 | `add column if not exists workspace_id uuid default '<const>'::uuid` + `comment`, per table | ACCESS EXCLUSIVE, metadata only | ms, 5s cap | F1 done |
| E2.A | `create trigger ws_guard` only if missing, per table | SHARE ROW EXCLUSIVE | writes, ms | F7 done |
| E2.B | `lock table … in row exclusive mode` + update ≤1,000 null rows (replica role only if nulls) | ROW EXCLUSIVE, then ACCESS SHARE from its subselect | no | F2, F3 done |
| E2.B check | one read-only `exists(… is null)` over the 42 | ACCESS SHARE | no | – |
| E2.C | `add constraint <t>_ws_nn check (workspace_id is not null) not valid` | ACCESS EXCLUSIVE, catalog only | ms | F4 done |
| E2.C | `add constraint <t>_workspace_fk … not valid` | SHARE ROW EXCLUSIVE (also on `app.workspaces`) | writes, ms | no |
| E2.D | `validate constraint` (check, then FK) | SHARE UPDATE EXCLUSIVE + ACCESS SHARE scan | no | F6 done |
| E2.E | `alter column workspace_id set not null` (validated check present: no scan) + `drop constraint <t>_ws_nn` | ACCESS EXCLUSIVE | ms | F4 done |
| E2.F | `create unique index if not exists … (workspace_id, pk)` | SHARE (about 1,100 rows max) | writes, ms | F5 accepted |
| E3.1 | precheck, helpers, grants, `app.*` policies | none on public | no | no |
| E3.2 | `drop policy` + `create policy`, one transaction per table | ACCESS EXCLUSIVE | ms | F8 done |
| down | drop column / trigger / constraint / index / not null / policy swap, per table | ACCESS EXCLUSIVE, catalog only | ms | mirrors |

Flags from the original review and what the rewrite did:

- **F1** One transaction per table, `lock_timeout` 5s + `statement_timeout` 60s each. A stopped request keeps the finished tables; the re-run resumes (proved locally: a long read on `people` stopped 0033 after 5s with 28 of 42 tables done and no ledger row; the re-run finished).
- **F2** No count-then-ALTER: the backfill transaction takes ROW EXCLUSIVE first and never asks for a stronger lock; the NOT NULL work is in later transactions.
- **F3** Batched: 1,000 rows per transaction, 2 per table per run, then a check that stops the request if nulls remain (batches stay committed; re-run continues). `session_replication_role = replica` (no table lock) replaces `disable/enable trigger user` (SHARE ROW EXCLUSIVE). Proved locally: 2,500 null rows, run 1 filled 2,000 and stopped, run 2 finished, `updated_at` untouched.
- **F4** CHECK NOT VALID, VALIDATE, SET NOT NULL (PG 12+ skips the scan: DEBUG1 "existing constraints … are sufficient to prove that it does not contain nulls"), drop the CHECK.
- **F5** Not changed by decision (Owner): plain `CREATE UNIQUE INDEX` per table; tables are small, the build fits well inside the 5s lock timeout. No CONCURRENTLY, so no out-of-transaction step and no part file.
- **F6** VALIDATE runs in its own per-table transaction after every table has its NOT VALID constraints.
- **F7** No DROP TRIGGER; created only if missing. Behaviour change flagged in section 3 and the README.
- **F8** Per-table transactions; drop + create stay in the same transaction so no table is ever without its policy.

Management API: pg-meta sends the request body as one simple-protocol query; Postgres runs each explicit `begin … commit` in it as its own transaction and stops at the first error. The rehearsal sends each file the same way (`test/api_exec.py`, libpq `PQexec`), so each migration is one request and no part files are needed. Not yet verified on the hosted endpoint: the README gives a two-transaction probe for the first staging request. Under a continuous owner + `ari_worker` read/write loop the three files applied in about 70 to 280 ms each with 0 failed iterations (local, small data).

## 6. Staging preconditions

- `max(version)` in `supabase_migrations.schema_migrations` is `0032`; 0026 and 0032 present (0033's precheck enforces both). 0029 to 0031 create 9 of the 42 tables.
- Policy count: 39 owner (37 on the 42 tenant tables + `gmail_events`, `scan_runs` from 0032), 11 `ari_worker`, 0 other (else regenerate 0035 from a staging dump).
- All 42 tables have a primary key.
- Fresh verified backup; baseline row counts; one owner session on Today.
- Open decision for Owner: `gmail_events` and `scan_runs` (0032) are not tenant-scoped here. Including them means 44 tables and 39 dual policies (add to `TABLES` in `test/gen_e12.py`, regenerate, rehearse).

```sql
select count(*) from pg_policies where schemaname = 'public' and roles = '{authenticated}'
  and (coalesce(qual,'') || coalesce(with_check,'')) like '%is_owner()%';                        -- 39
select count(*) from pg_policies where schemaname = 'public' and roles = '{ari_worker}';          -- 11
```

## 7. Post-apply checks

```sql
-- after 0033
select count(*) from information_schema.columns where table_schema='public' and column_name='workspace_id';  -- 42
select count(*) from app.workspaces;                                                                        -- 1
select role from app.memberships;                                                                           -- sdr
-- after 0034 (the file itself refuses to write its ledger row unless all of these hold)
select count(*) from pg_indexes where indexname like '%\_ws\_pk\_uidx';                                     -- 42
select count(*) from pg_trigger where tgname = 'ws_guard';                                                  -- 42
select count(*) from pg_constraint where conname like '%\_workspace\_fk' and convalidated;                 -- 42
select count(*) from pg_constraint where conname like '%\_ws\_nn';                                          -- 0
```

After 0035: `test/checks_after_e3.sql` as `postgres` (synthetic, ends in ROLLBACK; its `set role ari_worker` block is unverified on Supabase). Owner loads Today, Replies, an Account room and Report, marks and undoes one item. Worker runs one sync, hygiene scan and health check clean. Advisors show nothing new for `app.*`.

Local proof (Postgres 17.11, Oct 17 2026, baseline + 0015 to 0032): 216 reads and 159 calls as owner, non-owner, `ari_worker` and anon, before, after each file, after re-applying all three and after the rollbacks: 0 differences beyond the new column; every rollback run twice cleanly; schema and policies after rollback identical to before; apply again after rollback, checks passed.

## 8. Rollback order

1. `0035_app2_e3_dual_rls_rollback.sql`
2. `0034_app2_e2_backfill_rollback.sql`
3. `0033_app2_e1_tenancy_rollback.sql`

Then rerun app and worker checks; `max(version)` is `0032`; no `app` schema. A restore with `session_replication_role = replica` after 0034 skips `ws_guard`, so fill `workspace_id` or roll back 0034 first.

## 9. File hashes (sha256)

```
a141e0dda54e7e2b37829788bac90dc111947fb14e3289f9a0e0e1f2e4f5913d  0033_app2_e1_tenancy.sql
9d197f8e614a60c1217187e315782c75210df069972e7300a89407a5273e5d3d  0033_app2_e1_tenancy_rollback.sql
9ba23a905f309008b24aae24c57fe473c6a526cf8cd0663cbc469f806aad5051  0034_app2_e2_backfill.sql
a8bd4ad86b3bd9cc882d2a40f4d7ac8fc79a99ef98d793d24f94d833d4d98bca  0034_app2_e2_backfill_rollback.sql
16ffa4a2b10bf52bf192ee9dfc5dca8ddee78093495366455922704447af24a3  0035_app2_e3_dual_rls.sql
21566cb4c392439bd2a2d961ed1a69e85f594bfb34fe34a6e563d3fe0fc81159  0035_app2_e3_dual_rls_rollback.sql
```
