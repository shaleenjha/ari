-- Checks for 0042 (security hardening). Staging-safe: ONE statement, synthetic rows only, and it ENDS IN A DELIBERATE RAISE so
-- the whole transaction rolls back (nothing kept: no test objects, no synthetic counts, no push row). Through the Management API
-- the reply is that error: "ALL 0042 CHECKS PASSED (deliberate raise ...)" means pass; any "FAIL n: ..." means fail.
-- The title/body are not compared verbatim: the notifications_privacy trigger (0031; 0040 changes its ops_alert branch) may
-- rewrite them to its own generic wording. The check only proves no table name reaches the lock screen.
-- In psql the same line prints as ERROR; grep for PASSED / FAIL. Do not run on prod without Owner's go (it is still harmless there).
\set ON_ERROR_STOP 1
do $$
declare
  d date := (now() at time zone 'Asia/Kolkata')::date;
  r jsonb; n int; c_people bigint; c_acc bigint; c_notif bigint; k text := 'ops:rowdrop:people:' || to_char((now() at time zone 'Asia/Kolkata')::date, 'YYYY-MM-DD');
  role_probe boolean := pg_has_role(current_user, 'anon', 'MEMBER');
begin
  -- 1. default lock: brand-new objects in public and app are closed to anon and authenticated
  create table public._chk0042_t (id serial primary key, v text);
  create function public._chk0042_f() returns int language sql as 'select 1';
  if has_table_privilege('anon', 'public._chk0042_t', 'select') or has_table_privilege('anon', 'public._chk0042_t', 'insert')
     or has_table_privilege('authenticated', 'public._chk0042_t', 'select')
     or has_sequence_privilege('anon', 'public._chk0042_t_id_seq', 'usage')
     or has_function_privilege('anon', 'public._chk0042_f()', 'execute')
     or has_function_privilege('authenticated', 'public._chk0042_f()', 'execute') then
    raise exception 'FAIL 1: a new object in public is open to anon/authenticated'; end if;
  if to_regnamespace('app') is not null then
    create table app._chk0042_t (id serial primary key);
    create function app._chk0042_f() returns int language sql as 'select 1';
    if has_table_privilege('anon', 'app._chk0042_t', 'select') or has_sequence_privilege('anon', 'app._chk0042_t_id_seq', 'usage')
       or has_function_privilege('anon', 'app._chk0042_f()', 'execute') or has_table_privilege('authenticated', 'app._chk0042_t', 'select') then
      raise exception 'FAIL 1: a new object in app is open to anon/authenticated'; end if;
  end if;
  if exists (select 1 from pg_default_acl a, aclexplode(a.defaclacl) x
             where a.defaclrole = 'postgres'::regrole and x.grantee in ('anon'::regrole, 'authenticated'::regrole)
               and (a.defaclnamespace = 0 or a.defaclnamespace in (select oid from pg_namespace where nspname in ('public', 'app')))) then
    raise exception 'FAIL 1: postgres default privileges in public/app (or global) still name anon/authenticated'; end if;
  raise notice 'ok 1 default lock (public%)', case when to_regnamespace('app') is null then '' else ' + app' end;

  -- 2. objects, grants, cron, ledger, seed
  if not (select relrowsecurity from pg_class where oid = 'public.ops_row_counts'::regclass) then raise exception 'FAIL 2: RLS off'; end if;
  if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'ops_row_counts') then raise exception 'FAIL 2: has a policy'; end if;
  if has_table_privilege('anon', 'public.ops_row_counts', 'select') or has_table_privilege('authenticated', 'public.ops_row_counts', 'select')
     or has_table_privilege('authenticated', 'public.ops_row_counts', 'insert') or has_table_privilege('anon', 'public.ops_row_counts', 'delete') then
    raise exception 'FAIL 2: table open to API roles'; end if;
  if exists (select 1 from pg_roles where rolname = 'ari_worker') and has_table_privilege('ari_worker', 'public.ops_row_counts', 'select') then
    raise exception 'FAIL 2: ari_worker reads ops_row_counts'; end if;
  if not (select prosecdef from pg_proc where oid = 'public.ari_rowcount_snapshot()'::regprocedure) then raise exception 'FAIL 2: not security definer'; end if;
  if has_function_privilege('anon', 'public.ari_rowcount_snapshot()', 'execute') or has_function_privilege('authenticated', 'public.ari_rowcount_snapshot()', 'execute')
     or (exists (select 1 from pg_roles where rolname = 'ari_worker') and has_function_privilege('ari_worker', 'public.ari_rowcount_snapshot()', 'execute')) then
    raise exception 'FAIL 2: function callable by an API role'; end if;
  select count(*) into n from cron.job where jobname = 'ari-rowcount-daily' and schedule = '30 2 * * *' and command like '%ari_rowcount_snapshot()%' and active;
  if n <> 1 then raise exception 'FAIL 2: cron job (%)', n; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0042') then raise exception 'FAIL 2: ledger'; end if;
  select count(*) into n from public.ops_row_counts where day = d;
  if n <> 4 then raise exception 'FAIL 2: today has % of 4 counts', n; end if;
  raise notice 'ok 2 objects, grants, cron, ledger, seed';

  -- 3. alert logic on synthetic history (rolled back): people "had" twice as many rows yesterday -> exactly one generic push
  select count(*) into c_people from public.people;
  select count(*) into c_acc from public.accounts;
  delete from public.notifications where dedupe_key like 'ops:rowdrop:%:' || to_char(d, 'YYYY-MM-DD');
  select count(*) into c_notif from public.notifications;
  delete from public.ops_row_counts where day < d;
  insert into public.ops_row_counts(day, tbl, n) values
    (d - 1, 'people', c_people * 2 + 10),   -- big drop -> alert
    (d - 1, 'accounts', c_acc),             -- no change -> no alert
    (d - 1, 'sent_messages', 0),            -- earlier count 0 -> never alerts
    (d - 1, 'notifications', c_notif);      -- grows by the one push -> no alert
  r := public.ari_rowcount_snapshot();
  if r->'dropped' <> '["people"]'::jsonb then raise exception 'FAIL 3: dropped = % (want ["people"])', r->'dropped'; end if;
  select count(*) into n from public.notifications where dedupe_key = k and kind = 'ops_alert' and url = '/ops'
    and person_id is null and account_id is null;
  if n <> 1 then raise exception 'FAIL 3: % ops_alert rows for %', n, k; end if;
  if exists (select 1 from public.notifications where dedupe_key = k and (body ilike '%people%' or body ilike '%accounts%' or title ilike '%people%')) then
    raise exception 'FAIL 3: lock-screen line names a table'; end if;
  r := public.ari_rowcount_snapshot();  -- same day again: the dedupe key keeps it to one push
  select count(*) into n from public.notifications where dedupe_key like 'ops:rowdrop:%';
  if n <> 1 then raise exception 'FAIL 3: dedupe failed (% rowdrop pushes)', n; end if;
  raise notice 'ok 3 alert: one generic ops_alert per table per day, no alert on flat/zero history';

  -- 4. as anon / authenticated over PostgREST roles: no read, no call
  if role_probe then
    begin set local role anon; perform 1 from public.ops_row_counts limit 1; reset role; raise exception 'FAIL 4: anon read ops_row_counts';
    exception when insufficient_privilege then reset role; end;
    begin set local role anon; perform public.ari_rowcount_snapshot(); reset role; raise exception 'FAIL 4: anon ran the snapshot';
    exception when insufficient_privilege then reset role; end;
    begin set local role authenticated; perform public.ari_rowcount_snapshot(); reset role; raise exception 'FAIL 4: authenticated ran the snapshot';
    exception when insufficient_privilege then reset role; end;
    raise notice 'ok 4 anon/authenticated refused (42501)';
  else
    raise notice 'skip 4: current user cannot SET ROLE anon; privilege functions in 2 cover it';
  end if;

  raise exception 'ALL 0042 CHECKS PASSED (deliberate raise: rolled back, nothing kept)';
end $$;
