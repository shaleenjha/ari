-- 0025 (v18.7, PENDING maintenance session): let ari_worker READ (never write/list other buckets) the nightly export
-- objects in private bucket ari-backups, so scripts/offsite_drive.py can copy the full backup (encrypted) to Google Drive.
-- Until applied, offsite_drive.py falls back to a worker-scope export (tables the worker can already SELECT).
-- Trade-off (named): the full export also holds auth.users / auth.identities rows (1 owner user) and function definitions,
-- which the worker cannot read today. Alternative if you prefer: skip 0025 and let ari-backup write an already-encrypted
-- copy to a separate bucket (needs an edge function change; see fixlog v18.7).
-- Apply on staging first (ari-staging), check with: python3 scripts/offsite_drive.py (source must say "ari-backups").
grant usage on schema storage to ari_worker;
grant select on storage.objects to ari_worker;
grant select on storage.buckets to ari_worker;
drop policy if exists ari_worker_read_backups on storage.objects;
create policy ari_worker_read_backups on storage.objects for select to ari_worker
  using (bucket_id = 'ari-backups' and name like 'ari\_%' escape '\');
drop policy if exists ari_worker_see_backup_bucket on storage.buckets;
create policy ari_worker_see_backup_bucket on storage.buckets for select to ari_worker using (id = 'ari-backups');
insert into supabase_migrations.schema_migrations(version, name) values ('0025', 'worker_read_backups') on conflict do nothing;
