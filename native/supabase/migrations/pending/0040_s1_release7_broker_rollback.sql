-- Rollback of 0040 (S1 release 7 broker guardrails). Re-runnable. Run only AFTER the broker is undeployed or disabled
-- (ARI_BROKER_DISABLED=1), or its gate calls fail closed (the worker then cannot get new tokens; that is the intent).
-- Does not touch the worker Auth user (Auth admin API, runbook undo) or ari_worker's grants (0018).
begin;
set local lock_timeout = '5s';
do $$ begin
  if exists (select 1 from cron.job where jobname = 'ari-broker-mints-prune') then perform cron.unschedule('ari-broker-mints-prune'); end if;
end $$;
drop function if exists public.ari_worker_whoami();
-- restore 0031's notifications_privacy() exactly (0040 let 'ops_alert' through)
create or replace function public.notifications_privacy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('test', 'digest') or coalesce(new.dedupe_key, '') like 'digest:%' then return new; end if;
  if coalesce((public.ari_pref('push_show_names', 'false'::jsonb) #>> '{}')::boolean, false) then return new; end if;
  case new.kind
    when 'replied' then new.title := 'New reply on LinkedIn'; new.body := 'Someone you messaged wrote back. Open Ari to answer.';
    when 'accepted' then new.title := 'New connection accepted'; new.body := 'Their DM1 draft is ready in Ari.';
    when 'meeting' then new.title := 'Meeting set'; new.body := 'Open Ari to see the details.';
    when 'research_done' then
      if coalesce(new.dedupe_key, '') like 'rescan:%' then new.title := 'Re-scan done'; new.body := 'A fresh look at an account is waiting in Ari.';
      else new.title := 'Brief ready'; new.body := 'A new account brief is waiting in Ari.'; end if;
    when 'draft_due' then
      new.title := case when new.dedupe_key like 'draft:dm1:%' then 'DM1 ready'
                        when new.dedupe_key like 'draft:dm2:%' then 'DM2 drafted'
                        when new.dedupe_key like 'draft:dm3:%' then 'DM3 drafted'
                        else 'Draft ready' end;
      new.body := 'Ready for your review in Ari.';
    else new.title := 'Ari update'; new.body := 'Open Ari to see what changed.';
  end case;
  return new;
end $$;
revoke all on function public.notifications_privacy() from public, anon, authenticated;
drop function if exists public.ari_broker_note(text, text, text);
drop function if exists public.ari_broker_gate(text);
drop function if exists public.ari_broker_in_window(timestamptz, jsonb);
drop table if exists public.ari_broker_mints;
drop table if exists public.ari_broker_state;
delete from supabase_migrations.schema_migrations where version = '0040';
commit;
