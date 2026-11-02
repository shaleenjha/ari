-- 0027 (v18.7, PENDING maintenance session): Phase 0 measurement plumbing. No behaviour change for the app.
-- 1. app_usage: minutes in app per IST day, written by the app (v18.7 already captures it locally and calls usage_ping;
--    until this lands the call 404s and the app keeps the seconds in localStorage, then back-fills on the first success).
-- 2. ari_worker_metrics(): the five Phase 0 numbers' raw inputs for scripts/phase0_metrics.py (worker, read-only):
--    quick-check answered vs skip counts, copy_guidance before/after pairs (last 200) for edit distance, usage by day.
create table if not exists public.app_usage (
  day date primary key,
  seconds int not null default 0 check (seconds >= 0 and seconds <= 86400),
  opens int not null default 0 check (opens >= 0),
  updated_at timestamptz not null default now()
);
alter table public.app_usage enable row level security;
drop policy if exists owner_read on public.app_usage;
create policy owner_read on public.app_usage for select to authenticated using (public.is_owner());
revoke all on public.app_usage from public, anon, authenticated;
grant select on public.app_usage to authenticated;

-- p_seconds is the client's running total for that day (idempotent: greatest wins), p_opens likewise
create or replace function public.usage_ping(p_day date, p_seconds int, p_opens int default 0) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if p_day is null or p_day < current_date - 30 or p_day > current_date + 1 then raise exception 'bad day'; end if;
  insert into app_usage(day, seconds, opens) values (p_day, least(greatest(coalesce(p_seconds, 0), 0), 86400), greatest(coalesce(p_opens, 0), 0))
  on conflict (day) do update set seconds = greatest(app_usage.seconds, excluded.seconds),
                                  opens = greatest(app_usage.opens, excluded.opens), updated_at = now();
end $$;
revoke all on function public.usage_ping(date, int, int) from public, anon;
grant execute on function public.usage_ping(date, int, int) to authenticated;

create or replace function public.ari_worker_metrics() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'quick_check', (select jsonb_build_object('answered', count(*) filter (where check_via = 'answered'),
                                              'skip', count(*) filter (where check_via = 'skip'),
                                              'pending', count(*) filter (where check_via is null and jsonb_array_length(quick_check) > 0))
                    from account_briefs),
    'edits', (select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'ae', ae, 'before', before, 'after', after, 'at', created_at) order by created_at desc), '[]'::jsonb)
              from (select * from copy_guidance where kind in ('dm1','dm2','dm3') order by created_at desc limit 200) g),
    'usage', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'seconds', seconds, 'opens', opens) order by day desc), '[]'::jsonb)
              from app_usage where day > current_date - 28));
$$;
revoke all on function public.ari_worker_metrics() from public, anon, authenticated;
grant execute on function public.ari_worker_metrics() to ari_worker;
insert into supabase_migrations.schema_migrations(version, name) values ('0027', 'phase0_metrics') on conflict do nothing;
