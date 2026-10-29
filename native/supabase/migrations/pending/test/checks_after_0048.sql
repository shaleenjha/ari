-- Checks for 0048 push digest = Today's move total. ONE statement, synthetic rows only (people P999999048xx, company names
-- starting "Zq Check", one account "Zq Meet Co", one queue row), and it ENDS IN A DELIBERATE RAISE so the whole transaction
-- rolls back (nothing kept, no notification is sent: the digest row is created and rolled back inside it).
-- Through the Management API the reply "ALL 0048 CHECKS PASSED (deliberate raise ...)" (HTTP 400) is a pass; "FAIL n: ..." is a fail.
\set ON_ERROR_STOP 1
do $$
declare
  d constant date := date '2099-01-15';        -- a far day: only the synthetic rows change between before and after
  b jsonb; a jsonb; c jsonb; t int; n int; k text; ti text; bo text;
begin
  -- 1. objects, ledger, nobody outside the database can call them
  if to_regprocedure('public.ari_move_total(date)') is null or to_regprocedure('public.ari_move_push_copy(jsonb)') is null
     or to_regprocedure('public.ari_norm_co(text)') is null then raise exception 'FAIL 1: a 0048 function is missing'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0048') then raise exception 'FAIL 1: no ledger row 0048'; end if;
  foreach k in array array['public.ari_move_total(date)', 'public.ari_move_push_copy(jsonb)', 'public.ari_norm_co(text)', 'public.ari_due_digest()'] loop
    if has_function_privilege('anon', k, 'execute') or has_function_privilege('authenticated', k, 'execute') then
      raise exception 'FAIL 1: anon or authenticated can run %', k; end if;
  end loop;
  if (select prosrc from pg_proc where oid = 'public.ari_due_digest()'::regprocedure) ~* 'follow-up|DM1|ready when you are' then
    raise exception 'FAIL 1: ari_due_digest still has the old words'; end if;
  raise notice 'ok 1 functions, ledger, grants';

  -- 2. normCo parity with web/ops.html (values worked through the JS by hand)
  if public.ari_norm_co('Zq Sample Health, Inc. (US)') <> 'zqsamplehealth' then raise exception 'FAIL 2: %', public.ari_norm_co('Zq Sample Health, Inc. (US)'); end if;
  if public.ari_norm_co('https://www.zeta.io') <> 'zeta' then raise exception 'FAIL 2: %', public.ari_norm_co('https://www.zeta.io'); end if;
  if public.ari_norm_co('The Foo Labs & Co') <> 'fooand' then raise exception 'FAIL 2: %', public.ari_norm_co('The Foo Labs & Co'); end if;
  if public.ari_norm_co(null) <> '' then raise exception 'FAIL 2: null'; end if;
  raise notice 'ok 2 normCo parity';

  -- 3. words: plain, no DM jargon, Today's hero line
  c := public.ari_move_push_copy('{"total":13,"to_send":10,"replies":2}');
  if c ->> 'title' <> '13 moves ready' or c ->> 'body' <> 'About 12 minutes. Replies first.' then raise exception 'FAIL 3: %', c; end if;
  c := public.ari_move_push_copy('{"total":1,"to_send":1,"replies":0}');
  if c ->> 'title' <> '1 move ready' or c ->> 'body' <> 'About 1 minute.' then raise exception 'FAIL 3: %', c; end if;
  c := public.ari_move_push_copy('{"total":3,"to_send":0,"replies":0}');
  if c ->> 'title' <> '3 moves ready' or c ->> 'body' <> 'Old invites to tidy up.' then raise exception 'FAIL 3: %', c; end if;
  raise notice 'ok 3 push words';

  -- 4. the count follows the client's rules (deltas from synthetic rows on a far day)
  b := public.ari_move_total(d);
  insert into public.accounts(company, meeting_status) values ('Zq Meet Co', 'set');
  insert into public.people(id, name, company, stage, review, route, accepted, connect_sent, dm1_sent, dm2_sent, replied, snooze_until, skipped, connect_day, linkedin_url, deleted_at) values
    ('P99999904801', 'Zq Check One',   'Zq Check Solo', 'Accepted',       'lead',     'Direct',          '2099-01-10', '2099-01-01', null, null, null, null, null, null, '', null),          -- First message
    ('P99999904802', 'Zq Check Two',   'Zq Check Solo', 'Accepted',       'pending',  'Direct',          '2099-01-10', '2099-01-01', null, null, null, null, null, null, '', null),          -- pending review: no
    ('P99999904803', 'Zq Check Three', 'Zq Check Solo', 'Founder',          'lead',     'Direct',          '2099-01-10', '2099-01-01', null, null, null, null, null, null, '', null),          -- exec stage: no
    ('P99999904804', 'Zq Check Four',  'Zq Check Solo', 'Accepted',       'lead',     'Founder via Aide', '2099-01-10', '2099-01-01', null, null, null, null, null, null, '', null),          -- exec route: no
    ('P99999904805', 'Zq Check Five',  'Zq Meet Co, Inc.', 'Accepted',    'lead',     'Direct',          '2099-01-10', '2099-01-01', null, null, null, null, null, null, '', null),          -- meeting on account: Hold, no
    ('P99999904806', 'Zq Check Six',   'Zq Check Cap',  'DM1 sent',       'lead',     'Direct',          '2098-12-20', '2098-12-01', '2099-01-01', null, null, null, null, null, '', null),  -- Follow-up (d1+4)
    ('P99999904807', 'Zq Check Seven', 'Zq Check Cap',  'DM1 sent',       'lead',     'Direct',          '2098-12-20', '2098-12-01', '2099-01-01', null, null, null, null, null, '', null),
    ('P99999904808', 'Zq Check Eight', 'Zq Check Cap',  'DM1 sent',       'lead',     'Direct',          '2098-12-20', '2098-12-01', '2099-01-01', null, null, null, null, null, '', null),
    ('P99999904809', 'Zq Check Nine',  'zq check cap',  'DM1 sent',       'lead',     'Direct',          '2098-12-20', '2098-12-01', '2099-01-01', null, null, null, null, null, '', null),
    ('P99999904810', 'Zq Check Ten',   'Zq Check Cap',  'DM1 sent',       'lead',     'Direct',          '2098-12-20', '2098-12-01', '2099-01-01', null, null, null, null, null, '', null),  -- 5th at one company: capped
    ('P99999904811', 'Zq Check Eleven','Zq Check Solo', 'DM2 sent',       'lead',     'Direct',          '2098-12-01', '2098-11-20', '2098-12-20', '2099-01-05', null, null, null, null, '', null), -- Last note (d2+7 = Jan 12)
    ('P99999904812', 'Zq Check Twelve','Zq Check Solo', 'DM2 sent',       'lead',     'Direct',          '2098-12-01', '2098-11-20', '2098-12-20', '2099-01-12', null, null, null, null, '', null), -- Jan 19: not yet
    ('P99999904813', 'Zq Check Thirteen','Zq Check Solo','Connect sent',  'lead',     'Direct',          null, '2098-12-30', null, null, null, null, null, null, '', null),                  -- 16 days: withdraw
    ('P99999904814', 'Zq Check Fourteen','Zq Check Solo','Connect sent',  'lead',     'Direct',          null, '2099-01-10', null, null, null, null, null, null, '', null),                  -- 5 days: no
    ('P99999904815', 'Zq Check Fifteen','Zq Check Solo', 'Replied',       'lead',     'Direct',          '2098-12-01', '2098-11-20', '2098-12-05', null, '2099-01-14', null, null, null, '', null), -- Reply
    ('P99999904816', 'Zq Check Sixteen','Zq Check Solo', 'Accepted',      'lead',     'Direct',          '2099-01-10', '2099-01-01', null, null, null, '2099-01-20', null, null, '', null),  -- snoozed: no
    ('P99999904817', 'Zq Check Seventeen','Zq Check Solo','Accepted',     'lead',     'Direct',          '2099-01-10', '2099-01-01', null, null, null, null, '2099-01-11', null, '', null),  -- skipped: no
    ('P99999904818', 'Zq Check Eighteen','Zq Check Solo','Connect queued','lead',     'Direct',          null, null, null, null, null, null, null, '2099-01-10', '', null),                  -- model connect: only Today's invites count
    ('P99999904819', 'Zq Check Nineteen','Zq Check Solo','Accepted',      'personal', 'Direct',          '2099-01-10', '2099-01-01', null, null, null, null, null, null, '', null),          -- personal: no
    ('P99999904820', 'Zq Check Twenty', 'Zq Check Solo', 'Accepted',      'lead',     'Direct',          '2099-01-10', '2099-01-01', null, null, null, null, null, null, '', '2099-01-12'),  -- deleted: no
    ('P99999904821', 'Zq Check TwentyOne','Zq Check Solo','Accepted',     'lead',     'Direct',          '2099-01-10', '2099-01-01', null, null, null, null, null, null, '', null);          -- sent to the exec: no
  insert into public.queue(action, target, status) values ('Send to Founder', 'P99999904821', 'queued');
  a := public.ari_move_total(d);
  if (a ->> 'dm1')::int - (b ->> 'dm1')::int <> 1 then raise exception 'FAIL 4: first messages +% (want 1) %', (a ->> 'dm1')::int - (b ->> 'dm1')::int, a; end if;
  if (a ->> 'dm2')::int - (b ->> 'dm2')::int <> 4 then raise exception 'FAIL 4: follow-ups +% (want 4, capped) %', (a ->> 'dm2')::int - (b ->> 'dm2')::int, a; end if;
  if (a ->> 'dm3')::int - (b ->> 'dm3')::int <> 1 then raise exception 'FAIL 4: last notes +% (want 1) %', (a ->> 'dm3')::int - (b ->> 'dm3')::int, a; end if;
  if (a ->> 'withdraws')::int - (b ->> 'withdraws')::int <> 1 then raise exception 'FAIL 4: withdraws +% (want 1) %', (a ->> 'withdraws')::int - (b ->> 'withdraws')::int, a; end if;
  if (a ->> 'replies')::int - (b ->> 'replies')::int <> 1 then raise exception 'FAIL 4: replies +% (want 1) %', (a ->> 'replies')::int - (b ->> 'replies')::int, a; end if;
  if (a ->> 'connects')::int - (b ->> 'connects')::int <> 0 then raise exception 'FAIL 4: connects +% (want 0) %', (a ->> 'connects')::int - (b ->> 'connects')::int, a; end if;
  if (a ->> 'total')::int - (b ->> 'total')::int <> 8 or (a ->> 'to_send')::int - (b ->> 'to_send')::int <> 7 then
    raise exception 'FAIL 4: total +% / to send +% (want 8 / 7) %', (a ->> 'total')::int - (b ->> 'total')::int, (a ->> 'to_send')::int - (b ->> 'to_send')::int, a; end if;
  raise notice 'ok 4 move total follows Today (% before, % after)', b ->> 'total', a ->> 'total';

  -- 5. the 21:00 digest end to end: one row, the same number, plain words (rolled back with everything else)
  k := 'digest:' || (now() at time zone 'Asia/Kolkata')::date;
  delete from public.notifications where dedupe_key = k;
  t := public.ari_due_digest();
  a := public.ari_move_total(null);
  if t <> (a ->> 'total')::int then raise exception 'FAIL 5: digest returned %, move total %', t, a ->> 'total'; end if;
  select count(*), max(title), max(body) into n, ti, bo from public.notifications where dedupe_key = k;
  if t = 0 then
    if n <> 0 then raise exception 'FAIL 5: a digest row with nothing to do'; end if;
  else
    c := public.ari_move_push_copy(a);
    if n <> 1 or ti <> c ->> 'title' or bo <> c ->> 'body' then raise exception 'FAIL 5: row % / % / % (want %)', n, ti, bo, c; end if;
    if ti !~ '^[0-9]+ moves? ready$' or (ti || ' ' || bo) ~* 'DM[0-9]|follow-up|Ari\M' then raise exception 'FAIL 5: words % / %', ti, bo; end if;
    perform public.ari_due_digest();
    select count(*) into n from public.notifications where dedupe_key = k;
    if n <> 1 then raise exception 'FAIL 5: a second run made % rows (want 1)', n; end if;
  end if;
  raise notice 'ok 5 digest: % (%)', coalesce(ti, 'no row'), coalesce(bo, '-');

  raise exception 'ALL 0048 CHECKS PASSED (deliberate raise: rolled back, nothing kept)';
end $$;
