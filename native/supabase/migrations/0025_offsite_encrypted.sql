-- 0025 (v18.7.1 maintenance, Oct 17 2026): offsite copy WITHOUT giving the worker plaintext backups.
-- Safer alternative chosen over "worker reads ari-backups": the ari-backup edge function now writes a second copy that is
-- already encrypted (openssl-compatible CMS, AES-256-CBC, key wrapped by ECDH to the public cert
-- native/supabase/offsite/ari-offsite-recipient.pem) into private bucket ari-offsite. ari_worker may read ONLY that bucket,
-- ONLY *.cms objects, so it never sees auth.users / identities rows or any plaintext. scripts/offsite_drive.py copies the
-- newest .cms to Google Drive as-is and checks sha256 against backup_runs.enc_sha256.
insert into storage.buckets (id, name, public) values ('ari-offsite', 'ari-offsite', false) on conflict (id) do nothing;
alter table public.backup_runs add column if not exists enc_file text, add column if not exists enc_bytes int,
  add column if not exists enc_sha256 text;
grant usage on schema storage to ari_worker;
grant select on storage.objects to ari_worker;
grant select on storage.buckets to ari_worker;
drop policy if exists ari_worker_read_offsite on storage.objects;
create policy ari_worker_read_offsite on storage.objects for select to ari_worker
  using (bucket_id = 'ari-offsite' and name like 'ari\_%.cms' escape '\');
drop policy if exists ari_worker_see_offsite_bucket on storage.buckets;
create policy ari_worker_see_offsite_bucket on storage.buckets for select to ari_worker using (id = 'ari-offsite');
create or replace function public.ari_worker_backup_status() returns jsonb language sql stable security definer
set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'started_at', started_at, 'finished_at', finished_at, 'file', file,
           'bytes', bytes, 'tables', tables, 'rows', rows, 'verified', verified, 'mismatches', mismatches,
           'offsite', offsite, 'offsite_error', offsite_error, 'error', error,
           'enc_file', enc_file, 'enc_bytes', enc_bytes, 'enc_sha256', enc_sha256, 'counts', counts) order by id desc), '[]'::jsonb)
  from (select * from public.backup_runs order by id desc limit 3) r;
$$;
insert into supabase_migrations.schema_migrations(version, name) values ('0025', 'offsite_encrypted') on conflict do nothing;
