-- Checks for 0045 pair visibility. Staging/prod-safe: ONE statement, synthetic rows only (3 auth users chk0045-*@example.com,
-- their memberships, one account P/acct "CHK0045 Ixterlane", people P999999945/P999999946, a few private rows), and it ENDS IN A
-- DELIBERATE RAISE so the whole transaction rolls back (nothing kept; bigint sequences may skip a few numbers).
-- Through the Management API the reply "ALL 0045 CHECKS PASSED (deliberate raise ...)" (HTTP 400) is a pass; "FAIL n: ..." is a fail.
-- Callers are simulated the way PostgREST does it: SET LOCAL ROLE authenticated + request.jwt.claims (transaction-local).
--   Owner = the uid is_owner() is pinned to (aal2). A = SDR, B = AE (pairs with A), C = unrelated SDR. All in Owner's workspace.
\set ON_ERROR_STOP 1
do $$
declare
  shal constant uuid := 'b14d1605-c766-4684-9a5b-71ffcab6967b';
  ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  acc uuid; pid uuid; pid2 uuid; n bigint; m bigint; t text; ok boolean; rec record;
  shared_t constant text[] := array['accounts','people','account_briefs','account_stage_history','research'];
  all_t text[];
  shal_before jsonb := '{}'::jsonb;
  shal_after jsonb := '{}'::jsonb;
