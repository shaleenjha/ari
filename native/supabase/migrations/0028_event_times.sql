-- 0028 (v18.7.1 maintenance, Oct 17 2026): exact times for connect accept and DM1/DM2/DM3 sent.
-- people.connect_sent/accepted/dm1_sent/dm2_sent/dm3_sent were already timestamptz, but anything that arrived as a bare date
-- (Sheet edits, the worker's "accepted = today") was stored as noon IST with nothing saying it was a guess.
-- 1. people.ts_approx text[]: the fields whose time is only a date. Backfilled HERE (part of the migration, no one-off script):
--    every existing value at exactly 12:00:00 or 00:00:00 IST becomes noon IST and is flagged approximate.
-- 2. Trigger people_ts_approx keeps it right on every write: a bare date (exactly 00:00 or 12:00 IST) is set to noon IST and
--    flagged; any other time (app taps send the tap time; the worker now writes the email's time) clears the flag.
-- 3. report_accept_dm1(p_ae): accept -> DM1 in HOURS (median over exact pairs; all pairs shown separately), owner only;
--    ari_worker_accept_dm1() for scripts/phase0_metrics.py.
alter table public.people add column if not exists ts_approx text[] not null default '{}';
grant select (ts_approx) on public.people to ari_worker;

update public.people p set
  connect_sent = case when x.c then ((connect_sent at time zone 'Asia/Kolkata')::date + time '12:00') at time zone 'Asia/Kolkata' else connect_sent end,
  accepted = case when x.a then ((accepted at time zone 'Asia/Kolkata')::date + time '12:00') at time zone 'Asia/Kolkata' else accepted end,
  dm1_sent = case when x.d1 then ((dm1_sent at time zone 'Asia/Kolkata')::date + time '12:00') at time zone 'Asia/Kolkata' else dm1_sent end,
  dm2_sent = case when x.d2 then ((dm2_sent at time zone 'Asia/Kolkata')::date + time '12:00') at time zone 'Asia/Kolkata' else dm2_sent end,
  dm3_sent = case when x.d3 then ((dm3_sent at time zone 'Asia/Kolkata')::date + time '12:00') at time zone 'Asia/Kolkata' else dm3_sent end,
  ts_approx = array_remove(array[case when x.c then 'connect_sent' end, case when x.a then 'accepted' end,
    case when x.d1 then 'dm1_sent' end, case when x.d2 then 'dm2_sent' end, case when x.d3 then 'dm3_sent' end], null)
from (select id,
  coalesce((connect_sent at time zone 'Asia/Kolkata')::time in ('12:00','00:00'), false) c,
  coalesce((accepted at time zone 'Asia/Kolkata')::time in ('12:00','00:00'), false) a,
  coalesce((dm1_sent at time zone 'Asia/Kolkata')::time in ('12:00','00:00'), false) d1,
  coalesce((dm2_sent at time zone 'Asia/Kolkata')::time in ('12:00','00:00'), false) d2,
  coalesce((dm3_sent at time zone 'Asia/Kolkata')::time in ('12:00','00:00'), false) d3 from public.people) x
where x.id = p.id and (x.c or x.a or x.d1 or x.d2 or x.d3);

create or replace function public.people_ts_approx() returns trigger language plpgsql set search_path = public as $$
declare f text; v timestamptz; o timestamptz; j jsonb := to_jsonb(new); oj jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  approx text[] := coalesce(new.ts_approx, '{}');
begin
  foreach f in array array['connect_sent','accepted','dm1_sent','dm2_sent','dm3_sent'] loop
    v := (j ->> f)::timestamptz; o := (oj ->> f)::timestamptz;
    if tg_op = 'UPDATE' and v is not distinct from o then continue; end if;
    approx := array_remove(approx, f);
    if v is not null and (v at time zone 'Asia/Kolkata')::time in ('12:00', '00:00') then
      j := jsonb_set(j, array[f], to_jsonb(((v at time zone 'Asia/Kolkata')::date + time '12:00') at time zone 'Asia/Kolkata'));
      approx := approx || f;
    end if;
  end loop;
  j := jsonb_set(j, '{ts_approx}', to_jsonb(approx));
  new := jsonb_populate_record(new, j);
  return new;
end $$;
drop trigger if exists people_ts_approx on public.people;
create trigger people_ts_approx before insert or update of connect_sent, accepted, dm1_sent, dm2_sent, dm3_sent on public.people
  for each row execute function public.people_ts_approx();

create or replace function public.accept_dm1_stats(p_ae text default null) returns jsonb language sql stable
security definer set search_path = public as $$
  with x as (
    select extract(epoch from dm1_sent - accepted) / 3600.0 h,
           not (ts_approx && array['accepted','dm1_sent']) exact
    from people p
    where accepted is not null and dm1_sent is not null and dm1_sent >= accepted and deleted_at is null
      and coalesce(review, '') <> 'personal'
      and (p_ae is null or lower(split_part(btrim(p.owner), ' ', 1)) = lower(split_part(btrim(p_ae), ' ', 1)))
  )
  select jsonb_build_object(
    'exact_pairs', count(*) filter (where exact),
    'exact_median_h', round((percentile_cont(0.5) within group (order by h) filter (where exact))::numeric, 1),
    'all_pairs', count(*),
    'all_median_h', round((percentile_cont(0.5) within group (order by h))::numeric, 1),
    'under_4h', count(*) filter (where exact and h < 4),
    'waiting', (select count(*) from people w where w.accepted is not null and w.dm1_sent is null and w.deleted_at is null
                and coalesce(w.review, '') <> 'personal' and coalesce(w.stage, '') not in ('Hold', 'Withdrawn', 'Founder')
                and (p_ae is null or lower(split_part(btrim(w.owner), ' ', 1)) = lower(split_part(btrim(p_ae), ' ', 1)))))
  from x;
$$;
revoke all on function public.accept_dm1_stats(text) from public, anon, authenticated;
create or replace function public.report_accept_dm1(p_ae text default null) returns jsonb language plpgsql stable
security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  return public.accept_dm1_stats(p_ae);
end $$;
revoke all on function public.report_accept_dm1(text) from public, anon;
grant execute on function public.report_accept_dm1(text) to authenticated;
create or replace function public.ari_worker_accept_dm1() returns jsonb language sql stable security definer
set search_path = public as $$ select public.accept_dm1_stats(null); $$;
revoke all on function public.ari_worker_accept_dm1() from public, anon, authenticated;
grant execute on function public.ari_worker_accept_dm1() to ari_worker;
insert into supabase_migrations.schema_migrations(version, name) values ('0028', 'event_times') on conflict do nothing;
