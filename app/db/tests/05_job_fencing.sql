-- 0005 job runner reliability: two-worker stale finish, NULL fence args stale, crash-loop to dead, non-retryable to dead,
-- jitter bounds, agents_paused skips agent.* but not other kinds and fails closed, app users cannot flip the switch,
-- and a pause keeps crash-loop cleanup. Synthetic ids only.

-- 1. fencing: w1's lease expires, w2 reclaims, w1's late finish is stale and changes nothing
set role app_jobs;
select app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'fence-a', '{}', 'f1');
select set_config('t.w1_att', c.attempts::text, false) from app.job_claim('w1', array['fence-a'], 1) c;
reset role;
update app.jobs set locked_until = now() - interval '1 second' where kind = 'fence-a';   -- w1 hung past its lease
set role app_jobs;
do $$ declare id1 uuid; a1 int := current_setting('t.w1_att')::int; a2 int; r text; begin
  select c.id, c.attempts into id1, a2 from app.job_claim('w2', array['fence-a'], 1) c;
  assert a1 = 1 and a2 = 2, 'w2 reclaims the expired lease as attempt 2';
  r := app.job_finish(id1, 'w1', a1, true, '{"by":"w1"}');
  assert r = 'stale', 'late finish from the old lease holder is stale, got ' || r;
  r := app.job_finish(id1, 'w2', a1, true, '{"by":"w2-old-attempt"}');
  assert r = 'stale', 'right worker, wrong attempt is stale';
  perform set_config('t.fence_id', id1::text, false);
  perform set_config('t.w2_att', a2::text, false);
end $$;
reset role;
do $$ declare j record; begin   -- as owner: the worker role cannot read app.jobs
  select status, locked_by, result into j from app.jobs where kind = 'fence-a';
  assert j.status = 'running' and j.locked_by = 'w2' and j.result is null, 'stale finish changed nothing';
end $$;
set role app_jobs;
do $$ declare id1 uuid := current_setting('t.fence_id')::uuid; r text; begin
  r := app.job_finish(id1, 'w2', current_setting('t.w2_att')::int, true, '{"by":"w2"}');
  assert r = 'done', 'current holder finishes';
  r := app.job_finish(id1, 'w1', current_setting('t.w1_att')::int, false, null, 'late failure');
  assert r = 'stale', 'finish after done is stale';
  assert app.job_finish(gen_random_uuid(), 'w1', 1, true) = 'missing', 'unknown id is missing';
end $$;
reset role;
do $$ declare j record; begin
  select status, result, last_error into j from app.jobs where kind = 'fence-a';
  assert j.status = 'done' and j.result ->> 'by' = 'w2' and j.last_error is null, 'done result kept, late failure ignored';
end $$;
select 'ok fencing: stale finish ignored';

-- 1b. NULL worker or NULL attempt never passes the fence (a plain <> against NULL would skip it)
set role app_jobs;
do $$ declare id1 uuid; a int; begin
  perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'fence-null', '{}', 'fn1');
  select c.id, c.attempts into id1, a from app.job_claim('w1', array['fence-null'], 1) c;
  assert app.job_finish(id1, 'w1', null, true, '{"by":"null-attempt"}') = 'stale', 'NULL attempt is stale';
  assert app.job_finish(id1, null, a, true, '{"by":"null-worker"}') = 'stale', 'NULL worker is stale';
  assert app.job_finish(id1, null, null, false, null, 'x', false) = 'stale', 'NULL worker and attempt is stale';
end $$;
reset role;
do $$ declare j record; begin
  select status, locked_by, result, last_error into j from app.jobs where kind = 'fence-null';
  assert j.status = 'running' and j.locked_by = 'w1' and j.result is null and j.last_error is null, 'NULL finishes changed nothing';
end $$;
select 'ok fencing: NULL worker / attempt stale';

