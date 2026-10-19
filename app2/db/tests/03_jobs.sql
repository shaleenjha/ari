-- job queue: idempotent enqueue, skip-locked claim, backoff, dead letter, not callable by app users
set role app_jobs;
do $$ declare a uuid; b uuid; n int; att int; r text; begin
  a := app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'gmail-ingest', '{"history_id":"1"}', 'h1');
  b := app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'gmail-ingest', '{"history_id":"1"}', 'h1');
  assert a = b, 'enqueue not idempotent';
  select count(*), max(c.attempts) into n, att from app.job_claim('w1', array['gmail-ingest'], 5) c;
  assert n = 1 and att = 1, 'claim 1, attempts returned';
  select count(*) into n from app.job_claim('w2', array['gmail-ingest'], 5);
  assert n = 0, 'second worker must not get a locked job';
  r := app.job_finish(a, 'w1', att, false, null, 'transient');
  assert r = 'retry', 'retry';
  select count(*) into n from app.job_claim('w1', array['gmail-ingest'], 5);
  assert n = 0, 'backoff holds the job';
end $$;
reset role;
update app.jobs set run_after = now(), attempts = 4 where kind = 'gmail-ingest';
set role app_jobs;
do $$ declare id1 uuid; att int; r text; begin
  select c.id, c.attempts into id1, att from app.job_claim('w1', array['gmail-ingest'], 5) c;
  r := app.job_finish(id1, 'w1', att, false, null, 'still failing');
  assert r = 'dead', 'dead after max attempts';
  assert (app.job_health() ->> 'dead_24h')::int = 1, 'health shows dead';
end $$;
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', 'a0000000-0000-0000-0000-00000000005d', false);
do $$ begin
  begin perform app.job_enqueue('aaaaaaaa-0000-0000-0000-000000000001', 'x'); raise exception 'app user enqueued';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
select 'PASS 03_jobs';
