-- Assertions for 0037 (members need the two-step code). CI: sql-prod-shape, after 0033..0035 + 0037 on the prod shape.
-- Also safe on STAGING after the apply: synthetic fixtures, one transaction, ends in ROLLBACK, nothing survives.
-- The release gate (Basalt H1): once a TOTP factor is enrolled, a Google-only (aal1) session reads ZERO rows of every tenant
-- table and app.*, and cannot write; aal2 reads everything; no factor (today) changes nothing.
-- S1 R7 (Oct 28 2026): after 0045, pair visibility is owner-based. A non-owner member reads only the rows it owns
-- (owner_uid / sdr_uid = member) in tables that carry an owner column, so member cases compare against member_own,
-- not total. Before 0045 (no owner columns, e.g. CI sql-prod-shape) member_own = total and the test is unchanged.
-- Exact match both ways: a member that sees any owner row (n > member_own) fails, as does one that sees too little.
\set ON_ERROR_STOP on
begin;

-- every RLS-protected table the member clause guards: the 42 tenant tables plus app.workspaces / app.memberships
create temp table t37 (rel text primary key, total bigint not null default 0);
insert into t37(rel)
  select format('%I.%I', c.table_schema, c.table_name) from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
   where c.table_schema = 'public' and c.column_name = 'workspace_id';
insert into t37(rel) values ('app.workspaces'), ('app.memberships');
-- tables a signed-in user cannot SELECT at all (service-role only: gmail_*, sync_state, ...) already read zero; list them
create temp table t37_closed as select rel from t37 where not has_table_privilege('authenticated', rel::regclass, 'select');
delete from t37 where rel in (select rel from t37_closed);

-- synthetic fixtures: a second member (not the owner) in Owner's workspace, one synthetic person
insert into app.memberships(workspace_id, user_id, role, display_name)
  values ('f5a1e000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-00000000a037', 'sdr', 'Check Member 0037');
insert into public.people(id, name, company, stage) values ('PA0037', 'Check Person 0037', 'Synthetic Check Co', 'Connect queued') on conflict do nothing;
do $$ declare r record; n bigint;
begin for r in select rel from t37 loop execute 'select count(*) from ' || r.rel into n; update t37 set total = n where rel = r.rel; end loop; end $$;
-- rows the synthetic member OWNS (0045): tables without owner_uid / sdr_uid (app.workspaces, app.memberships, or any
-- table before 0045) stay membership-scoped, so the member's expectation there is the full total
alter table t37 add column member_own bigint not null default 0;
do $$ declare r record; c text; n bigint;
begin for r in select rel from t37 loop
  select string_agg(format('%I = %L::uuid', column_name, '00000000-0000-4000-8000-00000000a037'), ' or ' order by column_name) into c
    from information_schema.columns
   where format('%I.%I', table_schema, table_name) = r.rel and column_name in ('owner_uid', 'sdr_uid');
  if c is null then n := (select t.total from t37 t where t.rel = r.rel);
  else execute 'select count(*) from ' || r.rel || ' where ' || c into n; end if;
  update t37 set member_own = n where rel = r.rel;
end loop; end $$;
do $$ begin
  if (select count(*) from t37 where rel like 'public.%') + (select count(*) from t37_closed where rel like 'public.%') <> 42 then
    raise exception 'FAIL 0037 setup: % tenant tables, expected 42', (select count(*) from t37 where rel like 'public.%') + (select count(*) from t37_closed where rel like 'public.%'); end if;
  -- with 0045 present the member must actually be denied owner rows somewhere (PA0037 is owner-filled), or the check is vacuous
  if exists (select 1 from information_schema.columns where table_schema = 'public' and column_name in ('owner_uid', 'sdr_uid'))
     and not exists (select 1 from t37 where member_own < total) then
    raise exception 'FAIL 0037 setup: owner columns exist but no table holds owner rows the member should not see'; end if;
  raise notice '0037 setup: % readable tables checked, % closed to signed-in users (%); % owner-scoped for the member (%)', (select count(*) from t37),
    (select count(*) from t37_closed), (select string_agg(rel, ', ' order by rel) from t37_closed),
    (select count(*) from t37 where member_own <> total), (select string_agg(rel, ', ' order by rel) from t37 where member_own <> total);
end $$;
grant select on t37 to authenticated;

-- what the CURRENT role and claims can see, per table
create function pg_temp.seen() returns table(rel text, n bigint, total bigint, member_own bigint) language plpgsql as $$
declare r record;
begin
  for r in select t.rel, t.total, t.member_own from t37 t order by 1 loop
    rel := r.rel; total := r.total; member_own := r.member_own; execute 'select count(*) from ' || r.rel into n; return next;
  end loop;
end $$;
grant execute on function pg_temp.seen() to authenticated;
-- a verified (or unverified) TOTP factor; adapts to the real auth.mfa_factors columns on staging
create function pg_temp.enrol(uid uuid, st text) returns void language plpgsql as $$
begin
  if not exists (select 1 from auth.users where id = uid) then insert into auth.users(id) values (uid); end if;
  if exists (select 1 from information_schema.columns where table_schema = 'auth' and table_name = 'mfa_factors' and column_name = 'factor_type') then
    execute 'insert into auth.mfa_factors(id, user_id, friendly_name, factor_type, status, created_at, updated_at)
             values (gen_random_uuid(), $1, ''check-0037-'' || $2, ''totp'', $2::auth.factor_status, now(), now())' using uid, st;
  else
    insert into auth.mfa_factors(id, user_id, status) values (gen_random_uuid(), uid, st);
  end if;
