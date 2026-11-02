-- Rollback for 0030_gmail_shadow. Stops both cron jobs, deletes the stored Gmail refresh token and the hook secret from Vault,
-- drops every 0030 table/function. Shadow events and diffs are discarded (they are derived; the worker's data is untouched).
-- Revoke the grant at Google too: myaccount.google.com/permissions -> Ari -> Remove access.
select cron.unschedule('ari-gmail-ingest') where exists (select 1 from cron.job where jobname = 'ari-gmail-ingest');
select cron.unschedule('ari-gmail-shadow-diff') where exists (select 1 from cron.job where jobname = 'ari-gmail-shadow-diff');
do $$ begin
  if to_regclass('public.gmail_connection') is not null then
    delete from vault.secrets where id in (select vault_secret_id from public.gmail_connection where vault_secret_id is not null);
  end if;
end $$;
delete from vault.secrets where name = 'ari_gmail_hook_secret' or name like 'ari_gmail_refresh_%';
drop function if exists public.ari_gmail_shadow_diff(date);
drop function if exists public.ari_gmail_ingest_kick();
drop function if exists public.ari_gmail_ingest_fail(text, boolean);
drop function if exists public.ari_gmail_ingest_record(jsonb, bigint, int, int);
drop function if exists public.ari_gmail_known_ids(text[]);
drop function if exists public.ari_gmail_ingest_config();
drop function if exists public.ari_gmail_connect(text, text);
drop function if exists public.ari_gmail_state_take(text);
drop function if exists public.ari_gmail_state_put(text, text);
drop function if exists public.ari_gmail_ticket_take(text);
drop function if exists public.ari_gmail_hook();
drop function if exists public.ari_gmail_disconnect();
drop function if exists public.ari_gmail_status();
drop function if exists public.ari_gmail_connect_ticket();
drop function if exists public.ari_gmail_match_person(text, text);
drop function if exists public.ari_li_vanity(text);
drop table if exists public.gmail_shadow_diffs, public.gmail_ingest_runs, public.gmail_shadow_events,
                     public.gmail_oauth_states, public.gmail_connect_tickets, public.gmail_connection;
delete from public.app_config where key = 'gmail_fn_base';
delete from supabase_migrations.schema_migrations where version = '0030';
