-- LOCAL TEST ONLY. Minimal stand-ins for the Supabase platform objects the prod migrations touch (vault, storage, pg_net,
-- pg_cron, the migration ledger, the realtime publication). Never run this on staging or prod: those have the real ones.
-- Loaded after scripts/db_backup.py STUB (roles anon/authenticated/service_role, auth.uid()/jwt(), auth.users).
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, description text, secret text);
create or replace view vault.decrypted_secrets as select id, name, description, secret as decrypted_secret from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid
  language sql as $$ insert into vault.secrets(name, description, secret) values (new_name, new_description, new_secret) returning id $$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null) returns void
  language sql as $$ update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id $$;
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean default false);
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz default now());
alter table storage.objects enable row level security; alter table storage.buckets enable row level security;
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
  headers jsonb default '{}'::jsonb, timeout_milliseconds integer default 5000) returns bigint language sql as $$ select 0::bigint $$;
create table if not exists cron.job (jobid bigserial primary key, jobname text unique, schedule text, command text);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job(jobname, schedule, command) values (job_name, schedule, command)
  on conflict (jobname) do update set schedule = excluded.schedule, command = excluded.command returning jobid $$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $$ with d as (delete from cron.job where jobname = job_name returning 1) select exists (select 1 from d) $$;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, name text, statements text[]);
do $$ begin if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then create publication supabase_realtime; end if; end $$;
create table if not exists auth.mfa_factors (id uuid primary key default gen_random_uuid(), user_id uuid, status text);
-- as on Supabase: API roles may call auth.uid()/auth.jwt(); ari_worker has no usage on auth (0018)
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
