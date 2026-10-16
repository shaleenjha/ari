-- 0029 (Phase 1 groundwork, PENDING next maintenance window; staging first): data hygiene as an Ari capability (board #31).
-- Replaces the hand-done v18.7 clean (#26). Ari finds problems itself; it never fixes them on its own.
--   * Five checks as views (hygiene_v_*), all read-only, deterministic, no LLM:
--       accept_no_connect   accepted is set, connect_sent is empty
--       duplicate_account   two live accounts whose normalised name or domain match (e.g. "Ixterlane.ai" / "Ixterlane AI")
--       no_account_link     a live lead with no account_id (suggests the account whose normalised name matches)
--       stale_stage         person stage lags its own dates, or an account sits in an early stage > 30 days
--       dm1_past_due        accepted > 24 h ago, no DM1 sent, no reply/meeting/withdraw
--   * hygiene_findings: one row per (check, entity); the scan upserts open rows, closes rows whose problem is gone.
--   * ari_hygiene_scan()  : run by the worker (ari_worker) after each sync; writes findings only, never touches data.
--   * ari_worker_hygiene(): summary for the worker / health line.
--   * hygiene_open()      : owner read for the app card.
--   * hygiene_resolve()   : owner-only one-tap actions (dismiss, link, tick connect, merge). NOT granted to ari_worker:
--                           any merge or edit is a user action in the app, never automatic.
-- Backfill inside the migration: the 46 hand-set people.flags 'no_connect_tick' are removed; the first scan re-finds
-- them as accept_no_connect findings (rollback re-adds the flag with the same rule).

create table if not exists public.hygiene_findings (
  id uuid primary key default gen_random_uuid(),
  check_key text not null check (check_key in ('accept_no_connect','duplicate_account','no_account_link','stale_stage','dm1_past_due')),
  entity_type text not null check (entity_type in ('person','account')),
  entity_id text not null,
  detail jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open','dismissed','fixed','gone')),
  first_seen timestamptz not null default now(),
  last_seen timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by text,
  resolution jsonb,
  unique (check_key, entity_type, entity_id)
);
create index if not exists hygiene_findings_open_idx on public.hygiene_findings (status, check_key) where status = 'open';
alter table public.hygiene_findings enable row level security;
drop policy if exists owner_read on public.hygiene_findings;
create policy owner_read on public.hygiene_findings for select to authenticated using ((select public.is_owner()));
revoke all on public.hygiene_findings from public, anon, authenticated, ari_worker;
grant select on public.hygiene_findings to authenticated;

-- company name normaliser: lower, punctuation to space, drop legal / generic suffix tokens
create or replace function public.ari_company_norm(s text) returns text language sql immutable set search_path = public as $$
  select nullif(btrim(regexp_replace(
           regexp_replace(' ' || regexp_replace(lower(coalesce(s, '')), '[^a-z0-9]+', ' ', 'g') || ' ',
             '\s(inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|pvt|private|technologies|technology|tech|labs|lab|hq|ai|io|app|the|group|holdings|software|systems)(?=\s)', ' ', 'g'),
           '\s+', ' ', 'g')), '')
$$;
create or replace function public.ari_domain_norm(s text) returns text language sql immutable set search_path = public as $$
  select nullif(regexp_replace(regexp_replace(lower(btrim(coalesce(s, ''))), '^(https?://)?(www\.)?', ''), '/.*$', ''), '')
$$;

create or replace view public.hygiene_v_accept_no_connect with (security_invoker = true) as
  select p.id as person_id, p.name, p.company, p.account_id, p.accepted
  from public.people p
  where p.deleted_at is null and p.accepted is not null and p.connect_sent is null
    and coalesce(p.review, 'lead') <> 'personal';

create or replace view public.hygiene_v_duplicate_account with (security_invoker = true) as
  select a.id as account_id, b.id as dup_of, a.company, b.company as dup_company,
         case when public.ari_company_norm(a.company) = public.ari_company_norm(b.company) then 'name' else 'domain' end as matched_on,
         (select count(*) from public.people p where p.account_id = a.id and p.deleted_at is null) as people_a,
         (select count(*) from public.people p where p.account_id = b.id and p.deleted_at is null) as people_b
  from public.accounts a
  join public.accounts b on a.id < b.id and b.deleted_at is null
   and (public.ari_company_norm(a.company) = public.ari_company_norm(b.company)
        or (public.ari_domain_norm(a.domain) is not null and public.ari_domain_norm(a.domain) = public.ari_domain_norm(b.domain)))
  where a.deleted_at is null;

create or replace view public.hygiene_v_no_account_link with (security_invoker = true) as
  select p.id as person_id, p.name, p.company,
         (select a.id from public.accounts a where a.deleted_at is null
            and public.ari_company_norm(a.company) = public.ari_company_norm(p.company) order by a.created_at limit 1) as suggested_account_id,
         (select a.company from public.accounts a where a.deleted_at is null
            and public.ari_company_norm(a.company) = public.ari_company_norm(p.company) order by a.created_at limit 1) as suggested_company
  from public.people p
  where p.deleted_at is null and p.account_id is null and coalesce(p.review, 'lead') = 'lead';

-- person stage lags its own dates (furthest fact wins), or an account sits in Target/Researching/Mapped for > 30 days
create or replace view public.hygiene_v_stale_stage with (security_invoker = true) as
  with f as (
    select p.id, p.name, p.stage,
           case when p.meeting is not null then 'Meeting set' when p.replied is not null then 'Replied'
                when p.withdrawn is not null then 'Withdrawn'
                when p.dm3_sent is not null then 'DM3 sent' when p.dm2_sent is not null then 'DM2 sent'
                when p.dm1_sent is not null then 'DM1 sent' when p.accepted is not null then 'Accepted'
                when p.connect_sent is not null then 'Connect sent' end as implied
    from public.people p where p.deleted_at is null and coalesce(p.review, 'lead') = 'lead'),
  r as (select * from (values ('Connect queued',0),('Connect sent',1),('Accepted',2),('DM1 ready',2),('DM1 sent',3),('DM2 drafted',3),
                               ('DM2 sent',4),('DM3 drafted',4),('DM3 sent',5),('Withdrawn',5),('Replied',6),('Meeting set',7),('Meeting held',8)) v(stage, rk))
  select 'person'::text as entity_type, f.id as entity_id, f.name as label, f.stage, f.implied, null::int as days_in_stage
  from f join r ri on ri.stage = f.implied left join r rs on rs.stage = f.stage
  where f.implied is not null and coalesce(rs.rk, -1) < ri.rk
    and coalesce(f.stage, '') not in ('Hold', 'Personal', 'Closed lost')
  union all
  select 'account', a.id::text, a.company, a.stage, null, floor(extract(epoch from now() - a.stage_changed_at) / 86400)::int
  from public.accounts a
  where a.deleted_at is null and a.stage in ('Target', 'Researching', 'Mapped') and a.stage_override is false
    and a.stage_changed_at < now() - interval '30 days'
    and exists (select 1 from public.people p where p.account_id = a.id and p.deleted_at is null and p.connect_sent is not null);

create or replace view public.hygiene_v_dm1_past_due with (security_invoker = true) as
  select p.id as person_id, p.name, p.company, p.accepted, coalesce(p.dm, '') <> '' as has_draft,
         round((extract(epoch from now() - p.accepted) / 3600)::numeric, 1) as hours_waiting
  from public.people p
  where p.deleted_at is null and coalesce(p.review, 'lead') = 'lead'
    and p.accepted is not null and p.dm1_sent is null and p.replied is null and p.meeting is null and p.withdrawn is null
    and p.skipped is null and (p.snooze_until is null or p.snooze_until <= current_date)
    and p.accepted < now() - interval '24 hours';

revoke all on public.hygiene_v_accept_no_connect, public.hygiene_v_duplicate_account, public.hygiene_v_no_account_link,
              public.hygiene_v_stale_stage, public.hygiene_v_dm1_past_due from public, anon, authenticated, ari_worker;

-- The scan: worker-callable, writes findings only. Idempotent; dismissed rows stay dismissed while the problem persists.
create or replace function public.ari_hygiene_scan() returns jsonb
language plpgsql security definer set search_path = public as $$
declare t0 timestamptz := clock_timestamp(); res jsonb;
begin
  drop table if exists pg_temp._hf;
  create temp table _hf (check_key text, entity_type text, entity_id text, detail jsonb) on commit drop;
  insert into _hf select 'accept_no_connect', 'person', person_id, jsonb_build_object('name', name, 'company', company, 'accepted', accepted)
    from hygiene_v_accept_no_connect;
  insert into _hf select 'duplicate_account', 'account', account_id::text,
      jsonb_build_object('company', company, 'dup_of', dup_of, 'dup_company', dup_company, 'matched_on', matched_on, 'people_a', people_a, 'people_b', people_b)
    from hygiene_v_duplicate_account;
  insert into _hf select 'no_account_link', 'person', person_id,
      jsonb_build_object('name', name, 'company', company, 'suggested_account_id', suggested_account_id, 'suggested_company', suggested_company)
    from hygiene_v_no_account_link;
  insert into _hf select 'stale_stage', entity_type, entity_id,
      jsonb_build_object('label', label, 'stage', stage, 'implied', implied, 'days_in_stage', days_in_stage)
    from hygiene_v_stale_stage;
  insert into _hf select 'dm1_past_due', 'person', person_id,
      jsonb_build_object('name', name, 'company', company, 'accepted', accepted, 'has_draft', has_draft, 'hours_waiting', hours_waiting)
    from hygiene_v_dm1_past_due;

  insert into hygiene_findings as h (check_key, entity_type, entity_id, detail)
    select check_key, entity_type, entity_id, detail from _hf
  on conflict (check_key, entity_type, entity_id) do update
    set detail = excluded.detail, last_seen = now(),
        status = case when h.status in ('fixed', 'gone') then 'open' else h.status end,
        resolved_at = case when h.status in ('fixed', 'gone') then null else h.resolved_at end;
  update hygiene_findings h set status = 'gone', resolved_at = now(), resolved_by = 'ari-scan'
   where h.status = 'open'
     and not exists (select 1 from _hf where _hf.check_key = h.check_key and _hf.entity_type = h.entity_type and _hf.entity_id = h.entity_id);

  select jsonb_build_object('ok', true, 'ms', round(extract(epoch from clock_timestamp() - t0) * 1000),
           'open', (select coalesce(jsonb_object_agg(check_key, n), '{}'::jsonb)
                    from (select check_key, count(*) n from hygiene_findings where status = 'open' group by 1) x))
    into res;
  insert into app_config(key, value, updated_at) values ('hygiene_last_scan', now()::text, now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  return res;
end $$;
revoke all on function public.ari_hygiene_scan() from public, anon, authenticated;
grant execute on function public.ari_hygiene_scan() to ari_worker;

create or replace function public.ari_worker_hygiene() returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'last_scan', (select value from app_config where key = 'hygiene_last_scan'),
    'open', (select coalesce(jsonb_object_agg(check_key, n), '{}'::jsonb)
             from (select check_key, count(*) n from hygiene_findings where status = 'open' group by 1) x),
    'dismissed', (select count(*) from hygiene_findings where status = 'dismissed'),
    'fixed_7d', (select count(*) from hygiene_findings where status = 'fixed' and resolved_at > now() - interval '7 days'));
$$;
revoke all on function public.ari_worker_hygiene() from public, anon, authenticated;
grant execute on function public.ari_worker_hygiene() to ari_worker;

-- App read (owner only)
create or replace function public.hygiene_open() returns table (id uuid, check_key text, entity_type text, entity_id text, detail jsonb, first_seen timestamptz)
language sql stable security definer set search_path = public as $$
  select h.id, h.check_key, h.entity_type, h.entity_id, h.detail, h.first_seen
  from hygiene_findings h where public.is_owner() and h.status = 'open'
  order by case h.check_key when 'dm1_past_due' then 1 when 'duplicate_account' then 2 when 'no_account_link' then 3
                            when 'accept_no_connect' then 4 else 5 end, h.first_seen
$$;
revoke all on function public.hygiene_open() from public, anon;
grant execute on function public.hygiene_open() to authenticated;

-- One-tap actions, owner only. Every action records what it changed in resolution so it can be undone by hand.
--   dismiss                      any check
--   link        {account_id}     no_account_link: set people.account_id (+ company spelling of the account)
--   tick_connect                 accept_no_connect: connect_sent := accepted (flagged approximate by people_ts_approx)
--   merge       {keep}           duplicate_account: move people + research (+ brief if keep has none) to keep, soft-delete the other
create or replace function public.hygiene_resolve(p_id uuid, p_action text, p_args jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare h hygiene_findings; keep uuid; drop_id uuid; moved int := 0; undo jsonb := '{}'::jsonb;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  select * into h from hygiene_findings where id = p_id for update;
  if not found or h.status <> 'open' then return jsonb_build_object('ok', false, 'reason', 'not open'); end if;
  perform set_config('ari.actor', 'app-hygiene', true);
  if p_action = 'dismiss' then
    null;
  elsif p_action = 'link' and h.check_key = 'no_account_link' then
    keep := coalesce((p_args ->> 'account_id')::uuid, (h.detail ->> 'suggested_account_id')::uuid);
    if keep is null or not exists (select 1 from accounts where id = keep and deleted_at is null) then raise exception 'no account'; end if;
    select jsonb_build_object('account_id', account_id, 'company', company) into undo from people where id = h.entity_id;
    update people p set account_id = keep, company = a.company from accounts a where a.id = keep and p.id = h.entity_id;
  elsif p_action = 'tick_connect' and h.check_key = 'accept_no_connect' then
    update people set connect_sent = accepted where id = h.entity_id and connect_sent is null and accepted is not null;
    undo := jsonb_build_object('connect_sent', null);
  elsif p_action = 'merge' and h.check_key = 'duplicate_account' then
    keep := (p_args ->> 'keep')::uuid;
    if keep not in (h.entity_id::uuid, (h.detail ->> 'dup_of')::uuid) then raise exception 'keep must be one of the pair'; end if;
    drop_id := case when keep = h.entity_id::uuid then (h.detail ->> 'dup_of')::uuid else h.entity_id::uuid end;
    select jsonb_build_object('people', coalesce(jsonb_agg(id), '[]'::jsonb)) into undo from people where account_id = drop_id;
    update people set account_id = keep where account_id = drop_id;
    get diagnostics moved = row_count;
    update research set account_id = keep where account_id = drop_id;
    if not exists (select 1 from account_briefs where account_id = keep) then
      update account_briefs set account_id = keep where account_id = drop_id;
    end if;
    update accounts set deleted_at = now(), flags = array_append(flags, 'merged_into:' || keep::text) where id = drop_id;
    undo := undo || jsonb_build_object('dropped', drop_id, 'kept', keep);
  else
    raise exception 'action % not valid for %', p_action, h.check_key;
  end if;
  update hygiene_findings set status = case when p_action = 'dismiss' then 'dismissed' else 'fixed' end,
         resolved_at = now(), resolved_by = 'app', resolution = jsonb_build_object('action', p_action, 'args', p_args, 'undo', undo, 'moved', moved)
   where id = p_id;
  return jsonb_build_object('ok', true, 'action', p_action, 'moved', moved);
end $$;
revoke all on function public.hygiene_resolve(uuid, text, jsonb) from public, anon, ari_worker;
grant execute on function public.hygiene_resolve(uuid, text, jsonb) to authenticated;

-- Backfill: the hand-set flag is superseded by findings (rollback restores it by the same rule).
update public.people set flags = array_remove(flags, 'no_connect_tick') where 'no_connect_tick' = any(flags);

insert into supabase_migrations.schema_migrations(version, name) values ('0029', 'data_hygiene') on conflict do nothing;
