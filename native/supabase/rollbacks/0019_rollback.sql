-- Rollback for 0019_block_app_change_rows.sql
drop trigger if exists queue_block_app_change on public.queue;
drop function if exists public.queue_block_app_change();
