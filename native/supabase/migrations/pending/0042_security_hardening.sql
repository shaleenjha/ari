-- 0042 Supabase security hardening (Oct 24 2026; spec plans/ari-app-status.md "Backlog: Supabase hardening", Owner yes 09:10 IST).
-- STAGING ONLY so far (ari-staging, applied Oct 24 2026). NOT on prod: prod waits for Owner's go. Rollback: 0042_security_hardening_rollback.sql.
-- Checks: test/checks_after_0042.sql (one transaction, synthetic rows, ends in a deliberate raise so nothing is kept).
--   1. Default lock. New objects that postgres creates in schemas public and app start closed to anon (and authenticated, as
--      0016 already set for public) until a migration grants them. Default privileges only act on objects created LATER: no
--      existing table, view, sequence or function changes its grants (checks compare an ACL fingerprint before and after).
--      On Oct 24 2026 both staging and prod already had this for postgres in public (0016 A) and PUBLIC execute revoked globally
--      (0016 A, last line), so this part re-asserts it and adds schema app. Per-schema default ACLs can only ADD to the global
--      default, and postgres' global default for tables/sequences is owner-only, so app was in effect closed already.
--      supabase_admin's defaults in public still grant anon everything; postgres is not a member of supabase_admin on hosted
--      Supabase, so it cannot change them. The block below tries and records a NOTICE if refused. Every object in public and app
--      is owned by postgres today (0 owned by anyone else), so supabase_admin's defaults only matter for objects the platform makes.
--   2. Row-drop alert. public.ops_row_counts keeps one count per IST day per key table (people, accounts, sent_messages,
--      notifications). public.ari_rowcount_snapshot() (SECURITY DEFINER, postgres + service_role only) counts, upserts today's
--      row, and if a table fell more than 10% against its latest earlier day (up to 7 days back, earlier count > 0) sends ONE
--      push per table per day: ari_notify('ops_alert', 'ops:rowdrop:<table>:<YYYY-MM-DD>', 'Ari needs a look', <generic line>,
--      '/ops', null, null). The lock-screen line names no table and no person. Until 0040 lands, the notifications_privacy
--      trigger rewrites ops_alert text to its generic 'Ari update / Open Ari to see what changed.' (seen on staging Oct 24). pg_cron 'ari-rowcount-daily' 02:30 UTC = 08:00 IST
--      (after the 03:00 IST backup, when Owner is awake). Today's counts are seeded at apply time (no earlier day, so no alert).
--      Note: tables with a handful of rows (staging, or a small sent_messages) fire on small changes (2 -> 1 is 50%).
-- Lock profile: default ACL changes touch pg_default_acl only (no table locks). The new table is new. Counting takes
-- ACCESS SHARE on the four tables (reads and writes keep flowing). Re-runnable: every step is if-not-exists / create or replace /
-- unschedule-then-schedule; the ledger row is written last, after the end state is checked.

-- Part 1: default lock -------------------------------------------------------------------------------------------------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
alter default privileges for role postgres revoke execute on functions from public;
do $$ begin
  if to_regnamespace('app') is not null then
    execute 'alter default privileges for role postgres in schema app revoke all on tables from anon, authenticated';
    execute 'alter default privileges for role postgres in schema app revoke all on sequences from anon, authenticated';
    execute 'alter default privileges for role postgres in schema app revoke all on functions from anon, authenticated';
  end if;
  begin
    execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from anon';
    raise notice '0042: supabase_admin default privileges in public now closed to anon';
  exception when insufficient_privilege then
    raise notice '0042: postgres may not change supabase_admin default privileges (not a member); left as the platform set them';
  end;
end $$;
commit;

-- Part 2: row-drop alert -----------------------------------------------------------------------------------------------
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regprocedure('public.ari_notify(text,text,text,text,text,text,uuid)') is null
     or to_regclass('public.people') is null or to_regclass('public.accounts') is null
     or to_regclass('public.sent_messages') is null or to_regclass('public.notifications') is null then
    raise exception '0042 needs ari_notify (0003/0026) and the four key tables';
  end if;
  if position('ops_alert' in coalesce((select pg_get_constraintdef(oid) from pg_constraint where conname = 'notifications_kind_check'), '')) = 0 then
    raise exception '0042 needs notifications kind ops_alert (0026) applied first';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception '0042 needs pg_cron';
  end if;
