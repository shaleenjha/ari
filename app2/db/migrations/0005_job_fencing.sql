-- app2 0005: job runner reliability (audit R-20261019-06).
-- 1. Fencing: job_finish only applies for the worker and attempt that hold the lease; anything else is 'stale', no change.
-- 2. Crash-loop cap: an expired lease at max attempts goes to dead instead of running again.
-- 3. Non-retryable failures go straight to dead.
-- 4. Backoff jitter: +/-20% on 30 s * 2^(n-1), capped at 1 h before jitter (mirrored by backoffSeconds in worker.ts).
-- 5. Kill switch: app_ops.settings 'agents_paused' makes job_claim skip kinds 'agent.%'. Only the worker role can change it.
--    Fails closed: a missing row or a value other than JSON false counts as paused for agent.* kinds.
--    A pause stops new claims only: in-flight handlers run on, and the crash-loop cap still marks expired max-attempt
--    agent.* jobs dead during a pause.
-- Deploy order: stop the worker, run this migration, then start the new worker (the old 4-arg job_finish is dropped,
-- so an old worker fails every finish once this runs).
-- Rollback: db/rollbacks/0005_job_fencing_down.sql (drops app_ops, so the pause state is lost; read it first).

-- Global switches live outside the tenant schema: every app.* table is workspace-scoped (tests/01 catalog check).
-- No grants on the schema or table; only the security definer functions below read or write it.
create schema app_ops;
revoke all on schema app_ops from public;
create table app_ops.settings (
  key text primary key check (key in ('agents_paused')),
  value jsonb not null check (value in ('true'::jsonb, 'false'::jsonb)),   -- JSON booleans only
  updated_at timestamptz not null default now()
);
alter table app_ops.settings enable row level security;  alter table app_ops.settings force row level security;  -- no policies
revoke all on app_ops.settings from public;
insert into app_ops.settings(key, value) values ('agents_paused', 'false');

create function app.set_agents_paused(p_paused boolean) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v boolean;
begin
  if p_paused is null then raise exception 'agents_paused must be true or false, not null' using errcode = '22004'; end if;
  insert into app_ops.settings(key, value, updated_at) values ('agents_paused', to_jsonb(p_paused), now())
  on conflict (key) do update set value = excluded.value, updated_at = excluded.updated_at
  returning (value = 'true'::jsonb) into v;
  return v;
end $$;

-- Fail closed: only an explicit JSON false means "not paused"; a missing row reads as paused.
create function app.agents_paused() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.value is distinct from 'false'::jsonb from app_ops.settings s where s.key = 'agents_paused'), true)
$$;

-- same signature and columns as 0003 (attempts is the fencing token the worker passes back to job_finish)
create or replace function app.job_claim(p_worker text, p_kinds text[], p_n int default 5)
returns table (id uuid, workspace_id uuid, kind text, payload jsonb, attempts int, max_attempts int)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_paused boolean := app.agents_paused();
begin
  -- crash-loop cap: the last attempt's worker died holding the lease, so do not run it again
  update app.jobs j set status = 'dead', last_error = 'lease expired at max attempts', finished_at = now(),
         locked_by = null, locked_until = null
  from (select j2.workspace_id, j2.id from app.jobs j2
        where j2.kind = any(p_kinds) and j2.status = 'running' and j2.locked_until < now() and j2.attempts >= j2.max_attempts
        for update skip locked) c
  where j.workspace_id = c.workspace_id and j.id = c.id;

  return query
  update app.jobs j set status = 'running', attempts = j.attempts + 1, locked_by = p_worker, locked_until = now() + interval '5 minutes'
  from (select j2.workspace_id, j2.id from app.jobs j2
        where j2.kind = any(p_kinds) and j2.run_after <= now()
          and (j2.status = 'ready' or (j2.status = 'running' and j2.locked_until < now() and j2.attempts < j2.max_attempts))
          and not (v_paused and j2.kind like 'agent.%')
        order by j2.run_after limit p_n for update skip locked) c
  where j.workspace_id = c.workspace_id and j.id = c.id
  returning j.id, j.workspace_id, j.kind, j.payload, j.attempts, j.max_attempts;
end $$;

-- the unfenced 0003 finish is removed so no caller can bypass the lease check
revoke all on function app.job_finish(uuid, boolean, jsonb, text) from app_jobs;
drop function app.job_finish(uuid, boolean, jsonb, text);

create function app.job_finish(p_id uuid, p_worker text, p_attempt int, p_ok boolean, p_result jsonb default null,
                               p_error text default null, p_retryable boolean default true) returns text
language plpgsql security definer set search_path = '' as $$
declare j app.jobs; v_delay double precision;
begin
  select * into j from app.jobs where id = p_id for update;
  if not found then return 'missing'; end if;
  -- NULL-safe: a NULL worker or attempt never matches (a plain <> against NULL would be NULL and skip the fence)
  if p_worker is null or p_attempt is null or j.status is distinct from 'running'
     or j.locked_by is distinct from p_worker or j.attempts is distinct from p_attempt then
    return 'stale';                                       -- lease lost (expired and reclaimed, or already finished): no change
  end if;
  if p_ok then
    update app.jobs set status = 'done', result = p_result, finished_at = now(), locked_by = null, locked_until = null where id = p_id;
    return 'done';
  elsif not p_retryable or j.attempts >= j.max_attempts then
    update app.jobs set status = 'dead', last_error = left(p_error, 2000), finished_at = now(), locked_by = null, locked_until = null where id = p_id;
    return 'dead';
  else
    v_delay := least(3600, 30 * power(2, greatest(j.attempts - 1, 0))) * (0.8 + 0.4 * random());
    update app.jobs set status = 'ready', last_error = left(p_error, 2000), locked_by = null, locked_until = null,
           run_after = now() + make_interval(secs => v_delay) where id = p_id;
    return 'retry';
  end if;
end $$;

revoke all on function app.job_finish(uuid, text, int, boolean, jsonb, text, boolean), app.set_agents_paused(boolean),
  app.agents_paused() from public;
grant execute on function app.job_finish(uuid, text, int, boolean, jsonb, text, boolean), app.set_agents_paused(boolean),
  app.agents_paused() to app_jobs;
