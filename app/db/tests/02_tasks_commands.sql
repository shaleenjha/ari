-- Task graph + command RPC rules (platform.md role table). Runs as authenticated users of workspace A.
set role authenticated;
-- helper to switch user
create or replace function pg_temp.as_user(u uuid) returns void language sql as $$ select set_config('request.jwt.claim.sub', u::text, false) $$;

-- SDR creates own task; asks the AE on a shared account; cannot ask the AE on a non-shared account
select pg_temp.as_user('a0000000-0000-0000-0000-00000000005d');
do $$ declare r jsonb; ask uuid; begin
  r := app.task_create('aaaaaaaa-0000-0000-0000-000000000001', 'connect', 'Connect with Jordan', 'sdr', null,
                       'aaaaaaaa-0000-0000-0000-0000000000c1', 'aaaaaaaa-0000-0000-0000-0000000000d1');
  assert r ->> 'status' = 'todo', 'sdr own task todo';
  r := app.task_create('aaaaaaaa-0000-0000-0000-000000000001', 'ask', 'Warm path into Exquorra?', 'ae',
                       'a0000000-0000-0000-0000-0000000000ae', 'aaaaaaaa-0000-0000-0000-0000000000c1');
  assert (r ->> 'ok')::bool, 'ask on shared account';
  begin
    perform app.task_create('aaaaaaaa-0000-0000-0000-000000000001', 'ask', 'Ask on unshared', 'ae',
                            'a0000000-0000-0000-0000-0000000000ae', 'aaaaaaaa-0000-0000-0000-0000000000c2');
    raise exception 'ask on unshared account allowed';
  exception when insufficient_privilege then null; end;
end $$;
select 'ok sdr create + ask rules';

-- op_id idempotency: replay returns the same task, no duplicate
do $$ declare r1 jsonb; r2 jsonb; begin
  r1 := app.task_create('aaaaaaaa-0000-0000-0000-000000000001', 'custom', 'Offline op', 'sdr', null, null, null, null, '{}', '11111111-2222-3333-4444-555555555555');
  r2 := app.task_create('aaaaaaaa-0000-0000-0000-000000000001', 'custom', 'Offline op', 'sdr', null, null, null, null, '{}', '11111111-2222-3333-4444-555555555555');
  assert r1 ->> 'id' = r2 ->> 'id', 'replay made a new task';
  assert (select count(*) from app.tasks where title = 'Offline op') = 1, 'duplicate task';
end $$;
select 'ok op_id idempotent';

-- AE cannot move the SDR's task; SDR can; stale version -> conflict; illegal transition rejected
do $$ declare tid uuid; r jsonb; begin
  select id into tid from app.tasks where title = 'Connect with Jordan';
  perform pg_temp.as_user('a0000000-0000-0000-0000-0000000000ae');
  begin perform app.task_transition('aaaaaaaa-0000-0000-0000-000000000001', tid, 'done', 1); raise exception 'AE moved SDR task';
  exception when insufficient_privilege then null; end;
  perform pg_temp.as_user('a0000000-0000-0000-0000-00000000005d');
  r := app.task_transition('aaaaaaaa-0000-0000-0000-000000000001', tid, 'in_progress', 1);
  assert (r ->> 'version')::int = 2, 'version bump';
  r := app.task_transition('aaaaaaaa-0000-0000-0000-000000000001', tid, 'done', 1);
  assert (r ->> 'conflict')::bool and r -> 'current' ->> 'status' = 'in_progress', 'stale version must conflict';
  r := app.task_transition('aaaaaaaa-0000-0000-0000-000000000001', tid, 'done', 2);
  assert r ->> 'status' = 'done', 'done';
  begin perform app.task_transition('aaaaaaaa-0000-0000-0000-000000000001', tid, 'in_progress', 3); raise exception 'done->in_progress allowed';
  exception when check_violation then null; end;
  assert (select count(*) from app.task_events where task_id = tid) = 3, 'events: created + 2 status';
end $$;
select 'ok transitions + concurrency';