end $$;

create table if not exists public.ops_row_counts (
  day date not null,
  tbl text not null check (tbl in ('people', 'accounts', 'sent_messages', 'notifications')),
  n bigint not null check (n >= 0),
  counted_at timestamptz not null default now(),
  primary key (day, tbl)
);
comment on table public.ops_row_counts is '0042: one row count per IST day per key table, written by ari_rowcount_snapshot() (pg_cron ari-rowcount-daily). Platform-side, not tenant data.';
alter table public.ops_row_counts enable row level security;  -- no policies: closed to every API role; postgres (BYPASSRLS) writes it
revoke all on table public.ops_row_counts from public, anon, authenticated;
grant select on table public.ops_row_counts to service_role;

create or replace function public.ari_rowcount_snapshot() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  d date := (now() at time zone 'Asia/Kolkata')::date;
  t text; cur bigint; prev bigint; out jsonb := '{}'::jsonb; dropped text[] := '{}';
begin
  foreach t in array array['people', 'accounts', 'sent_messages', 'notifications'] loop
    execute format('select count(*) from public.%I', t) into cur;
    insert into public.ops_row_counts(day, tbl, n, counted_at) values (d, t, cur, now())
      on conflict (day, tbl) do update set n = excluded.n, counted_at = excluded.counted_at;
    select r.n into prev from public.ops_row_counts r
      where r.tbl = t and r.day < d and r.day >= d - 7 order by r.day desc limit 1;
    if prev is not null and prev > 0 and cur < prev * 0.9 then
      dropped := dropped || t;
      perform public.ari_notify('ops_alert', 'ops:rowdrop:' || t || ':' || to_char(d, 'YYYY-MM-DD'), 'Ari needs a look',
        'Some records dropped since yesterday. Open Ops to check.', '/ops', null, null);
    end if;
    out := out || jsonb_build_object(t, jsonb_build_object('n', cur, 'prev', prev));
  end loop;
  delete from public.ops_row_counts where day < d - 400;
  return jsonb_build_object('day', d, 'counts', out, 'dropped', to_jsonb(dropped));
end $$;
revoke all on function public.ari_rowcount_snapshot() from public, anon, authenticated;
grant execute on function public.ari_rowcount_snapshot() to service_role;

select cron.unschedule('ari-rowcount-daily') where exists (select 1 from cron.job where jobname = 'ari-rowcount-daily');
select cron.schedule('ari-rowcount-daily', '30 2 * * *', $c$select public.ari_rowcount_snapshot()$c$);  -- 08:00 IST
select public.ari_rowcount_snapshot();  -- seed today's counts
commit;

-- Ledger, last, only when the end state holds ---------------------------------------------------------------------------
begin;
do $$ begin
  if exists (select 1 from pg_default_acl a, aclexplode(a.defaclacl) x
             where a.defaclrole = 'postgres'::regrole and x.grantee in ('anon'::regrole, 'authenticated'::regrole)
               and (a.defaclnamespace = 0 or a.defaclnamespace in (select oid from pg_namespace where nspname in ('public', 'app')))) then
    raise exception '0042 end state: postgres default privileges still grant anon/authenticated';
  end if;
  if (select count(*) from cron.job where jobname = 'ari-rowcount-daily') <> 1 then raise exception '0042 end state: cron job'; end if;
  if (select count(*) from public.ops_row_counts where day = (now() at time zone 'Asia/Kolkata')::date) <> 4 then
    raise exception '0042 end state: seed counts'; end if;
  if has_function_privilege('anon', 'public.ari_rowcount_snapshot()', 'execute')
     or has_function_privilege('authenticated', 'public.ari_rowcount_snapshot()', 'execute')
     or has_table_privilege('anon', 'public.ops_row_counts', 'select')
     or has_table_privilege('authenticated', 'public.ops_row_counts', 'select') then
    raise exception '0042 end state: API roles can reach the new objects'; end if;
end $$;
insert into supabase_migrations.schema_migrations(version, name) values ('0042', 'security_hardening') on conflict do nothing;
commit;
