-- 0022 (v18.6, Sat Oct 17 2026): nightly backup runs inside Supabase (edge function ari-backup, pg_cron), so no Hark
-- run needs the Management API token for backups. Hark only reads the result through ari_worker_backup_status()
-- (metadata, no rows). Restore path: native/supabase/RESTORE.md.
create table if not exists public.backup_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  file text, bytes int, sha256 text, tables int, rows int, counts jsonb,
  verified boolean, mismatches jsonb, offsite boolean, offsite_error text, error text
);
alter table public.backup_runs enable row level security;   -- no policies: only postgres / service_role
revoke all on public.backup_runs from public, anon, authenticated;
revoke all on sequence public.backup_runs_id_seq from public, anon, authenticated;

do $$ begin
  if not exists (select 1 from vault.secrets where name = 'ari_backup_hook_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'ari_backup_hook_secret', 'x-ari-hook for edge function ari-backup');
  end if;
end $$;

insert into storage.buckets (id, name, public) values ('ari-backups', 'ari-backups', false) on conflict (id) do nothing;

create or replace function public.ari_backup_kick() returns bigint language sql security definer set search_path = public as $$
  select net.http_post(
    url := 'https://rbkrqlzlblquvgmuohro.supabase.co/functions/v1/ari-backup',  -- staging: its own ref (see fixlog)
    headers := jsonb_build_object('content-type', 'application/json',
                 'x-ari-hook', (select decrypted_secret from vault.decrypted_secrets where name = 'ari_backup_hook_secret')),
    body := '{"source":"cron"}'::jsonb, timeout_milliseconds := 10000);
$$;
revoke all on function public.ari_backup_kick() from public, anon, authenticated;

create or replace function public.ari_worker_backup_status() returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'started_at', started_at, 'finished_at', finished_at, 'file', file,
           'bytes', bytes, 'tables', tables, 'rows', rows, 'verified', verified, 'mismatches', mismatches,
           'offsite', offsite, 'offsite_error', offsite_error, 'error', error) order by id desc), '[]'::jsonb)
  from (select * from public.backup_runs order by id desc limit 3) r;
$$;
revoke all on function public.ari_worker_backup_status() from public, anon, authenticated;
grant execute on function public.ari_worker_backup_status() to ari_worker, service_role;

select cron.unschedule('ari-nightly-backup') where exists (select 1 from cron.job where jobname = 'ari-nightly-backup');
select cron.schedule('ari-nightly-backup', '30 21 * * *', 'select public.ari_backup_kick()');  -- 03:00 IST
-- rollback: native/supabase/rollbacks/0022_rollback.sql