-- 2. crash-loop cap: expired lease at max attempts goes to dead, below max is reclaimed
set role app_jobs;
select app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'loop-a', '{}', 'l1');
select app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'loop-a', '{}', 'l2');
reset role;
update app.jobs set status = 'running', locked_by = 'crashed', locked_until = now() - interval '1 second',
       attempts = case idempotency_key when 'l1' then 5 else 2 end where kind = 'loop-a';
set role app_jobs;
do $$ declare n int; k int; begin
  select count(*), max(c.attempts) into n, k from app.job_claim('w1', array['loop-a'], 5) c;
  assert n = 1 and k = 3, 'only the below-max job is reclaimed (attempt 3)';
end $$;
reset role;
do $$ declare j record; begin
  select status, last_error, locked_by, finished_at into j from app.jobs where kind = 'loop-a' and idempotency_key = 'l1';
  assert j.status = 'dead' and j.last_error = 'lease expired at max attempts' and j.locked_by is null and j.finished_at is not null,
    'crash loop at max attempts is dead';
end $$;
select 'ok crash-loop cap';

-- 3. non-retryable failure goes straight to dead on attempt 1
set role app_jobs;
do $$ declare id1 uuid; a int; r text; begin
  perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'nr-a', '{}', 'n1');
  select c.id, c.attempts into id1, a from app.job_claim('w1', array['nr-a'], 1) c;
  r := app.job_finish(id1, 'w1', a, false, null, 'bad payload', false);
  assert a = 1 and r = 'dead', 'non-retryable is dead at attempt 1';
end $$;
reset role;
select 'ok non-retryable';

-- 4. jitter: attempt 1 retries in 30 s +/-20% (24..36 s), attempt 3 in 120 s +/-20%, and the delays differ
set role app_jobs;
do $$ declare r record; begin
  for i in 1..60 loop perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'jit-a', '{}', 'j' || i); end loop;
  for r in select * from app.job_claim('w1', array['jit-a'], 60) loop
    assert app.job_finish(r.id, 'w1', r.attempts, false, null, 'transient') = 'retry', 'retry';
  end loop;
end $$;
reset role;
do $$ declare lo double precision; hi double precision; begin
  select min(extract(epoch from run_after - now())), max(extract(epoch from run_after - now())) into lo, hi
    from app.jobs where kind = 'jit-a';
  -- run_after was set in an earlier transaction, so allow the seconds elapsed since then
  assert lo >= 23 and hi <= 36.001, format('attempt 1 delay in 24..36 s, got %s..%s', lo, hi);
  assert hi - lo > 2, format('jitter spreads retries, got %s..%s', lo, hi);
end $$;
reset role;
update app.jobs set run_after = now(), attempts = 2 where kind = 'jit-a';
set role app_jobs;
do $$ declare r record; n int := 0; begin
  for r in select * from app.job_claim('w1', array['jit-a'], 60) loop
    assert r.attempts = 3 and app.job_finish(r.id, 'w1', r.attempts, false, null, 'transient') = 'retry', 'retry at attempt 3';
    n := n + 1;
  end loop;
  assert n = 60, 'all 60 reclaimed';
end $$;
reset role;
do $$ declare lo double precision; hi double precision; begin
  select min(extract(epoch from run_after - now())), max(extract(epoch from run_after - now())) into lo, hi
    from app.jobs where kind = 'jit-a';
  assert lo >= 95 and hi <= 144.001, format('attempt 3 delay in 96..144 s, got %s..%s', lo, hi);
end $$;
select 'ok jitter bounds';

-- 5. kill switch: agents_paused skips agent.* kinds only; worker-only to change
set role app_jobs;
do $$ declare n int; ks text[]; begin
  perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'agent.draft', '{}', 'k1');
  perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'agent.research', '{}', 'k2');
  perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'agentx', '{}', 'k3');
  perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'det-a', '{}', 'k4');
  assert app.set_agents_paused(true), 'paused';
  select array_agg(c.kind order by c.kind) into ks from app.job_claim('w1', array['agent.draft','agent.research','agentx','det-a'], 10) c;
  assert ks = array['agentx','det-a'], 'paused claim skips agent.* only, got ' || ks::text;
  assert not app.set_agents_paused(false), 'unpaused';
  select array_agg(c.kind order by c.kind) into ks from app.job_claim('w1', array['agent.draft','agent.research'], 10) c;
  assert ks = array['agent.draft','agent.research'], 'unpaused claim runs agent jobs';
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000005d', false);
do $$ begin
  begin perform app.set_agents_paused(true); raise exception 'app user flipped the kill switch';
  exception when insufficient_privilege then null; end;
  begin perform 1 from app_ops.settings; raise exception 'app user read settings';
  exception when insufficient_privilege then null; end;
  begin perform app.job_finish(gen_random_uuid(), 'x', 1, true); raise exception 'app user finished a job';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'ok kill switch';

