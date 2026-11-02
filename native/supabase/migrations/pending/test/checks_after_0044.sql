-- Checks for 0044 (event labels). Staging/prod-safe: ONE statement, synthetic rows only (person P999999901, synthetic account
-- uuid), and it ENDS IN A DELIBERATE RAISE so the whole transaction rolls back (nothing kept). Through the Management API the
-- reply "ALL 0044 CHECKS PASSED (deliberate raise ...)" (HTTP 400) is a pass; any "FAIL n: ..." is a fail.
\set ON_ERROR_STOP 1
do $$
declare
  sig constant text := 'public.ari_worker_event_record(text, text, text, uuid, text, timestamptz, boolean, text, text, jsonb, text, numeric, boolean, int)';
  r jsonb; r2 jsonb; n int; e app.events; refused boolean;
begin
  -- 1. objects, RLS, grants
  if to_regclass('app.events') is null or not (select relrowsecurity from pg_class where oid = 'app.events'::regclass) then
    raise exception 'FAIL 1: app.events missing or RLS off'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'app' and tablename = 'events' and policyname = 'events_read' and cmd = 'SELECT') then
    raise exception 'FAIL 1: events_read policy missing'; end if;
  if has_table_privilege('anon', 'app.events', 'select') or has_table_privilege('authenticated', 'app.events', 'insert')
     or has_table_privilege('authenticated', 'app.events', 'update') or has_table_privilege('authenticated', 'app.events', 'delete')
     or has_table_privilege('ari_worker', 'app.events', 'select') or has_table_privilege('ari_worker', 'app.events', 'insert') then
    raise exception 'FAIL 1: app.events grants too wide'; end if;
  if not has_table_privilege('authenticated', 'app.events', 'select') or not has_table_privilege('service_role', 'app.events', 'insert') then
    raise exception 'FAIL 1: authenticated read / service_role write missing'; end if;
  if not has_function_privilege('ari_worker', sig, 'execute') or not has_function_privilege('service_role', sig, 'execute')
     or has_function_privilege('authenticated', sig, 'execute') or has_function_privilege('anon', sig, 'execute') then
    raise exception 'FAIL 1: event RPC grants wrong'; end if;
  if (select prosecdef from pg_proc where oid = sig::regprocedure) is not true then raise exception 'FAIL 1: RPC not security definer'; end if;
  raise notice 'ok 1 objects and grants';

  -- 2. insert, idempotent re-run, re-label in place
  r := public.ari_worker_event_record('dm_sent', 'P999999901:dm_sent:1', 'P999999901', null, null, '2026-10-20 10:00+05:30', false,
        'people', 'people.dm1_sent', '{"step":"1","structure":"f1","hook_kind":"launch","edited":false,"persona":"Other"}'::jsonb);
  if r->>'result' <> 'inserted' then raise exception 'FAIL 2: first write %', r; end if;
  r2 := public.ari_worker_event_record('dm_sent', 'P999999901:dm_sent:1', 'P999999901', null, null, '2026-10-20 10:00+05:30', false,
        'people', 'people.dm1_sent', '{"step":"1","structure":"f1","hook_kind":"launch","edited":false,"persona":"Other"}'::jsonb);
  if r2->>'result' <> 'unchanged' or r2->>'id' <> r->>'id' then raise exception 'FAIL 2: re-run not idempotent %', r2; end if;
  r2 := public.ari_worker_event_record('dm_sent', 'P999999901:dm_sent:1', 'P999999901', null, null, '2026-10-20 10:00+05:30', false,
        'people', 'people.dm1_sent', '{"step":"1","structure":"f1","hook_kind":"launch","edited":true,"persona":"Other"}'::jsonb, 'code', null, false, 2);
  select count(*) into n from app.events where dedupe_key = 'P999999901:dm_sent:1';
  select * into e from app.events where dedupe_key = 'P999999901:dm_sent:1';
  if r2->>'result' <> 'updated' or n <> 1 or (e.labels->>'edited') <> 'true' or e.label_version <> 2 then
    raise exception 'FAIL 2: re-label in place %, rows %', r2, n; end if;
  raise notice 'ok 2 idempotent';

  -- 3. the checker refuses text, names-as-links, unknown keys, long strings, wrong enums, code-set judged labels
  foreach r in array array['{"structure":"mail x@example.com"}', '{"structure":"see https://x.co"}', '{"nope":1}',
                           '{"structure":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}', '{"hook_kind":"gossip"}', '{"edited":"yes"}',
                           '{"play":"Enterprise AI, Someone"}']::jsonb[] loop
    refused := false;
    begin
      perform public.ari_worker_event_record('dm_sent', 'P999999901:dm_sent:2', 'P999999901', null, null, now(), false, 'people', null, r);
    exception when sqlstate '22023' then refused := true; end;
    if not refused then raise exception 'FAIL 3: accepted %', r; end if;
  end loop;
  refused := false;
  begin
    perform public.ari_worker_event_record('reply', 'P999999901:reply:first', 'P999999901', null, null, now(), false, 'people', null,
                                           '{"intent":"interested"}'::jsonb, 'code');
  exception when sqlstate '22023' then refused := true; end;
  if not refused then raise exception 'FAIL 3: code set a judged label'; end if;
  raise notice 'ok 3 checker';

  -- 4. replies: needs_review rules; a code re-label keeps the worker's judged labels
  perform public.ari_worker_event_record('reply', 'P999999901:reply:first', 'P999999901', null, null, '2026-10-21 09:00+05:30', false,
        'people', null, '{"reply_to_step":"1","text_available":false}'::jsonb, 'code');
  select * into e from app.events where dedupe_key = 'P999999901:reply:first';
  if not e.needs_review then raise exception 'FAIL 4: reply with no intent not flagged'; end if;
  perform public.ari_worker_event_record('reply', 'P999999901:reply:first', 'P999999901', null, null, '2026-10-21 09:00+05:30', false,
        'people', null, '{"reply_to_step":"1","text_available":true,"intent":"interested","sentiment":"positive","next_step":"book"}'::jsonb,
        'worker', 0.9);
  select * into e from app.events where dedupe_key = 'P999999901:reply:first';
  if e.needs_review or e.labeled_by <> 'worker' then raise exception 'FAIL 4: confident worker label still flagged'; end if;
  perform public.ari_worker_event_record('reply', 'P999999901:reply:first', 'P999999901', null, null, '2026-10-21 09:00+05:30', false,
        'people', null, '{"reply_to_step":"1","text_available":true,"days_since_touch":1.5}'::jsonb, 'code');
  select * into e from app.events where dedupe_key = 'P999999901:reply:first';
  if e.labels->>'intent' <> 'interested' or e.labeled_by <> 'worker' or e.labels->>'days_since_touch' <> '1.5' then
    raise exception 'FAIL 4: code re-label lost judged labels %', e.labels; end if;
  refused := false;
  begin
    perform public.ari_worker_event_record('reply', 'P999999901:reply:first', 'P999999901', null, null, now(), false, 'people', null, '{}'::jsonb, 'shal');
  exception when sqlstate '22023' then refused := true; end;
  if not refused then raise exception 'FAIL 4: worker path accepted labeled_by shal'; end if;
  raise notice 'ok 4 replies';

  -- 5. time merge: an exact time replaces an approximate one
  perform public.ari_worker_event_record('accept', 'P999999901:accept', 'P999999901', null, null, '2026-10-14 12:00+05:30', true, 'people', null, '{}'::jsonb);
  perform public.ari_worker_event_record('accept', 'P999999901:accept', 'P999999901', null, null, '2026-10-14 09:13+05:30', false, 'log', null, '{}'::jsonb);
  select * into e from app.events where dedupe_key = 'P999999901:accept';
  if e.approx or e.occurred_at <> '2026-10-14 09:13+05:30'::timestamptz then raise exception 'FAIL 5: exact time did not win'; end if;
  raise notice 'ok 5 times';

  raise exception 'ALL 0044 CHECKS PASSED (deliberate raise: nothing kept)';
end $$;
