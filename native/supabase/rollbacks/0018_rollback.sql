-- Rollback for 0018_least_privilege_worker.sql. Run as postgres (Management API).
-- FIRST re-bind the sandbox proxy to the service_role key (vault e5ab6a5b, service "supabase-ari-bearer", Authorization: Bearer)
-- and revert scripts/ (git: work/v185/scripts_before/), otherwise the worker and sync lose access.
do $$ declare f text; begin
  foreach f in array array[
    'public.ari_worker_ping()', 'public.ari_worker_columns()', 'public.ari_worker_brief_next()',
    'public.ari_worker_brief_building(uuid)', 'public.ari_worker_brief_write(uuid, jsonb)', 'public.ari_worker_guidance(text)',
    'public.ari_worker_reply_state()', 'public.ari_worker_scan_last_set(bigint)',
    'public.ari_worker_reply_record(text, text, timestamptz, integer, text, text, text, text)',
    'public.ari_worker_reply_backfill(boolean)', 'public.ari_worker_replies_pending()',
    'public.ari_worker_reply_drafts(bigint, jsonb)', 'public.ari_worker_replies_open(integer)'] loop
    execute format('drop function if exists %s', f);
  end loop;
end $$;

create or replace function public.current_actor() returns text language sql stable as $$
  select coalesce(nullif(current_setting('ari.actor', true), ''),
                  case when auth.role() = 'service_role'
                       then nullif(left(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-ari-actor', 40), '') end,
                  case when auth.role() = 'authenticated' then 'app' else 'hark' end)
$$;
drop function if exists public.ari_jwt_role();

do $$ declare t text; begin
  foreach t in array array['people','accounts','queue','emails','brief','log_entries','book','plays','sync_state',
                           'scan_heartbeat','account_stage_history','sent_messages','replies'] loop
    execute format('drop policy if exists ari_worker_rw on public.%I', t);
  end loop;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ari_worker') then
    execute 'revoke all on all tables in schema public from ari_worker';
    execute 'revoke all on all functions in schema public from ari_worker';
    execute 'revoke usage on schema public from ari_worker';
    execute 'revoke ari_worker from authenticator';
    execute 'drop role ari_worker';
  end if;
end $$;
notify pgrst, 'reload schema';
