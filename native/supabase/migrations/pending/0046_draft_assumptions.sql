-- 0046 draft assumptions (Oct 28 2026; Owner chose option C 13:32 IST). STAGING FIRST. Spec plans/assumptions-to-confirm.md.
-- Adds queue.assumptions jsonb NOT NULL DEFAULT '[]': the facts in a draft with no written source, each
--   {id, text, kind: name|title|number|date|event|customer|claim, source: drafter|checker, status: open|confirmed|struck|edited}.
-- One queue row per draft holds the list: id 'AS:<person_id>:<kind>' (kind dm1|dm2|dm3|note|exec), action 'Draft assumptions',
-- target = person id, details = kind, status 'done'. Written by scripts/copy_check.py check --store (ari_worker) and by the
-- app through apply_op 'set' (Confirm / Strike / Edit). The app never shows these rows as tasks.
-- Visibility: queue stays PRIVATE exactly as 0045 left it (owner_all: owner_uid = caller AND (is_owner() OR is_member);
--   ari_worker_rw for the worker). No policy is created, changed or dropped here; the end-state block asserts it.
-- Grants (Supabase Data API rule, Oct 30 2026: nothing is exposed by default, every grant is explicit): column-level
--   SELECT/INSERT/UPDATE on assumptions to authenticated and ari_worker, nothing to anon or public.
-- Locks: add column with a constant default = metadata only; the check constraint is added NOT VALID then validated
--   (SHARE UPDATE EXCLUSIVE, writers keep going). lock_timeout 5s / statement_timeout 60s. Re-runnable; ledger row last.
-- Rollback: 0046_draft_assumptions_rollback.sql. Checks: test/checks_after_0046.sql.

-- ---------- precheck ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0045') then
    raise exception '0046 precheck: 0045 is not applied'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'queue' and column_name = 'owner_uid') then
    raise exception '0046 precheck: queue.owner_uid missing (0045 shape expected)'; end if;
  if not exists (select 1 from pg_roles where rolname = 'ari_worker') then
    raise exception '0046 precheck: role ari_worker missing'; end if;
end $$;
commit;

-- ---------- column ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.queue add column if not exists assumptions jsonb not null default '[]'::jsonb;
do $$ begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.queue'::regclass and conname = 'queue_assumptions_shape') then
    alter table public.queue add constraint queue_assumptions_shape
      check (jsonb_typeof(assumptions) = 'array' and jsonb_array_length(assumptions) <= 60) not valid;
  end if;
end $$;
comment on column public.queue.assumptions is
  'Draft facts with no written source: [{id,text,kind name|title|number|date|event|customer|claim,source drafter|checker,status open|confirmed|struck|edited}]. Rows AS:<pid>:<kind>. 0046.';
commit;

begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter table public.queue validate constraint queue_assumptions_shape;
commit;

-- ---------- explicit grants (column level) ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
revoke all (assumptions) on public.queue from public, anon;
grant select (assumptions), insert (assumptions), update (assumptions) on public.queue to authenticated, ari_worker;
commit;

-- ---------- ledger, after the end state is checked ----------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ declare n int; q text; begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'queue'
                 and column_name = 'assumptions' and data_type = 'jsonb' and is_nullable = 'NO') then
    raise exception '0046: queue.assumptions missing or wrong shape'; end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.queue'::regclass and conname = 'queue_assumptions_shape' and convalidated) then
    raise exception '0046: queue_assumptions_shape not validated'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.queue'::regclass) then
    raise exception '0046: RLS is off on queue'; end if;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'queue';
  if n <> 2 then raise exception '0046: queue has % policies, expected 2 (owner_all, ari_worker_rw)', n; end if;
  select coalesce(qual, '') || ' ' || coalesce(with_check, '') into q from pg_policies
   where schemaname = 'public' and tablename = 'queue' and policyname = 'owner_all' and roles = '{authenticated}';
  if q is null or q not like '%owner_uid = ( SELECT auth.uid()%' then
    raise exception '0046: queue owner_all lost its owner clause'; end if;
  if has_column_privilege('anon', 'public.queue', 'assumptions', 'select') or has_column_privilege('anon', 'public.queue', 'assumptions', 'update') then
    raise exception '0046: anon can reach queue.assumptions'; end if;
  if not (has_column_privilege('authenticated', 'public.queue', 'assumptions', 'select') and has_column_privilege('authenticated', 'public.queue', 'assumptions', 'update')
          and has_column_privilege('ari_worker', 'public.queue', 'assumptions', 'insert') and has_column_privilege('ari_worker', 'public.queue', 'assumptions', 'update')) then
    raise exception '0046: a required grant is missing'; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0046', 'draft_assumptions') on conflict do nothing;
commit;
