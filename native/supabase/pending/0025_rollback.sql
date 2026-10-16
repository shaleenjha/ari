drop policy if exists ari_worker_read_backups on storage.objects;
drop policy if exists ari_worker_see_backup_bucket on storage.buckets;
revoke select on storage.objects from ari_worker;
revoke select on storage.buckets from ari_worker;
revoke usage on schema storage from ari_worker;
delete from supabase_migrations.schema_migrations where version = '0025';
