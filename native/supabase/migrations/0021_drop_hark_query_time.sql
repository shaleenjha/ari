-- 0021 (v18.6, Sat Oct 17 2026): the last two generic SQL functions go. hark_query (read-only, 20 s) and hark_time were
-- service_role-only diagnostics; since v18.5 no Hark run holds service_role, no script, page, edge function or cron job
-- calls them (grep of scripts/, web/, native/supabase/functions; cron.job; pg_proc bodies), and the PostgREST call
-- counter for hark_query stayed at 1376 across the 02:58 to 03:05 IST worker and sync runs. Diagnostics use the
-- Management API in a maintenance session.
drop function if exists public.hark_query(text);
drop function if exists public.hark_time(text, integer);
-- rollback: native/supabase/rollbacks/0021_rollback.sql
