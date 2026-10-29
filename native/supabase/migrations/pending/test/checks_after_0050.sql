-- Checks for 0050 Kyte decline line. ONE statement, synthetic rows only (one queue row id 'QZ0050CHK', action 'App change'),
-- and it ENDS IN A DELIBERATE RAISE so the whole transaction rolls back (nothing kept).
-- Through the Management API the reply "ALL 0050 CHECKS PASSED (deliberate raise ...)" (HTTP 400) is a pass; "FAIL n: ..." is a fail.
\set ON_ERROR_STOP 1
do $$
declare src text; r record; k text;
begin
  -- 1. function, ledger, grants, trigger
  if to_regprocedure('public.queue_block_app_change()') is null then raise exception 'FAIL 1: queue_block_app_change is missing'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0050') then raise exception 'FAIL 1: no ledger row 0050'; end if;
  k := 'public.queue_block_app_change()';
  if has_function_privilege('anon', k, 'execute') or has_function_privilege('authenticated', k, 'execute') then
    raise exception 'FAIL 1: anon or authenticated can run %', k; end if;
  if not exists (select 1 from pg_proc where oid = k::regprocedure and prosecdef) then raise exception 'FAIL 1: not security definer'; end if;
  if not exists (select 1 from pg_trigger where tgrelid = 'public.queue'::regclass and tgname = 'queue_block_app_change' and not tgisinternal and tgenabled <> 'D') then
    raise exception 'FAIL 1: trigger queue_block_app_change missing or disabled'; end if;
  raise notice 'ok 1 function, ledger, grants, trigger';

  -- 2. the body names no system and carries exactly the new line
  select prosrc into src from pg_proc where oid = k::regprocedure;
  if src ~* '\m(hark|ari|den|kelvarrow)\M' then raise exception 'FAIL 2: the function still names a system: %', substring(src from '(?i)\m(hark|ari|den|kelvarrow)\M'); end if;
  if position('new.result := ''I can''''t help with that here.'';' in src) = 0 then raise exception 'FAIL 2: new decline line not found'; end if;
  raise notice 'ok 2 body';

  -- 3. behaviour: an app-change row is closed with the new line; an outreach row is untouched
  insert into public.queue(id, action, target, details, status) values ('QZ0050CHK', 'App change', '', 'zq synthetic', 'queued') returning status, result into r;
  if r.status <> 'done' or r.result is distinct from 'I can''t help with that here.' then raise exception 'FAIL 3: app change row got % / %', r.status, r.result; end if;
  insert into public.queue(id, action, target, details, status) values ('QZ0050CH2', 'Chat', '', 'zq synthetic', 'queued') returning status, result into r;
  if r.status <> 'queued' or r.result is not null then raise exception 'FAIL 3: chat row was changed: % / %', r.status, r.result; end if;
  update public.queue set status = 'queued', action = 'feature request' where id = 'QZ0050CH2' returning status, result into r;
  if r.status <> 'done' or r.result is distinct from 'I can''t help with that here.' then raise exception 'FAIL 3: update path got % / %', r.status, r.result; end if;
  raise notice 'ok 3 behaviour';

  raise exception 'ALL 0050 CHECKS PASSED (deliberate raise: synthetic rows rolled back)';
end $$;
