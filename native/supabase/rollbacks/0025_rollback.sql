-- rollback 0025_offsite_encrypted (objects in bucket ari-offsite are left; delete them in the dashboard if wanted)
drop policy if exists ari_worker_read_offsite on storage.objects;
drop policy if exists ari_worker_see_offsite_bucket on storage.buckets;
revoke select on storage.objects from ari_worker;
revoke select on storage.buckets from ari_worker;
revoke usage on schema storage from ari_worker;
create or replace function public.ari_worker_backup_status() returns jsonb language sql stable security definer
set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'started_at', started_at, 'finished_at', finished_at, 'file', file,
           'bytes', bytes, 'tables', tables, 'rows', rows, 'verified', verified, 'mismatches', mismatches,
           'offsite', offsite, 'offsite_error', offsite_error, 'error', error) order by id desc), '[]'::jsonb)
  from (select * from public.backup_runs order by id desc limit 3) r;
$$;
alter table public.backup_runs drop column if exists enc_file, drop column if exists enc_bytes, drop column if exists enc_sha256;
delete from supabase_migrations.schema_migrations where version = '0025';