-- Agent proposes; cannot accept its own proposal; a human (assignee role) accepts; agent cannot nudge or send
select pg_temp.as_user('a0000000-0000-0000-0000-0000000000a9');
do $$ declare r jsonb; begin
  r := app.task_create('aaaaaaaa-0000-0000-0000-000000000001', 'research', 'Research Exquorra hiring', 'sdr', null, 'aaaaaaaa-0000-0000-0000-0000000000c1');
  assert r ->> 'status' = 'proposed', 'agent task must be proposed';
  begin perform app.task_transition('aaaaaaaa-0000-0000-0000-000000000001', (r ->> 'id')::uuid, 'todo', 1); raise exception 'agent accepted own proposal';
  exception when insufficient_privilege then null; end;
  begin perform app.task_nudge('aaaaaaaa-0000-0000-0000-000000000001', (r ->> 'id')::uuid, 'hi'); raise exception 'agent nudged';
  exception when insufficient_privilege then null; end;
  begin perform app.person_mark('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'dm1_sent'); raise exception 'agent sent a DM';
  exception when insufficient_privilege then null; end;
  r := app.person_mark('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'accepted', now() - interval '1 hour');
  assert (r ->> 'ok')::bool, 'agent records accept';
end $$;
select pg_temp.as_user('a0000000-0000-0000-0000-00000000005d');
do $$ declare tid uuid; r jsonb; begin
  select id into tid from app.tasks where title = 'Research Exquorra hiring';
  r := app.task_transition('aaaaaaaa-0000-0000-0000-000000000001', tid, 'todo', 1);
  assert r ->> 'status' = 'todo', 'human accepted proposal';
  assert exists (select 1 from app.task_events where task_id = tid and type = 'accepted' and actor_kind = 'sdr'), 'accepted event by sdr';
end $$;
select 'ok agent proposals';

-- Dependencies: AE "approve angle" blocks SDR "send DM1"; done -> dependent ready; cycles rejected
do $$ declare a jsonb; b jsonb; r jsonb; begin
  perform pg_temp.as_user('a0000000-0000-0000-0000-00000000005d');
  a := app.task_create('aaaaaaaa-0000-0000-0000-000000000001', 'review_draft', 'Approve angle', 'ae', 'a0000000-0000-0000-0000-0000000000ae', 'aaaaaaaa-0000-0000-0000-0000000000c1');
  b := app.task_create('aaaaaaaa-0000-0000-0000-000000000001', 'dm', 'Send DM1 to Jordan', 'sdr', null, 'aaaaaaaa-0000-0000-0000-0000000000c1');
  perform app.task_link('aaaaaaaa-0000-0000-0000-000000000001', (a ->> 'id')::uuid, (b ->> 'id')::uuid, 'blocks');
  assert (select status from app.tasks where id = (b ->> 'id')::uuid) = 'blocked', 'dependent blocked';
  begin perform app.task_link('aaaaaaaa-0000-0000-0000-000000000001', (b ->> 'id')::uuid, (a ->> 'id')::uuid, 'blocks'); raise exception 'cycle allowed';
  exception when check_violation then null; end;
  perform pg_temp.as_user('a0000000-0000-0000-0000-0000000000ae');
  r := app.task_nudge('aaaaaaaa-0000-0000-0000-000000000001', (b ->> 'id')::uuid, 'Angle approved soon');
  assert (r ->> 'ok')::bool, 'AE nudges on shared account';
  r := app.task_nudge('aaaaaaaa-0000-0000-0000-000000000001', (b ->> 'id')::uuid, 'again');
  assert (r ->> 'rate_limited')::bool, 'nudge rate limit';
  r := app.task_transition('aaaaaaaa-0000-0000-0000-000000000001', (a ->> 'id')::uuid, 'done', 1);
  assert (select status from app.tasks where id = (b ->> 'id')::uuid) = 'ready', 'dependent ready after blocker done';
end $$;
select 'ok dependencies + nudges';

-- Manager may move anyone's task; activity records actor kinds ari / sdr / ae / manager
select pg_temp.as_user('a0000000-0000-0000-0000-00000000003a');
do $$ declare tid uuid; v int; begin
  select id, version into tid, v from app.tasks where title = 'Send DM1 to Jordan';
  perform app.task_transition('aaaaaaaa-0000-0000-0000-000000000001', tid, 'cancelled', v);
  assert (select array_agg(distinct actor_kind::text order by actor_kind::text) from app.activity where workspace_id = 'aaaaaaaa-0000-0000-0000-000000000001')
         = array['ae','ari','manager','sdr'], 'activity actor kinds';
end $$;
select 'ok manager + activity';

-- SDR send flow: stage follows facts, DM2 due +4 days, metric fact deduped, linkedin vanity parsed
select pg_temp.as_user('a0000000-0000-0000-0000-00000000005d');
do $$ begin
  perform app.person_mark('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'dm1_sent', '2026-10-20 10:00+05:30');
  perform app.person_mark('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'dm1_sent', '2026-10-21 10:00+05:30');
  assert (select stage from app.people where id = 'aaaaaaaa-0000-0000-0000-0000000000d1') = 'dm1_sent', 'stage';
  assert (select dm1_sent_at from app.people where id = 'aaaaaaaa-0000-0000-0000-0000000000d1') = '2026-10-20 10:00+05:30', 'first tap wins';
  assert (select dm2_due from app.people where id = 'aaaaaaaa-0000-0000-0000-0000000000d1') = '2026-10-24', 'dm2 +4d';
  assert (select count(*) from app.metric_facts where metric = 'dm1_sent') = 1, 'metric deduped';
  assert (select linkedin_vanity from app.people where id = 'aaaaaaaa-0000-0000-0000-0000000000d1') = 'jordan-example-123', 'vanity';
end $$;
select 'ok send flow';
reset role;
select 'PASS 02_tasks_commands';
