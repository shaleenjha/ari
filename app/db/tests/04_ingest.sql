-- gmail-ingest storage: cursor compare-and-set, idempotent writes, cross-workspace person ids dropped, shadow promotion rule,
-- "Who is this?" confirm (members only, Ari cannot), and app users cannot touch the worker functions. Synthetic ids only.
set role app_jobs;
do $$ declare ok boolean; n int; begin
  assert app.ingest_cursor_get('aaaaaaaa-0000-0000-0000-000000000001', 'mbx-a') is null, 'no cursor yet';
  ok := app.ingest_cursor_advance('aaaaaaaa-0000-0000-0000-000000000001', 'mbx-a', null, '1000');
  assert ok, 'first set';
  ok := app.ingest_cursor_advance('aaaaaaaa-0000-0000-0000-000000000001', 'mbx-a', null, '2000');
  assert not ok, 'second bootstrap must lose';
  ok := app.ingest_cursor_advance('aaaaaaaa-0000-0000-0000-000000000001', 'mbx-a', '999', '2000');
  assert not ok, 'stale from must lose';
  ok := app.ingest_cursor_advance('aaaaaaaa-0000-0000-0000-000000000001', 'mbx-a', '1000', '900');
  assert not ok, 'never moves backwards without resync';
  ok := app.ingest_cursor_advance('aaaaaaaa-0000-0000-0000-000000000001', 'mbx-a', '1000', '1500');
  assert ok and app.ingest_cursor_get('aaaaaaaa-0000-0000-0000-000000000001', 'mbx-a') = '1500', 'advance';
  ok := app.ingest_cursor_advance('aaaaaaaa-0000-0000-0000-000000000001', 'mbx-a', '1500', '1200', true);
  assert ok, 'resync may reset';

  n := app.ingest_record('aaaaaaaa-0000-0000-0000-000000000001', '[
    {"source_msg_id":"g-1","kind":"accept","parsed":{"name":"Jordan Example"},"matched_person_id":"aaaaaaaa-0000-0000-0000-0000000000d1","match_method":"vanity","received_at":"2026-10-20T09:14:05Z"},
    {"source_msg_id":"g-2","kind":"reply","parsed":{"name":"Pat Unknown"},"match_method":"none","received_at":"2026-10-20T10:00:00Z"},
    {"source_msg_id":"g-3","kind":"accept","parsed":{"name":"x"},"matched_person_id":"bbbbbbbb-0000-0000-0000-0000000000d1","match_method":"vanity","received_at":"2026-10-20T10:00:00Z"}]');
  assert n = 3, 'three rows';
  n := app.ingest_record('aaaaaaaa-0000-0000-0000-000000000001', '[{"source_msg_id":"g-1","kind":"accept","parsed":{},"received_at":"2026-10-20T09:14:05Z"}]');
  assert n = 0, 'replay is a no-op';

  perform app.shadow_report_put('aaaaaaaa-0000-0000-0000-000000000001', date '2026-10-18', '{"agree":true,"counts":{"unmatched":0}}');
  perform app.shadow_report_put('aaaaaaaa-0000-0000-0000-000000000001', date '2026-10-19', '{"agree":true,"counts":{"unmatched":1}}');
  assert not app.shadow_promotion_ready('aaaaaaaa-0000-0000-0000-000000000001', date '2026-10-20'), 'two nights is not enough';
  perform app.shadow_report_put('aaaaaaaa-0000-0000-0000-000000000001', date '2026-10-20', '{"agree":true,"counts":{"unmatched":0}}');
  assert app.shadow_promotion_ready('aaaaaaaa-0000-0000-0000-000000000001', date '2026-10-20'), 'three clean nights';
  assert not app.shadow_promotion_ready('aaaaaaaa-0000-0000-0000-000000000001', date '2026-10-25'), 'stale reports do not promote';
  perform app.shadow_report_put('aaaaaaaa-0000-0000-0000-000000000001', date '2026-10-20', '{"agree":false,"counts":{"unmatched":0}}');
  assert not app.shadow_promotion_ready('aaaaaaaa-0000-0000-0000-000000000001', date '2026-10-20'), 'a disagreeing night blocks';
end $$;
reset role;
do $$ begin
  assert (select matched_person_id from app.ingest_events where source_msg_id = 'g-3') is null, 'cross-workspace person id dropped';
  assert (select count(*) from app.ingest_events where workspace_id = 'bbbbbbbb-0000-0000-0000-000000000001') = 0, 'nothing written to B';
end $$;

set role authenticated;
-- Ari (agent) cannot confirm; the SDR can, once; replay by op id returns the same answer
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-0000000000a9', false);
do $$ declare ev uuid; begin
  select id into ev from app.ingest_events where source_msg_id = 'g-2';
  begin perform app.ingest_confirm_match('aaaaaaaa-0000-0000-0000-000000000001', ev, 'aaaaaaaa-0000-0000-0000-0000000000d1');
        raise exception 'agent confirmed';
  exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000005d', false);
do $$ declare ev uuid; r jsonb; r2 jsonb; begin
  select id into ev from app.ingest_events where source_msg_id = 'g-2';
  r := app.ingest_confirm_match('aaaaaaaa-0000-0000-0000-000000000001', ev, 'aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-00000000f001');
  assert (r->>'ok')::boolean, 'sdr confirms';
  r2 := app.ingest_confirm_match('aaaaaaaa-0000-0000-0000-000000000001', ev, null, 'aaaaaaaa-0000-0000-0000-00000000f001');
  assert r2 = r, 'replay returns first answer';
  r2 := app.ingest_confirm_match('aaaaaaaa-0000-0000-0000-000000000001', ev, null);
  assert r2->>'conflict' = 'true', 'second confirm conflicts';
  begin perform app.ingest_cursor_advance('aaaaaaaa-0000-0000-0000-000000000001', 'mbx-a', '1200', '5000'); raise exception 'app user moved cursor';
  exception when insufficient_privilege then null; end;
  begin perform app.ingest_record('aaaaaaaa-0000-0000-0000-000000000001', '[]'); raise exception 'app user wrote ingest rows';
  exception when insufficient_privilege then null; end;
  assert (select count(*) from app.shadow_reports) = 3, 'member reads own reports';
end $$;
select set_config('request.jwt.claim.sub', 'b0000000-0000-0000-0000-00000000005d', false);
do $$ begin
  assert (select count(*) from app.shadow_reports) = 0, 'B member sees no A reports';
  begin perform app.ingest_confirm_match('aaaaaaaa-0000-0000-0000-000000000001', gen_random_uuid(), null); raise exception 'stranger confirmed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS 04_ingest';
