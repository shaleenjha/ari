-- Rollback for 0044 event labels (PENDING; written Oct 27 2026). Re-runnable.
-- Drops the event RPC, the checker, the vocabulary and app.events. app.events holds data once step 3 writes start:
-- this file REFUSES to drop a non-empty table unless the session sets  set ari.allow_drop_events = 'yes';  first
-- (take a verified backup before that; the events can be rebuilt by the backfill, the judged and Owner-corrected labels cannot).
-- The schema-usage grant to service_role on app is left in place (harmless, and other app objects may rely on it later).
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regclass('app.events') is not null and exists (select 1 from app.events)
     and coalesce(current_setting('ari.allow_drop_events', true), '') <> 'yes' then
    raise exception '0044 rollback: app.events has rows; set ari.allow_drop_events = ''yes'' after a verified backup';
  end if;
end $$;
drop function if exists public.ari_worker_event_record(text, text, text, uuid, text, timestamptz, boolean, text, text, jsonb, text, numeric, boolean, int);
drop table if exists app.events;
drop function if exists app.event_labels_check(text, jsonb);
drop function if exists app.event_label_vocab();
delete from supabase_migrations.schema_migrations where version = '0044';
commit;
