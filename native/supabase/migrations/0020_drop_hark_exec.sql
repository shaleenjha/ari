-- 0020 (v18.5, Sat Oct 17 2026): the generic SQL-execution function is gone. Applied only after two consecutive scheduled
-- runs of the worker (e8fbd86f) and the sync (56e17ef1) succeeded as role ari_worker (0018).
-- hark_query / hark_time stay: read-only (transaction_read_only + 20 s timeout since Oct 16), service_role only, and no
-- Hark run holds service_role any more (the proxy injects the ari_worker JWT). Diagnostics use the Management API.
drop function if exists public.hark_exec(text);
-- rollback: native/supabase/rollbacks/0020_rollback.sql
