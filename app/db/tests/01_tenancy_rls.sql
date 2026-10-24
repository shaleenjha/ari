-- Tenancy + RLS matrix. Every assertion raises on failure (ON_ERROR_STOP).
-- 1. catalog: every app table has workspace_id NOT NULL (except workspaces), RLS enabled+forced, no write grant to authenticated
do $$ declare r record; begin
  for r in select c.relname, c.relrowsecurity, c.relforcerowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'app' and c.relkind = 'r' loop
    assert r.relrowsecurity and r.relforcerowsecurity, 'RLS not forced on ' || r.relname;
    if r.relname <> 'workspaces' then
      assert exists (select 1 from information_schema.columns where table_schema = 'app' and table_name = r.relname
                     and column_name = 'workspace_id' and is_nullable = 'NO'), 'workspace_id missing/nullable on ' || r.relname;
    end if;
    assert not has_table_privilege('authenticated', 'app.' || r.relname, 'INSERT,UPDATE,DELETE'), 'authenticated can write ' || r.relname;
    assert not has_table_privilege('anon', 'app.' || r.relname, 'SELECT'), 'anon can read ' || r.relname;
  end loop;
end $$;
select 'ok catalog';

-- 2. cross-tenant FK impossible (as owner)
do $$ begin
  begin
    insert into app.people(workspace_id, account_id, full_name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'Cross Tenant');
    raise exception 'cross-tenant FK allowed';
  exception when foreign_key_violation then null; end;
end $$;
select 'ok composite fk';

-- 3. sdr A sees A, never B, in every table (canary)
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000005d', false);
do $$ declare r record; n int; begin
  for r in select c.relname from pg_class c join pg_namespace n2 on n2.oid = c.relnamespace where n2.nspname = 'app' and c.relkind = 'r' loop
    execute format('select count(*) from app.%I where %s = %L', r.relname,
                   case when r.relname = 'workspaces' then 'id' else 'workspace_id' end, 'bbbbbbbb-0000-0000-0000-000000000001') into n;
    assert n = 0, 'A member sees B rows in ' || r.relname;
  end loop;
  assert (select count(*) from app.accounts) = 2, 'A sees its 2 accounts';
  assert (select count(*) from app.memberships) = 5, 'A sees its 5 members';
  assert not exists (select 1 from app.people where full_name like 'CANARY%'), 'canary person leaked';
end $$;
select 'ok isolation A';

-- 4. direct writes denied
do $$ begin
  begin insert into app.tasks(workspace_id, kind, title, assignee_role, created_by, created_by_kind)
        values ('aaaaaaaa-0000-0000-0000-000000000001', 'custom', 'x', 'sdr', 'a0000000-0000-0000-0000-00000000005d', 'sdr');
        raise exception 'direct insert allowed';
  exception when insufficient_privilege then null; end;
  begin update app.accounts set name = 'x'; raise exception 'direct update allowed';
  exception when insufficient_privilege then null; end;
end $$;
select 'ok direct writes denied';

-- 5. commands into another workspace denied
do $$ begin
  begin perform app.task_create('bbbbbbbb-0000-0000-0000-000000000001', 'custom', 'sneak', 'sdr');
        raise exception 'cross-workspace command allowed';
  exception when insufficient_privilege then null; end;
end $$;
select 'ok cross-workspace command denied';

-- 6. stranger sees nothing; anon sees nothing
select set_config('request.jwt.claim.sub', 'c0000000-0000-0000-0000-000000000000', false);
do $$ begin
  assert (select count(*) from app.workspaces) = 0 and (select count(*) from app.tasks) = 0 and (select count(*) from app.people) = 0, 'stranger sees rows';
end $$;
reset role;
set role anon;
do $$ begin
  begin perform count(*) from app.people; raise exception 'anon read allowed'; exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'ok stranger + anon';

-- 7. revoked membership loses access immediately (no JWT wait)
update app.memberships set status = 'revoked' where user_id = 'a0000000-0000-0000-0000-000000000a2e';
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-000000000a2e', false);
do $$ begin assert (select count(*) from app.accounts) = 0, 'revoked member still reads'; end $$;
reset role;
update app.memberships set status = 'active' where user_id = 'a0000000-0000-0000-0000-000000000a2e';
select 'ok revoke immediate';

-- 8. personal rows (notifications) only to their user
insert into app.notifications(workspace_id, user_id, kind, title) values ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000ae', 'test', 'for AE only');
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000005d', false);
do $$ begin assert (select count(*) from app.notifications) = 0, 'SDR reads AE notifications'; end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000ae', false);
do $$ begin assert (select count(*) from app.notifications) = 1, 'AE cannot read own notification'; end $$;
reset role;
select 'ok personal rows';
select 'PASS 01_tenancy_rls';
