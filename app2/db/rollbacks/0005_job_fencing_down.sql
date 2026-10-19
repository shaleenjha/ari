-- Rollback for app2 0005: restores the 0003 job_claim / job_finish and drops the kill switch.
-- Order: stop the worker, run this file, then start the old worker (worker.ts calling the 4-arg job_finish).
-- The new worker fails every finish once this runs (its 7-arg job_finish is gone).
-- This drops app_ops, so the agents_paused state is LOST and 0003's job_claim runs agent.* jobs again.
-- Check it first:  select value, updated_at from app_ops.settings where key = 'agents_paused';
-- If it is paused, do not roll back until the reason for the pause is resolved.
drop function app.job_finish(uuid, text, int, boolean, jsonb, text, boolean);
drop function app.set_agents_paused(boolean);
drop function app.agents_paused();
drop schema app_ops cascade;

create or replace function app.job_claim(p_worker text, p_kinds text[], p_n int default 5)
returns table (id uuid, workspace_id uuid, kind text, payload jsonb, attempts int, max_attempts int)
language sql security definer set search_path = '' as $$
  update app.jobs j set status = 'running', attempts = j.attempts + 1, locked_by = p_worker, locked_until = now() + interval '5 minutes'
  from (select j2.workspace_id, j2.id from app.jobs j2
        where j2.kind = any(p_kinds) and j2.run_after <= now()
          and (j2.status = 'ready' or (j2.status = 'running' and j2.locked_until < now()))
        order by j2.run_after limit p_n for update skip locked) c
  where j.workspace_id = c.workspace_id and j.id = c.id
  returning j.id, j.workspace_id, j.kind, j.payload, j.attempts, j.max_attempts
$$;

create function app.job_finish(p_id uuid, p_ok boolean, p_result jsonb default null, p_error text default null) returns text
language plpgsql security definer set search_path = '' as $$
declare j app.jobs;
begin
  select * into j from app.jobs where id = p_id for update;
  if not found then return 'missing'; end if;
  if p_ok then
    update app.jobs set status = 'done', result = p_result, finished_at = now(), locked_by = null, locked_until = null where id = p_id;
    return 'done';
  elsif j.attempts >= j.max_attempts then
    update app.jobs set status = 'dead', last_error = left(p_error, 2000), finished_at = now(), locked_by = null, locked_until = null where id = p_id;
    return 'dead';
  else
    update app.jobs set status = 'ready', last_error = left(p_error, 2000), locked_by = null, locked_until = null,
           run_after = now() + make_interval(secs => least(3600, 30 * power(2, greatest(j.attempts - 1, 0)))) where id = p_id;
    return 'retry';
  end if;
end $$;
revoke all on function app.job_finish(uuid, boolean, jsonb, text) from public;
grant execute on function app.job_finish(uuid, boolean, jsonb, text) to app_jobs;
