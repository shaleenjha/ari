-- Ari v18.2 "War room" (Oct 16, 2026)
-- 1. account_briefs: one brief per account (thesis, why now, data-flow map, buying committee, angle, softer angles,
--    quick check, two email sequences). Hark (service role) writes the content; the app only reads it and writes the
--    quick check / review state through owner-only RPCs. A row with status 'queued' is the "Build brief" task.
-- 2. sent_messages: the exact text of every DM / reply Owner marked sent. A trigger on people snapshots dm / dm2_text /
--    dm3_text the moment dm1_sent / dm2_sent / dm3_sent is set (any path: app tick, Sheet, worker); undo removes the
--    tick snapshot. Edits after the fact go through ari_sent_edit (source 'edited'). Backfilled from current columns.
-- 3. copy_guidance: when Owner edits a draft in the app, the before/after pair is kept as AE-style guidance the
--    worker reads before drafting the next one for that AE / account.
-- 4. ari_activity(): one feed of what Ari is doing / just found (Today's war-room feed).

-- ---------- 1. account_briefs ----------
create table if not exists public.account_briefs (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  company text,
  status text not null default 'queued' check (status in ('queued','building','ready')),
  thesis text,
  why_now jsonb not null default '[]'::jsonb,      -- [{date, text, label: Verified|Inference|Hypothesis, url, kind: trigger|context}]
  data_flow jsonb not null default '[]'::jsonb,    -- [{step, where, data, vendor}]
  committee jsonb not null default '[]'::jsonb,    -- [{team, role, why, people:[{person_id, name, title, priority, objection}]}]
  angle text,
  soft_angles jsonb not null default '[]'::jsonb,  -- [{kind: role_pain|peer_move|hiring|product_change, text, url}] non-trigger angles
  quick_check jsonb not null default '[]'::jsonb,  -- [{id, kind: choice|ack, q, options[], answer, why}]
  check_answers jsonb,
  checked_at timestamptz,
  check_via text check (check_via is null or check_via in ('answered','skip')),
  sequences jsonb not null default '[]'::jsonb,    -- [{team, name, subject, pain, steps:[{code, day, kind, body}]}]
  doc_url text,
  reviewed_at timestamptz,                         -- account-level review card done (all drafts read)
  requested_at timestamptz not null default now(),
  built_at timestamptz,
  updated_at timestamptz not null default now(),
  updated_by text
);
create index if not exists account_briefs_status on public.account_briefs(status, requested_at desc);

create or replace function public.account_briefs_touch() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(nullif(current_setting('ari.actor', true), ''), case when auth.role() = 'authenticated' then 'app' else 'hark' end);
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then new.built_at := coalesce(new.built_at, now()); end if;
  if new.company is null then select a.company into new.company from public.accounts a where a.id = new.account_id; end if;
  return new;
end $$;
drop trigger if exists account_briefs_touch on public.account_briefs;
create trigger account_briefs_touch before insert or update on public.account_briefs for each row execute function public.account_briefs_touch();

alter table public.account_briefs enable row level security;
drop policy if exists owner_read on public.account_briefs;
create policy owner_read on public.account_briefs for select to authenticated using ((select public.is_owner()));
revoke all on public.account_briefs from anon;
revoke insert, update, delete, truncate on public.account_briefs from authenticated;
grant select on public.account_briefs to authenticated;

-- request a brief (idempotent): the "Build brief" task for the worker
create or replace function public.ari_brief_request(p_account_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.account_briefs;
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  perform set_config('ari.actor', 'app', true);
  insert into public.account_briefs(account_id, status) values (p_account_id, 'queued')
  on conflict (account_id) do nothing;
  select * into r from public.account_briefs where account_id = p_account_id;
  return to_jsonb(r);
end $$;

-- quick check done (answered) or explicitly skipped; p_reset clears it
create or replace function public.ari_brief_check(p_account_id uuid, p_answers jsonb default null, p_via text default 'answered', p_reset boolean default false) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.account_briefs;
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  if not p_reset and coalesce(p_via, '') not in ('answered','skip') then raise exception 'via must be answered or skip'; end if;
  perform set_config('ari.actor', 'app', true);
  update public.account_briefs set
    check_answers = case when p_reset then null else p_answers end,
    checked_at = case when p_reset then null else coalesce(checked_at, now()) end,
    check_via = case when p_reset then null else p_via end
  where account_id = p_account_id returning * into r;
  if r.account_id is null then raise exception 'no brief for this account'; end if;
  return to_jsonb(r);
end $$;

-- account-level review card: mark the account's drafts reviewed (or reopen)
create or replace function public.ari_brief_reviewed(p_account_id uuid, p_on boolean default true) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.account_briefs;
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  perform set_config('ari.actor', 'app', true);
  update public.account_briefs set reviewed_at = case when p_on then now() else null end
  where account_id = p_account_id returning * into r;
  if r.account_id is null then raise exception 'no brief for this account'; end if;
  return to_jsonb(r);
end $$;

-- ---------- 2. sent_messages ----------
create table if not exists public.sent_messages (
  id bigint generated always as identity primary key,
  person_id text not null references public.people(id) on delete cascade,
  account_id uuid,
  kind text not null check (kind in ('dm1','dm2','dm3','reply','note')),
  body text,
  sent_at timestamptz not null default now(),
  source text not null default 'tick' check (source in ('tick','edited','backfill')),
  original_body text,
  edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists sent_messages_one_dm on public.sent_messages(person_id, kind) where kind in ('dm1','dm2','dm3');
create index if not exists sent_messages_person on public.sent_messages(person_id, sent_at);

alter table public.sent_messages enable row level security;
drop policy if exists owner_read on public.sent_messages;
create policy owner_read on public.sent_messages for select to authenticated using ((select public.is_owner()));
revoke all on public.sent_messages from anon;
revoke insert, update, delete, truncate on public.sent_messages from authenticated;
grant select on public.sent_messages to authenticated;

create or replace function public.people_sent_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; ts_new timestamptz; ts_old timestamptz; b text;
begin
  foreach k in array array['dm1','dm2','dm3'] loop
    ts_new := case k when 'dm1' then new.dm1_sent when 'dm2' then new.dm2_sent else new.dm3_sent end;
    ts_old := case when tg_op = 'INSERT' then null else case k when 'dm1' then old.dm1_sent when 'dm2' then old.dm2_sent else old.dm3_sent end end;
    b := case k when 'dm1' then new.dm when 'dm2' then new.dm2_text else new.dm3_text end;
    if ts_new is not null and ts_old is null then
      insert into public.sent_messages(person_id, account_id, kind, body, sent_at, source)
      values (new.id, new.account_id, k, nullif(btrim(coalesce(b, '')), ''), ts_new, 'tick')
      on conflict (person_id, kind) where kind in ('dm1','dm2','dm3') do nothing;
    elsif ts_new is null and ts_old is not null then
      -- undo: the message did not go; keep a record Owner corrected by hand
      delete from public.sent_messages where person_id = new.id and kind = k and source in ('tick','backfill');
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists people_sent_snapshot on public.people;
create trigger people_sent_snapshot after insert or update of dm1_sent, dm2_sent, dm3_sent on public.people
  for each row execute function public.people_sent_snapshot();

-- log a message that has no tick column (a reply Owner sent), or a DM when the snapshot is missing
create or replace function public.ari_sent_log(p_person_id text, p_kind text, p_body text, p_sent_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.sent_messages; a uuid;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if coalesce(p_kind, '') not in ('dm1','dm2','dm3','reply','note') then raise exception 'bad kind'; end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null then raise exception 'empty message'; end if;
  select account_id into a from public.people where id = p_person_id;
  if not found then raise exception 'no such person'; end if;
  if p_kind in ('dm1','dm2','dm3') then
    insert into public.sent_messages(person_id, account_id, kind, body, sent_at, source)
    values (p_person_id, a, p_kind, left(p_body, 4000), coalesce(p_sent_at, now()), 'edited')
    on conflict (person_id, kind) where kind in ('dm1','dm2','dm3')
    do update set original_body = coalesce(public.sent_messages.original_body, public.sent_messages.body), body = excluded.body,
                  source = 'edited', edited_at = now(), updated_at = now()
    returning * into r;
  else
    insert into public.sent_messages(person_id, account_id, kind, body, sent_at, source)
    values (p_person_id, a, p_kind, left(p_body, 4000), coalesce(p_sent_at, now()), 'tick') returning * into r;
  end if;
  return to_jsonb(r);
end $$;

create or replace function public.ari_sent_edit(p_id bigint, p_body text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r public.sent_messages;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if nullif(btrim(coalesce(p_body, '')), '') is null then raise exception 'empty message'; end if;
  update public.sent_messages set original_body = coalesce(original_body, body), body = left(p_body, 4000),
    source = 'edited', edited_at = now(), updated_at = now()
  where id = p_id returning * into r;
  if r.id is null then raise exception 'no such message'; end if;
  return to_jsonb(r);
end $$;

create or replace function public.ari_sent_delete(p_id bigint) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  delete from public.sent_messages where id = p_id and kind in ('reply','note');
  return found;
end $$;

-- backfill: everyone already marked sent, labelled "draft at time of send" in the app
insert into public.sent_messages(person_id, account_id, kind, body, sent_at, source)
select p.id, p.account_id, x.k, nullif(btrim(coalesce(x.b, '')), ''), x.ts, 'backfill'
from public.people p
cross join lateral (values ('dm1', p.dm1_sent, p.dm), ('dm2', p.dm2_sent, p.dm2_text), ('dm3', p.dm3_sent, p.dm3_text)) x(k, ts, b)
where x.ts is not null and p.deleted_at is null
on conflict (person_id, kind) where kind in ('dm1','dm2','dm3') do nothing;

-- ---------- 3. copy_guidance ----------
create table if not exists public.copy_guidance (
  id bigint generated always as identity primary key,
  account_id uuid,
  company text,
  person_id text,
  ae text,
  kind text not null,             -- dm1 | dm2 | dm3 | sequence | brief
  before text,
  after text,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists copy_guidance_ae on public.copy_guidance(ae, created_at desc);
alter table public.copy_guidance enable row level security;
drop policy if exists owner_read on public.copy_guidance;
create policy owner_read on public.copy_guidance for select to authenticated using ((select public.is_owner()));
revoke all on public.copy_guidance from anon;
revoke insert, update, delete, truncate on public.copy_guidance from authenticated;
grant select on public.copy_guidance to authenticated;

create or replace function public.people_copy_guidance() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; o text; n text; sent timestamptz; ae text;
begin
  if coalesce(new.updated_by, '') not like 'app%' then return null; end if;
  select a.ae into ae from public.accounts a where a.id = new.account_id;
  foreach k in array array['dm1','dm2','dm3'] loop
    o := case k when 'dm1' then old.dm when 'dm2' then old.dm2_text else old.dm3_text end;
    n := case k when 'dm1' then new.dm when 'dm2' then new.dm2_text else new.dm3_text end;
    sent := case k when 'dm1' then old.dm1_sent when 'dm2' then old.dm2_sent else old.dm3_sent end;
    if sent is null and nullif(btrim(coalesce(o, '')), '') is not null and nullif(btrim(coalesce(n, '')), '') is not null and o is distinct from n then
      insert into public.copy_guidance(account_id, company, person_id, ae, kind, before, after, note)
      values (new.account_id, new.company, new.id, coalesce(ae, split_part(coalesce(new.owner, ''), ' ', 1)), k, o, n, 'Owner edited Ari''s draft in the app');
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists people_copy_guidance on public.people;
create trigger people_copy_guidance after update of dm, dm2_text, dm3_text on public.people
  for each row execute function public.people_copy_guidance();

-- ---------- 4. ari_activity: what Ari is doing and just found ----------
create or replace function public.ari_activity(p_limit int default 40) returns table(ts timestamptz, kind text, title text, detail text, account text, person_id text, ref text)
language sql stable security definer set search_path = public as $$
  select * from (
    select b.updated_at, case b.status when 'ready' then 'brief_ready' when 'building' then 'brief_building' else 'brief_queued' end,
           case b.status when 'ready' then 'Brief ready: ' || coalesce(b.company, '') when 'building' then 'Building the brief for ' || coalesce(b.company, '') else 'Brief queued for ' || coalesce(b.company, '') end,
           case when b.status = 'ready' then left(coalesce(b.thesis, ''), 160) else 'Thesis, why now, data flow, buying committee, quick check, two email tracks' end,
           b.company, null::text, b.account_id::text
    from public.account_briefs b where public.is_owner()
    union all
    select e.ts, e.metric,
           case e.metric when 'draft' then 'Drafted for ' || coalesce(e.person_name, 'a contact')
                         when 'signal' then 'Signal found at ' || coalesce(e.account, 'an account')
                         when 'account_added' then 'New account: ' || coalesce(e.account, '')
                         when 'person_added' then 'Found ' || coalesce(e.person_name, 'a contact') || coalesce(' at ' || e.account, '')
                         else e.metric end,
           coalesce(p.title, a.hook, ''), e.account, e.person_id, e.ref
    from public.rpt_events e
    left join public.people p on p.id = e.person_id
    left join public.accounts a on lower(a.company) = lower(e.account) and a.deleted_at is null
    where public.is_owner() and e.metric in ('draft','signal','account_added','person_added') and e.ts > now() - interval '7 days'
    union all
    select q.updated_at, 'queue_' || q.status,
           case when q.status = 'done' then 'Done: ' else 'Working: ' end || q.action || coalesce(' · ' || nullif(q.target, ''), ''),
           left(split_part(coalesce(q.result, q.details, ''), E'\n', 1), 180), null, null, q.id
    from public.queue q
    where public.is_owner() and q.updated_by is distinct from 'app' and q.updated_by not like 'app:%' and q.updated_at > now() - interval '3 days'
      and q.status in ('working','done') and q.action not in ('Brief Aide')
    union all
    select h.created_at, 'stage', 'Moved ' || coalesce(h.company, '') || ' to ' || h.to_stage, coalesce(h.reason, ''), h.company, null, h.id::text
    from public.account_stage_history h where public.is_owner() and h.kind = 'auto' and h.undone_at is null and h.created_at > now() - interval '7 days'
    union all
    select p.updated_at, 'researching', 'Researching ' || p.name, coalesce(p.title, '') || coalesce(' · ' || p.company, ''), p.company, p.id, p.id
    from public.people p where public.is_owner() and p.deleted_at is null and p.research in ('Researching','Researching now') and coalesce(p.review, 'lead') = 'lead'
    union all
    select t.ts, 'task', coalesce(k.title, 'Task') || ': ' || t.text, '', null, null, t.task_id::text
    from public.task_events t left join public.tasks k on k.id = t.task_id where public.is_owner() and t.ts > now() - interval '3 days'
  ) x(ts, kind, title, detail, account, person_id, ref)
  order by 1 desc nulls last
  limit greatest(1, least(coalesce(p_limit, 40), 120))
$$;
revoke all on function public.ari_activity(int) from anon;
grant execute on function public.ari_activity(int) to authenticated;
revoke all on function public.ari_brief_request(uuid) from anon;
revoke all on function public.ari_brief_check(uuid, jsonb, text, boolean) from anon;
revoke all on function public.ari_brief_reviewed(uuid, boolean) from anon;
revoke all on function public.ari_sent_log(text, text, text, timestamptz) from anon;
revoke all on function public.ari_sent_edit(bigint, text) from anon;
revoke all on function public.ari_sent_delete(bigint) from anon;
grant execute on function public.ari_brief_request(uuid), public.ari_brief_check(uuid, jsonb, text, boolean), public.ari_brief_reviewed(uuid, boolean),
  public.ari_sent_log(text, text, text, timestamptz), public.ari_sent_edit(bigint, text), public.ari_sent_delete(bigint) to authenticated;

-- realtime
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'account_briefs') then
    alter publication supabase_realtime add table public.account_briefs;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'sent_messages') then
    alter publication supabase_realtime add table public.sent_messages;
  end if;
end $$;

-- the Build brief queue: every account being worked (Researching / Mapped / Engaged) gets a queued brief
insert into public.account_briefs(account_id, status, requested_at)
select a.id, 'queued', coalesce(a.stage_changed_at, a.updated_at, now())
from public.accounts a
where a.deleted_at is null and a.stage in ('Researching','Mapped','Engaged')
on conflict (account_id) do nothing;
