-- Rollback 0036: drop the two log repair functions.
drop function if exists public.ari_worker_log_repair(text, text, jsonb, jsonb);
drop function if exists public.ari_worker_log_unappend(text);
notify pgrst, 'reload schema';
