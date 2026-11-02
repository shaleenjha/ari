-- app 0003: job queue functions for the worker (service side only; never granted to authenticated or anon).
do $$ begin if not exists (select 1 from pg_roles where rolname = 'app_jobs') then create role app_jobs nologin; end if; end $$;  -- worker role, no RLS bypass
grant usage on schema app to app_jobs;

create function app.job_enqueue(p_ws uuid, p_kind text, p_payload jsonb default '{}'::jsonb, p_key text default null,
                                p_run_after timestamptz default now()) returns uuid
language sql security definer set search_path = '' as $$
  insert into app.jobs(workspace_id, kind, payload, idempotency_key, run_after) values (p_ws, p_kind, p_payload, p_key, p_run_after)
  on conflict (workspace_id, kind, idempotency_key) do update set kind = excluded.kind   -- no-op, returns existing id
  returning id
$$;

-- claim up to n ready jobs of the given kinds; a lock expires after 5 minutes so a crashed worker's jobs come back
create function app.job_claim(p_worker text, p_kinds text[], p_n int default 5)
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

-- finish: done, or back to ready with exponential backoff (30 s * 2^(n-1), max 1 h), or dead after max_attempts
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

-- health for the uptime check: queue depth, oldest ready age, dead in 24 h
create function app.job_health() returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'ready', (select count(*) from app.jobs where status = 'ready' and run_after <= now()),
    'oldest_ready_s', (select coalesce(extract(epoch from now() - min(run_after))::int, 0) from app.jobs where status = 'ready' and run_after <= now()),
    'dead_24h', (select count(*) from app.jobs where status = 'dead' and finished_at > now() - interval '24 hours'))
$$;

revoke all on function app.job_enqueue(uuid, text, jsonb, text, timestamptz), app.job_claim(text, text[], int),
                       app.job_finish(uuid, boolean, jsonb, text), app.job_health() from public;
grant execute on function app.job_enqueue(uuid, text, jsonb, text, timestamptz), app.job_claim(text, text[], int),
                          app.job_finish(uuid, boolean, jsonb, text), app.job_health() to app_jobs;