-- 5b. kill switch fails closed: NULL rejected, JSON booleans only, missing row pauses agent.* (not other kinds)
do $$ declare v jsonb; begin   -- as owner: the row is readable for ops checks (and before a rollback)
  select value into v from app_ops.settings where key = 'agents_paused';
  assert v = 'false'::jsonb, 'owner reads agents_paused = false, got ' || coalesce(v::text, 'no row');
  begin update app_ops.settings set value = '"no"' where key = 'agents_paused'; raise exception 'non-boolean value accepted';
  exception when check_violation then null; end;
  begin update app_ops.settings set value = 'null' where key = 'agents_paused'; raise exception 'JSON null accepted';
  exception when check_violation then null; end;
  begin update app_ops.settings set value = '0' where key = 'agents_paused'; raise exception 'number accepted';
  exception when check_violation then null; end;
end $$;
set role app_jobs;
do $$ begin
  begin perform app.set_agents_paused(null); raise exception 'setter accepted NULL';
  exception when null_value_not_allowed then null; end;
  assert not app.agents_paused(), 'NULL attempt left the switch unpaused';
end $$;
reset role;
delete from app_ops.settings where key = 'agents_paused';   -- row lost (bad restore, manual delete)
set role app_jobs;
do $$ declare ks text[]; begin
  assert app.agents_paused(), 'missing row reads as paused';
  perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'agent.missing', '{}', 'm1');
  perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'det-missing', '{}', 'm2');
  select array_agg(c.kind order by c.kind) into ks from app.job_claim('w1', array['agent.missing','det-missing'], 10) c;
  assert ks = array['det-missing'], 'missing row: agent.* skipped, other kinds run, got ' || coalesce(ks::text, 'none');
  assert not app.set_agents_paused(false), 'setter recreates the row';
  select array_agg(c.kind) into ks from app.job_claim('w1', array['agent.missing'], 10) c;
  assert ks = array['agent.missing'], 'explicit false runs agent jobs again';
end $$;
reset role;
select 'ok kill switch fails closed';

-- 6. a pause does not stop crash-loop cleanup: an expired max-attempt agent job still goes dead while paused
set role app_jobs;
select app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'agent.loop', '{}', 'al1');
select app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'agent.loop', '{}', 'al2');
select app.set_agents_paused(true);
reset role;
update app.jobs set status = 'running', locked_by = 'crashed', locked_until = now() - interval '1 second',
       attempts = case idempotency_key when 'al1' then 5 else 2 end where kind = 'agent.loop';
set role app_jobs;
do $$ declare n int; begin
  select count(*) into n from app.job_claim('w1', array['agent.loop'], 5) c;
  assert n = 0, 'paused: the below-max agent job is not reclaimed';
end $$;
reset role;
do $$ declare d text; r text; begin
  select status into d from app.jobs where kind = 'agent.loop' and idempotency_key = 'al1';
  select status into r from app.jobs where kind = 'agent.loop' and idempotency_key = 'al2';
  assert d = 'dead', 'paused: expired max-attempt agent job still goes dead, got ' || d;
  assert r = 'running', 'paused: below-max expired agent job waits (still running, lease expired), got ' || r;
end $$;
set role app_jobs;
select app.set_agents_paused(false);
reset role;
select 'ok pause keeps crash-loop cleanup';
select 'PASS 05_job_fencing';