begin
  select array_agg(distinct tablename order by tablename) into all_t from pg_policies
   where schemaname = 'public' and roles = '{authenticated}' and (coalesce(qual,'') || coalesce(with_check,'')) like '%is_member%';
  if cardinality(all_t) <> 35 then raise exception 'FAIL 0: expected 35 workspace tables, found %', cardinality(all_t); end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0045') then raise exception 'FAIL 0: no ledger row 0045'; end if;

  -- 1. Owner (owner, aal2) sees exactly every existing row, as before (all rows are his today)
  perform set_config('request.jwt.claims', json_build_object('sub', shal, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  foreach t in array all_t loop
    reset role; execute format('select count(*) from public.%I', t) into m;
    set local role authenticated; execute format('select count(*) from public.%I', t) into n; reset role;
    if n <> m then raise exception 'FAIL 1: Owner sees % of % rows in %', n, m, t; end if;
    shal_before := shal_before || jsonb_build_object(t, n);
  end loop;
  raise notice 'ok 1 Owner sees all existing rows on 35 tables';

  -- 2. synthetic users + memberships (as postgres = the only way a role is set)
  insert into auth.users (id, aud, role, email) values
    (a, 'authenticated', 'authenticated', 'chk0045-a@example.com'),
    (b, 'authenticated', 'authenticated', 'chk0045-b@example.com'),
    (c, 'authenticated', 'authenticated', 'chk0045-c@example.com');
  insert into app.memberships (workspace_id, user_id, role, status, display_name) values
    (ws, a, 'sdr', 'active', 'chk A'), (ws, b, 'ae', 'active', 'chk B'), (ws, c, 'sdr', 'active', 'chk C');

  -- 3. A writes shared + private rows as A; B writes private rows as B
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  insert into public.accounts (company) values ('CHK0045 Ixterlane') returning id into acc;
  update public.accounts set ae_uid = b where id = acc;
  insert into public.people (id, account_id, company, name, title, dm, dm2_text, notes)
    values ('P999999945', acc, 'CHK0045 Ixterlane', 'chk Person', 'CISO', 'SECRET DM TEXT', 'SECRET DM2', 'SECRET NOTE');
  insert into public.research (account_id, source_url, summary) values (acc, 'https://chk0045.invalid/r', 'chk research');
  insert into public.ari_notes (body) values ('chk A private note');
  insert into public.queue (action, target) values ('chk A private', 'P999999945');
  insert into public.decisions (question) values ('chk A private decision');
  reset role;
  if (select sdr_uid from public.accounts where id = acc) <> a then raise exception 'FAIL 3: sdr_uid not filled with A'; end if;
  if (select owner_uid from public.people where id = 'P999999945') <> a then raise exception 'FAIL 3: people.owner_uid not A'; end if;
  -- worker-style rows (no signed-in user): owner comes from the account's SDR, private rows default to the owner
  perform set_config('request.jwt.claims', '', true);
  insert into public.account_briefs (account_id, company, status) values (acc, 'CHK0045 Ixterlane', 'ready');
  insert into public.account_stage_history (account_id, company, to_stage, source, kind) values (acc, 'CHK0045 Ixterlane', 'Working', 'chk', 'manual');
  if (select owner_uid from public.account_briefs where account_id = acc) <> a then raise exception 'FAIL 3: worker-path brief owner not A'; end if;
  insert into public.ari_notes (body) values ('chk worker note') returning owner_uid into pid;
  if pid <> shal then raise exception 'FAIL 3: worker-path private row owner is not Owner'; end if;
  delete from public.ari_notes where body = 'chk worker note';
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  insert into public.ari_notes (body) values ('chk B private note');
  insert into public.queue (action, target) values ('chk B private', 'x');
  reset role;
  raise notice 'ok 3 rows written; owner_uid/sdr_uid filled (signed-in user, account SDR, owner)';

  -- 4. before any pairing B sees none of A's shared rows (even with ae_uid = B on the account)
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  select count(*) into n from public.accounts where id = acc;
  select count(*) + n into n from public.research where account_id = acc;
  select count(*) + n into n from public.account_briefs where account_id = acc;
  select count(*) + n into n from public.account_stage_history where account_id = acc;
  select count(*) + n into n from app.shared_people();
  reset role;
  if n <> 0 then raise exception 'FAIL 4: B sees % of A''s shared rows before pairing', n; end if;

  -- 5. self-escalation refused: B cannot set its role, add a membership, insert/upgrade a pairing, or accept its own request
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  begin set local role authenticated; update app.memberships set role = 'sdr' where user_id = b;
    reset role; raise exception 'FAIL 5: B updated its membership';
  exception when insufficient_privilege then reset role; end;
  begin set local role authenticated; insert into app.memberships (workspace_id, user_id, role, status) values (ws, gen_random_uuid(), 'admin', 'active');
    reset role; raise exception 'FAIL 5: B inserted a membership';
  exception when insufficient_privilege then reset role; end;
  begin set local role authenticated; insert into app.pairings (workspace_id, sdr_uid, ae_uid, status) values (ws, a, b, 'active');
    reset role; raise exception 'FAIL 5: B inserted an active pairing';
  exception when insufficient_privilege then reset role; end;
  set local role authenticated; pid := app.pair_request(ws, a); reset role;
  if (select status from app.pairings where id = pid) <> 'requested' then raise exception 'FAIL 5: request not in requested state'; end if;
  begin set local role authenticated; update app.pairings set status = 'active' where id = pid;
    reset role; raise exception 'FAIL 5: B updated the pairing';
  exception when insufficient_privilege then reset role; end;
  begin set local role authenticated; perform app.pair_accept(pid);
    reset role; raise exception 'FAIL 5: B accepted its own request';
  exception when insufficient_privilege then reset role; end;
  begin set local role authenticated; perform app.pair_request(ws, c);  -- B asking C is fine; C is an SDR; then C must not accept A's
    reset role;
  exception when insufficient_privilege then reset role; raise exception 'FAIL 5: AE could not request a second SDR'; end;
  -- C (an SDR) cannot request a pairing (not an AE) and cannot accept the A<-B request
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  begin set local role authenticated; perform app.pair_request(ws, a);
    reset role; raise exception 'FAIL 5: SDR C requested a pairing';
  exception when insufficient_privilege then reset role; end;
  begin set local role authenticated; perform app.pair_accept(pid);
    reset role; raise exception 'FAIL 5: C accepted A''s request';
  exception when insufficient_privilege then reset role; end;
  if (select status from app.pairings where id = pid) <> 'requested' then raise exception 'FAIL 5: pairing changed without A'; end if;
  -- still nothing visible to B while only requested
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated; select count(*) into n from public.accounts where id = acc; reset role;
  if n <> 0 then raise exception 'FAIL 5: B sees A''s account on a requested pairing'; end if;
  raise notice 'ok 5 no self-escalation: memberships/pairings unwritable, own accept refused, C cannot request/accept, requested = invisible';

  -- 6. A accepts -> B sees A's shared rows (read only), never people DM text, never A's private rows, never Owner's rows
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated; perform app.pair_accept(pid); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  select count(*) into n from public.accounts where id = acc;            if n <> 1 then reset role; raise exception 'FAIL 6: B sees % accounts after accept', n; end if;
  select count(*) into n from public.research where account_id = acc;    if n <> 1 then reset role; raise exception 'FAIL 6: B sees % research', n; end if;
  select count(*) into n from public.account_briefs where account_id = acc; if n <> 1 then reset role; raise exception 'FAIL 6: B sees % briefs', n; end if;
  select count(*) into n from public.account_stage_history where account_id = acc; if n < 1 then reset role; raise exception 'FAIL 6: B sees no stage history'; end if;
  select count(*) into n from app.shared_people() where id = 'P999999945'; if n <> 1 then reset role; raise exception 'FAIL 6: shared_people gave % rows', n; end if;
  select count(*) into n from public.people where id = 'P999999945';     if n <> 0 then reset role; raise exception 'FAIL 6: B reads the people row (DM text) directly'; end if;
  select count(*) into n from public.ari_notes where body like 'chk A%';
  select count(*) + n into n from public.queue where action like 'chk A%';
  select count(*) + n into n from public.decisions where question like 'chk A%';
  select count(*) + n into n from public.notifications where owner_uid = a;
  select count(*) + n into n from public.events where owner_uid = a;
  select count(*) + n into n from public.log_entries where owner_uid = a;
  if n <> 0 then reset role; raise exception 'FAIL 6: B sees % of A''s private rows', n; end if;
  update public.accounts set hook = 'B was here' where id = acc; get diagnostics n = row_count;
  if n <> 0 then reset role; raise exception 'FAIL 6: B updated A''s account'; end if;
  ok := false;
  begin insert into public.accounts (company, sdr_uid) values ('CHK0045 forged', a);
  exception when insufficient_privilege then ok := true; end;
  if not ok then reset role; raise exception 'FAIL 6: B inserted an account owned by A'; end if;
  ok := false;
  begin insert into public.people (id, account_id, name) values ('P999999946', acc, 'chk forged');
  exception when insufficient_privilege then ok := true; end;
  if not ok then reset role; raise exception 'FAIL 6: B attached a person to A''s account'; end if;
  -- B sees nothing of Owner's on any table (only its own two private rows)
  foreach t in array all_t loop
    execute format('select count(*) from public.%I where %s <> %L::uuid and %s <> %L::uuid', t,
                   case when t = 'accounts' then 'sdr_uid' else 'owner_uid' end, a,
                   case when t = 'accounts' then 'sdr_uid' else 'owner_uid' end, b) into n;
    if n <> 0 then reset role; raise exception 'FAIL 6: B sees % rows of another user in %', n, t; end if;
  end loop;
  reset role;
  if (select hook from public.accounts where id = acc) is not null then raise exception 'FAIL 6: hook changed'; end if;
  -- ari_pref: B never gets Owner's stored settings
  perform set_config('request.jwt.claims', '', true);   -- written the worker way, so it belongs to Owner
  insert into public.ari_prefs (key, value, updated_at, updated_by) values ('_chk0045', '"stored"'::jsonb, now(), 'chk0045');
  if (select owner_uid from public.ari_prefs where key = '_chk0045') <> shal then raise exception 'FAIL 6: pref owner not Owner'; end if;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  if public.ari_pref('_chk0045', '"dflt"'::jsonb) <> '"dflt"'::jsonb then reset role; raise exception 'FAIL 6: B read Owner''s pref'; end if;
  reset role;
  raise notice 'ok 6 after accept: B reads A''s account/research/brief/stage + shared_people; no DM text, no private, no writes, no Owner rows';

  -- 7. C (unrelated SDR) sees nothing of A's or Owner's
  perform set_config('request.jwt.claims', json_build_object('sub', c, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  n := 0;
  foreach t in array all_t loop execute format('select count(*) + %s from public.%I', n, t) into n; end loop;
  select count(*) + n into n from app.shared_people();
  select count(*) + n into n from app.pairings where sdr_uid = a;   -- the A<-B pairing (C does see B's request to C: it is a party)
  reset role;
  if n <> 0 then raise exception 'FAIL 7: C sees % rows', n; end if;
  raise notice 'ok 7 C sees 0 rows on all 35 tables, shared_people and pairings';

  -- 8. A sees nothing of B's private rows (and nothing of Owner's)
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  select count(*) into n from public.ari_notes where body like 'chk B%';
  select count(*) + n into n from public.queue where action like 'chk B%';
  if n <> 0 then reset role; raise exception 'FAIL 8: A sees % of B''s private rows', n; end if;
  foreach t in array all_t loop
    execute format('select count(*) from public.%I where %s <> %L::uuid', t, case when t = 'accounts' then 'sdr_uid' else 'owner_uid' end, a) into n;
    if n <> 0 then reset role; raise exception 'FAIL 8: A sees % rows of another user in %', n, t; end if;
  end loop;
  reset role;
  raise notice 'ok 8 A sees none of B''s private rows and none of Owner''s';

  -- 9. unpair: A ends it -> B loses access on the next query; a re-request starts at requested again
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated; perform app.pair_end(pid); reset role;
  perform set_config('request.jwt.claims', json_build_object('sub', b, 'role', 'authenticated', 'aal', 'aal1')::text, true);
  set local role authenticated;
  select count(*) into n from public.accounts where id = acc;
  select count(*) + n into n from public.research where account_id = acc;
  select count(*) + n into n from public.account_briefs where account_id = acc;
  select count(*) + n into n from public.account_stage_history where account_id = acc;
  select count(*) + n into n from app.shared_people();
  pid2 := app.pair_request(ws, a);
  select count(*) + n into n from public.accounts where id = acc;
  reset role;
  if n <> 0 then raise exception 'FAIL 9: B still sees % shared rows after unpair / re-request', n; end if;
  if pid2 = pid or (select status from app.pairings where id = pid2) <> 'requested' then raise exception 'FAIL 9: re-request not a fresh requested row'; end if;
  -- B can end its own side too
  set local role authenticated; perform app.pair_end(pid2); reset role;
  if (select status from app.pairings where id = pid2) <> 'ended' then raise exception 'FAIL 9: AE could not end'; end if;
  raise notice 'ok 9 unpair is immediate; re-request starts at requested; either side can end';

  -- 10. Owner: still sees exactly his rows (none of A/B/C), and the worker role still sees everything it saw
  perform set_config('request.jwt.claims', json_build_object('sub', shal, 'role', 'authenticated', 'aal', 'aal2')::text, true);
  foreach t in array all_t loop
    set local role authenticated;
    execute format('select count(*) from public.%I where %s <> %L::uuid', t, case when t = 'accounts' then 'sdr_uid' else 'owner_uid' end, shal) into n;
    reset role;
    if n <> 0 then raise exception 'FAIL 10: Owner sees % rows of other users in %', n, t; end if;
  end loop;
  set local role authenticated;
  if public.ari_pref('_chk0045', '"dflt"'::jsonb) <> '"stored"'::jsonb then reset role; raise exception 'FAIL 10: Owner lost his pref'; end if;
  reset role;
  perform set_config('request.jwt.claims', json_build_object('role', 'ari_worker')::text, true);
  set local role ari_worker;
  select count(*) into n from public.accounts where id = acc;
  reset role;
  if n <> 1 then raise exception 'FAIL 10: ari_worker lost rows (sees % of the synthetic account)', n; end if;
  raise notice 'ok 10 Owner sees only his rows + his pref; ari_worker unchanged';

  raise exception 'ALL 0045 CHECKS PASSED (deliberate raise: rolled back, nothing kept)';
end $$;
