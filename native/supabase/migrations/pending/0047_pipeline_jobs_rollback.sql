-- Rollback for 0047 (pipeline job line). Re-runnable. Restores the 0041 / 0002 versions of the functions 0047 replaced.
-- Drafts, research rows and briefs already written stay (they are Owner's). Queue messages and job rows are dropped.
begin;
set local lock_timeout = '5s';
select cron.unschedule('ari-pipeline') where exists (select 1 from cron.job where jobname = 'ari-pipeline');
drop trigger if exists pipeline_accept on public.people;
drop function if exists public.people_pipeline_accept();
drop function if exists public.ari_pipeline_kick();
drop function if exists public.ari_pipeline_enqueue(text, text, text, boolean);
drop function if exists public.ari_pipeline_read(int, int);
drop function if exists public.ari_pipeline_start(bigint, bigint);                       -- pre-review-50 shape
drop function if exists public.ari_pipeline_finish(bigint, bigint, text, jsonb, text, text, text, text);
drop function if exists public.ari_pipeline_start(bigint, bigint, int);
drop function if exists public.ari_pipeline_finish(bigint, bigint, text, jsonb, text, text, text, text, int);
drop function if exists public.ari_pipeline_alert(bigint);
drop function if exists public.ari_pipeline_brief_context(text);
drop function if exists public.ari_pipeline_brief_write(uuid, jsonb);
drop function if exists public.ari_pipeline_save_checks(text, text, jsonb, boolean);
drop function if exists public.ari_pipeline_fact_get(text, text[]);
drop function if exists public.ari_pipeline_fact_put(text, text, text, jsonb);
drop table if exists public.pipeline_jobs;
drop table if exists public.fact_check_cache;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pgmq') and exists (select 1 from pgmq.list_queues() where queue_name = 'ari_pipeline') then
    perform pgmq.drop_queue('ari_pipeline'); end if;
end $$;
-- (the pgmq extension itself is left installed: harmless, and other work may use it)

-- outbox back to 0002 / 0041
drop index if exists public.notifications_one_per_draft;
drop trigger if exists a_draft_id on public.notifications;
drop function if exists public.notifications_draft_id();
alter table public.notifications drop column if exists draft_id;
create or replace function public.ari_notify(p_kind text, p_key text, p_title text, p_body text,
                                             p_url text, p_person text default null, p_account uuid default null)
returns void language sql security definer set search_path = public as $$
  insert into public.notifications(kind, dedupe_key, title, body, url, person_id, account_id)
  values (p_kind, p_key, p_title, p_body, coalesce(p_url, '/ops'), p_person, p_account)
  on conflict (dedupe_key) do nothing;
$$;
revoke all on function public.ari_notify(text, text, text, text, text, text, uuid) from public, anon, authenticated;
create or replace function public.ari_ai_notify_dm_ready(p_person text) returns void
language sql security definer set search_path = public as $$
  select ari_notify('draft_due', 'draft:dm1:ai:' || p_person, 'DM1 ready', 'Ready for your review in Ari.', '/ops', p_person,
    (select account_id from people where id = p_person)) $$;
create or replace function public.ari_ai_pending_events(p_limit int default 20) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'accepts', coalesce((select jsonb_agg(x) from (
      select e.msg_id, e.name, e.profile_url, e.event_at,
             public.ari_gmail_match_person(public.ari_li_vanity(e.profile_url), e.name) as match,
             coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'title', c.title, 'company', c.company,
                 'stage', c.stage, 'vanity', public.ari_li_vanity(c.linkedin_url)))
               from (select * from people c where c.deleted_at is null and coalesce(c.review, '') <> 'personal'
                       and ((e.profile_url is not null and public.ari_li_vanity(c.linkedin_url) = public.ari_li_vanity(e.profile_url))
                            or lower(btrim(c.name)) = lower(btrim(e.name))) limit 5) c), '[]'::jsonb) as candidates
        from gmail_shadow_events e
       where e.kind = 'accept' and e.event_at > now() - interval '3 days'
         and not exists (select 1 from ai_triggers t where t.kind = 'accept' and t.ref = e.msg_id and t.status <> 'error')
       order by e.event_at limit greatest(1, least(p_limit, 50))) x), '[]'::jsonb),
    'dm1_needed', coalesce((select jsonb_agg(p.id) from (
      select p.id from people p
       where p.deleted_at is null and p.accepted > now() - interval '3 days' and p.dm1_sent is null
         and coalesce(btrim(p.dm), '') = '' and coalesce(p.review, '') <> 'personal'
         and not exists (select 1 from ai_triggers t where t.kind = 'dm1' and t.ref = p.id and t.status <> 'error')
       order by p.accepted limit greatest(1, least(p_limit, 50))) p), '[]'::jsonb)) $$;
do $$ declare f text; begin
  foreach f in array array['ari_ai_pending_events(int)', 'ari_ai_notify_dm_ready(text)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop; end $$;
delete from supabase_migrations.schema_migrations where version = '0047';
commit;
notify pgrst, 'reload schema';
