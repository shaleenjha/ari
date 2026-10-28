-- 0023 (v18.6, Sat Oct 17 2026): meeting-source attribution.
-- The app now requires a source when a meeting is marked set: LinkedIn (outbound), Email (outbound), Inbound, Other.
-- Writes from any path (app, Sheet sync, worker) are normalised to those four words; anything else is kept as typed
-- and reported as "No source yet" so it can be fixed from the Report. report_attribution() gives the Report its
-- sent / replied / meeting / by-source numbers for the same period and filters as report_summary().
create or replace function public.ari_meeting_source_norm(s text) returns text language sql immutable set search_path = public as $$
  select case
    when s is null or btrim(s) = '' then null
    when s ~* 'linked\s*in' then 'LinkedIn'
    when s ~* 'e-?mail' then 'Email'
    when s ~* '^\s*inbound' then 'Inbound'
    when s ~* '^\s*other' then 'Other'
    else null end
$$;

create or replace function public.accounts_meeting_source_norm() returns trigger language plpgsql set search_path = public as $$
begin
  if public.ari_meeting_source_norm(new.meeting_source) is not null then
    new.meeting_source := public.ari_meeting_source_norm(new.meeting_source);
  end if;
  return new;
end $$;
drop trigger if exists accounts_meeting_source_norm on public.accounts;
create trigger accounts_meeting_source_norm before insert or update of meeting_source on public.accounts
  for each row execute function public.accounts_meeting_source_norm();

create or replace function public.report_attribution(p_period text default 'this_week', p_from date default null, p_to date default null,
                                                     p_ae text default null, p_play text default null, p_stage text default null)
returns jsonb language sql stable set search_path = public as $$
  with rg as (select * from public.rpt_range(p_period, p_from, p_to)),
  ev as (select e.* from rg, public.rpt_filtered(rg.d_from, rg.d_to, p_ae, p_play, p_stage) e),
  mt as (
    select distinct on (e.account_key) e.account_key, coalesce(ra.account, e.account) account,
           public.ari_meeting_source_norm(a.meeting_source) src
    from ev e left join public.rpt_accounts ra on ra.account_key = e.account_key
              left join public.accounts a on a.id = ra.account_id
    where e.metric = 'meeting' order by e.account_key, e.ts)
  select jsonb_build_object(
    'range', (select jsonb_build_object('from', d_from, 'to', d_to, 'label', label) from rg),
    'connects', (select count(distinct ref) from ev where metric = 'connect'),
    'sent', (select count(distinct metric || ref) from ev where metric in ('dm1','dm2','dm3')),
    'replied', (select count(distinct ref) from ev where metric = 'reply'),
    'meetings', (select count(*) from mt),
    'by_source', jsonb_build_object(
      'LinkedIn', (select count(*) from mt where src = 'LinkedIn'),
      'Email', (select count(*) from mt where src = 'Email'),
      'Inbound', (select count(*) from mt where src = 'Inbound'),
      'Other', (select count(*) from mt where src = 'Other'),
      'none', (select count(*) from mt where src is null)),
    'no_source', coalesce((select jsonb_agg(account order by account) from mt where src is null), '[]'::jsonb))
$$;
revoke all on function public.report_attribution(text, date, date, text, text, text) from public, anon;
grant execute on function public.report_attribution(text, date, date, text, text, text) to authenticated, service_role, ari_worker;
revoke all on function public.ari_meeting_source_norm(text) from public, anon;
grant execute on function public.ari_meeting_source_norm(text) to authenticated, service_role, ari_worker;
revoke all on function public.accounts_meeting_source_norm() from public, anon, authenticated;
-- rollback: native/supabase/rollbacks/0023_rollback.sql