end $$;
create function pg_temp.claims(uid uuid, aal text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('role', 'authenticated', 'sub', uid, 'aal', aal)::text, true),
         set_config('request.jwt.claim.sub', uid::text, true)
$$;
grant execute on function pg_temp.claims(uuid, text) to authenticated;

-- 1. No factor yet (today), Google-only: the owner reads everything; the member reads exactly its own rows (0045).
set local role authenticated;
select pg_temp.claims('b14d1605-c766-4684-9a5b-71ffcab6967b', 'aal1');
do $$ begin if exists (select 1 from pg_temp.seen() where n <> total) then
  raise exception 'FAIL 0037 case 1 owner aal1, no factor: % reads less than everything', (select string_agg(rel, ', ') from pg_temp.seen() where n <> total); end if; end $$;
select pg_temp.claims('00000000-0000-4000-8000-00000000a037', 'aal1');
do $$ begin if exists (select 1 from pg_temp.seen() where n <> member_own) then
  raise exception 'FAIL 0037 case 1 member aal1, no factor: reads other than its own rows in: %', (select string_agg(rel || '=' || n || '/' || member_own, ', ') from pg_temp.seen() where n <> member_own); end if; end $$;
reset role;

-- 2. An unverified (half-done) enrolment locks nobody out.
select pg_temp.enrol('00000000-0000-4000-8000-00000000a037', 'unverified');
set local role authenticated;
select pg_temp.claims('00000000-0000-4000-8000-00000000a037', 'aal1');
do $$ begin if exists (select 1 from pg_temp.seen() where n <> member_own) then
  raise exception 'FAIL 0037 case 2 unverified factor changed what the member reads in: %', (select string_agg(rel || '=' || n || '/' || member_own, ', ') from pg_temp.seen() where n <> member_own); end if; end $$;
reset role;

-- 3. The member enrols: aal1 reads zero everywhere, aal2 reads exactly its own rows (0045).
select pg_temp.enrol('00000000-0000-4000-8000-00000000a037', 'verified');
set local role authenticated;
select pg_temp.claims('00000000-0000-4000-8000-00000000a037', 'aal1');
do $$ begin if exists (select 1 from pg_temp.seen() where n <> 0) then
  raise exception 'FAIL 0037 case 3 member aal1 with a factor still reads: %', (select string_agg(rel || '=' || n, ', ') from pg_temp.seen() where n <> 0); end if; end $$;
select pg_temp.claims('00000000-0000-4000-8000-00000000a037', 'aal2');
do $$ begin if exists (select 1 from pg_temp.seen() where n <> member_own) then
  raise exception 'FAIL 0037 case 3 member aal2 reads other than its own rows in: %', (select string_agg(rel || '=' || n || '/' || member_own, ', ') from pg_temp.seen() where n <> member_own); end if; end $$;
reset role;

-- 4. Owner enrols (the release gate): Google-only reads zero rows and cannot write; with the code, everything.
select pg_temp.enrol('b14d1605-c766-4684-9a5b-71ffcab6967b', 'verified');
set local role authenticated;
select pg_temp.claims('b14d1605-c766-4684-9a5b-71ffcab6967b', 'aal1');
do $$
declare k int;
begin
  if exists (select 1 from pg_temp.seen() s where s.n <> 0) then
    raise exception 'FAIL 0037 case 4 owner aal1 with a factor still reads: %', (select string_agg(s.rel || '=' || s.n, ', ') from pg_temp.seen() s where s.n <> 0);
  end if;
  update public.people set notes = notes where id = 'PA0037';
  get diagnostics k = row_count;
  if k <> 0 then raise exception 'FAIL 0037 case 4 owner aal1 updated % people rows', k; end if;
  begin
    insert into public.log_entries(ts, person_id, event, detail, source) values (now(), 'PA0037', 'Check 0037', null, 'app');
    raise exception 'FAIL 0037 case 4 owner aal1 inserted a Log row';
  exception when insufficient_privilege then null;   -- RLS refusal is 42501
  end;
  begin
    perform public.apply_op('check-0037-op', 'mark', 'people', 'PA0037', '{"field":"connect_sent"}'::jsonb);
    raise exception 'FAIL 0037 case 4 owner aal1 ran apply_op';
  exception when raise_exception then
    if sqlerrm like 'FAIL%' then raise; end if;          -- apply_op's own 'not allowed'
            when insufficient_privilege then null;
  end;
end $$;
select pg_temp.claims('b14d1605-c766-4684-9a5b-71ffcab6967b', 'aal2');
do $$ begin if exists (select 1 from pg_temp.seen() where n <> total) then
  raise exception 'FAIL 0037 case 4 owner aal2 reads less than everything: %', (select string_agg(rel, ', ') from pg_temp.seen() where n <> total); end if; end $$;
reset role;

-- 5. Nobody calls the helper directly; the ledger has the row.
do $$ begin
  if has_function_privilege('authenticated', 'app.aal_ok()', 'execute') or has_function_privilege('anon', 'app.aal_ok()', 'execute')
    then raise exception 'FAIL 0037 case 5 app.aal_ok() is callable directly'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0037')
    then raise exception 'FAIL 0037 case 5 ledger row missing'; end if;
  raise notice 'ALL 0037 TESTS PASSED (% readable tables checked, % closed)', (select count(*) from t37), (select count(*) from t37_closed);
end $$;
rollback;
-- Final row: the Management API returns only the last statement's result, so success = HTTP 201 + this row.
select 'ALL 0037 TESTS PASSED' as result;
