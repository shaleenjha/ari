-- Ari v17.5 (Oct 16, 2026): account stages, stage history with Undo, auto-advance from contact events.
-- Main ladder: Target > Researching > Mapped > Engaged > Meeting set > Meeting held > Opportunity created
-- Side states: Hold, Customer, Closed lost, Not a fit (Ari never moves into or out of them on its own after backfill).
-- Rules
--   * Ari only moves an account forward, and only from a fresh event (a person added / accepted / replied / meeting,
--     an account meeting_status change, a Map account request), so evidence Owner already overruled never re-applies.
--   * Any stage change that does not come from Ari's own mover (app picker, Sheet edit, direct SQL) is Owner's:
--     stage_source = 'shal', stage_override = true. Override accounts are skipped by the full reconcile, and a side
--     state set by Owner is never auto-moved.
--   * Every move writes account_stage_history (kind auto | manual | undo | backfill); ari_stage_undo() reverts one.

-- ---------- columns ----------
alter table public.accounts add column if not exists stage text not null default 'Target';
alter table public.accounts add column if not exists stage_changed_at timestamptz;
alter table public.accounts add column if not exists stage_source text;       -- 'ari' | 'shal'
alter table public.accounts add column if not exists stage_reason text;
alter table public.accounts add column if not exists stage_override boolean not null default false;

create or replace function public.ari_stage_norm(s text) returns text language sql immutable as $$
  select case lower(regexp_replace(btrim(coalesce(s, '')), '\s+', ' ', 'g'))
    when 'target' then 'Target' when 'researching' then 'Researching' when 'mapped' then 'Mapped'
    when 'engaged' then 'Engaged' when 'meeting set' then 'Meeting set' when 'meeting held' then 'Meeting held'
    when 'opportunity created' then 'Opportunity created' when 'opportunity' then 'Opportunity created' when 'opp' then 'Opportunity created'
    when 'hold' then 'Hold' when 'on hold' then 'Hold' when 'customer' then 'Customer'
    when 'closed lost' then 'Closed lost' when 'closed-lost' then 'Closed lost' when 'not a fit' then 'Not a fit'
    else null end
$$;
create or replace function public.ari_stage_rank(s text) returns int language sql immutable as $$
  select case s when 'Target' then 1 when 'Researching' then 2 when 'Mapped' then 3 when 'Engaged' then 4
    when 'Meeting set' then 5 when 'Meeting held' then 6 when 'Opportunity created' then 7 else 0 end
$$;

-- ---------- history ----------
create table if not exists public.account_stage_history (
  id bigserial primary key,
  account_id uuid not null references public.accounts(id) on delete cascade,
  company text,
  from_stage text,
  to_stage text not null,
  source text not null,              -- 'ari' | 'shal'
  kind text not null,                -- 'auto' | 'manual' | 'undo' | 'backfill'
  reason text,
  actor text,
  undo_of bigint,
  undone_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists ash_account on public.account_stage_history(account_id, created_at desc);
alter table public.account_stage_history enable row level security;
drop policy if exists owner_read on public.account_stage_history;
create policy owner_read on public.account_stage_history for select to authenticated using (public.is_owner());
revoke all on public.account_stage_history from anon;
revoke insert, update, delete, truncate on public.account_stage_history from authenticated;
grant select on public.account_stage_history to authenticated;
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'account_stage_history') then
    alter publication supabase_realtime add table public.account_stage_history;
  end if;
end $$;

-- ---------- the one mover ----------
-- source 'ari' (auto/backfill) or 'shal' (manual/undo). Returns the history id, or null when nothing changed.
create or replace function public.ari_account_move(p_account uuid, p_to text, p_source text, p_kind text,
                                                   p_reason text, p_undo_of bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare a record; hid bigint; t text := public.ari_stage_norm(p_to);
begin
  if t is null then raise exception 'unknown stage %', p_to; end if;
  select * into a from public.accounts where id = p_account for update;
  if not found then raise exception 'account not found: %', p_account; end if;
  if a.stage = t then return null; end if;
  perform set_config('ari.stage_internal', '1', true);
  update public.accounts set stage = t, stage_changed_at = now(), stage_source = p_source, stage_reason = p_reason,
         stage_override = case when p_source = 'shal' then true else stage_override end
   where id = p_account;
  perform set_config('ari.stage_internal', '', true);
  insert into public.account_stage_history(account_id, company, from_stage, to_stage, source, kind, reason, actor, undo_of)
  values (p_account, a.company, a.stage, t, p_source, p_kind, p_reason, public.current_actor(), p_undo_of)
  returning id into hid;
  return hid;
end $$;

-- direct edits (Sheet sync, PostgREST, apply_op set) are Owner's: normalise, stamp, log
create or replace function public.accounts_stage_guard() returns trigger language plpgsql security definer set search_path = public as $$
declare n text; act text := public.current_actor();
begin
  if tg_op = 'INSERT' then
    new.stage := coalesce(public.ari_stage_norm(new.stage), 'Target');
    new.stage_changed_at := coalesce(new.stage_changed_at, now());
    return new;
  end if;
  if new.stage is not distinct from old.stage or coalesce(current_setting('ari.stage_internal', true), '') = '1' then
    return new;
  end if;
  n := public.ari_stage_norm(new.stage);
  if n is null then new.stage := old.stage; return new; end if;   -- typo in the Sheet: keep the old stage
  new.stage := n;
  if n = old.stage then return new; end if;
  new.stage_changed_at := now();
  new.stage_source := 'shal';
  new.stage_override := true;
  new.stage_reason := case when act = 'sheet' then 'Changed in the Sheet' when act like 'app%' then 'Moved by you' else 'Changed by hand' end;
  insert into public.account_stage_history(account_id, company, from_stage, to_stage, source, kind, reason, actor)
  values (old.id, old.company, old.stage, n, 'shal', 'manual', new.stage_reason, act);
  return new;
end $$;
drop trigger if exists accounts_stage_guard on public.accounts;
create trigger accounts_stage_guard before insert or update of stage on public.accounts
  for each row execute function public.accounts_stage_guard();

-- ---------- auto-advance ----------
create or replace function public.ari_autoadvance(p_account uuid, p_to text, p_reason text)
returns bigint language plpgsql security definer set search_path = public as $$
declare cur text;
begin
  if p_account is null then return null; end if;
  select stage into cur from public.accounts where id = p_account and deleted_at is null;
  if cur is null then return null; end if;
  if public.ari_stage_rank(cur) = 0 then return null; end if;                 -- side state: never auto-move
  if public.ari_stage_rank(p_to) <= public.ari_stage_rank(cur) then return null; end if;  -- forward only
  return public.ari_account_move(p_account, p_to, 'ari', 'auto', p_reason);
end $$;

create or replace function public.ari_people_account(p_account uuid, p_company text) returns uuid language sql stable as $$
  select coalesce(p_account, (select id from public.accounts where lower(btrim(company)) = lower(btrim(p_company)) and deleted_at is null limit 1))
$$;

create or replace function public.ari_lead_count(p_account uuid) returns int language sql stable as $$
  select count(*)::int from public.people p
   where p.account_id = p_account and p.deleted_at is null and coalesce(p.review, 'lead') <> 'personal'
     and coalesce(p.stage, '') <> 'Withdrawn'
$$;

create or replace function public.people_stage_events() returns trigger language plpgsql security definer set search_path = public as $$
declare acc uuid; cand text; why text; n int; nm text := coalesce(nullif(split_part(btrim(coalesce(new.name, '')), ' ', 1), ''), 'Someone');
  eng text[] := array['Accepted','DM1 sent','DM2 sent','DM3 sent','Replied','Meeting','Meeting set'];
  newly_in_acc boolean;
begin
  if pg_trigger_depth() > 3 then return null; end if;
  if new.deleted_at is not null or coalesce(new.review, 'lead') = 'personal' then return null; end if;
  acc := public.ari_people_account(new.account_id, new.company);
  if acc is null then return null; end if;
  newly_in_acc := tg_op = 'INSERT' or old.account_id is distinct from new.account_id
               or lower(coalesce(old.company, '')) is distinct from lower(coalesce(new.company, ''))
               or (coalesce(old.review, 'lead') = 'personal');
  -- meeting
  if new.meeting is not null and (tg_op = 'INSERT' or old.meeting is null)
     or new.stage in ('Meeting','Meeting set') and (tg_op = 'INSERT' or old.stage is distinct from new.stage) then
    cand := 'Meeting set'; why := 'Meeting logged with ' || nm;
  elsif new.replied is not null and (tg_op = 'INSERT' or old.replied is null)
     or new.stage = 'Replied' and (tg_op = 'INSERT' or old.stage is distinct from 'Replied') then
    cand := 'Engaged'; why := nm || ' replied';
  elsif new.accepted is not null and (tg_op = 'INSERT' or old.accepted is null)
     or new.stage = any(eng) and (tg_op = 'INSERT' or not (coalesce(old.stage, '') = any(eng))) then
    cand := 'Engaged'; why := nm || ' accepted your invite';
  end if;
  if cand is not null then
    perform public.ari_autoadvance(acc, cand, why);
  end if;
  if newly_in_acc then
    n := public.ari_lead_count(acc);
    if n >= 4 and n - 1 < 4 then
      perform public.ari_autoadvance(acc, 'Mapped', n || ' people mapped');
    elsif n >= 1 then
      perform public.ari_autoadvance(acc, 'Researching', 'First people added');
    end if;
  end if;
  return null;
end $$;
drop trigger if exists people_stage_events on public.people;
create trigger people_stage_events after insert or update on public.people
  for each row execute function public.people_stage_events();

create or replace function public.accounts_meeting_events() returns trigger language plpgsql security definer set search_path = public as $$
declare m text := lower(coalesce(new.meeting_status, ''));
begin
  if pg_trigger_depth() > 3 then return null; end if;
  if lower(coalesce(old.meeting_status, '')) = m then return null; end if;
  if m ~ 'opp' then perform public.ari_autoadvance(new.id, 'Opportunity created', 'Opportunity logged');
  elsif m ~ 'held|done|happened' then perform public.ari_autoadvance(new.id, 'Meeting held', 'Meeting held');
  elsif m ~ '^(set|booked|scheduled)' then
    perform public.ari_autoadvance(new.id, 'Meeting set', 'Meeting logged' || coalesce(' with ' || nullif(new.meeting_person, ''), ''));
  end if;
  return null;
end $$;
drop trigger if exists accounts_meeting_events on public.accounts;
create trigger accounts_meeting_events after update of meeting_status on public.accounts
  for each row execute function public.accounts_meeting_events();

create or replace function public.queue_stage_events() returns trigger language plpgsql security definer set search_path = public as $$
declare acc uuid;
begin
  if new.action !~* '^map (account|more people)' then return null; end if;
  if coalesce(new.details, '') ~* 'QA test' then return null; end if;
  acc := public.ari_people_account(null, new.target);
  perform public.ari_autoadvance(acc, 'Researching', 'Ari is finding people');
  return null;
end $$;
drop trigger if exists queue_stage_events on public.queue;
create trigger queue_stage_events after insert on public.queue
  for each row execute function public.queue_stage_events();

-- ---------- implied stage from current data (backfill + safety reconcile) ----------
create or replace function public.ari_account_implied(p_account uuid, out stage text, out reason text)
language plpgsql stable security definer set search_path = public as $$
declare a record; n int; e int; mt int; mq int;
begin
  select * into a from public.accounts where id = p_account;
  n := public.ari_lead_count(p_account);
  select count(*) filter (where p.accepted is not null or p.replied is not null
                            or p.stage in ('Accepted','DM1 sent','DM2 sent','DM3 sent','Replied','Meeting','Meeting set')),
         count(*) filter (where p.meeting is not null or p.stage in ('Meeting','Meeting set'))
    into e, mt
    from public.people p where p.account_id = p_account and p.deleted_at is null and coalesce(p.review, 'lead') <> 'personal';
  select count(*) into mq from public.queue q
   where q.action ~* '^map (account|more people)' and lower(btrim(q.target)) = lower(btrim(a.company))
     and coalesce(q.status, '') !~* '^(done|blocked)';
  if lower(coalesce(a.meeting_status, '')) ~ 'opp' then stage := 'Opportunity created'; reason := 'Opportunity logged';
  elsif lower(coalesce(a.meeting_status, '')) ~ 'held|done|happened' then stage := 'Meeting held'; reason := 'Meeting held';
  elsif lower(coalesce(a.meeting_status, '')) ~ '^(set|booked|scheduled)' or mt > 0 then stage := 'Meeting set'; reason := 'Meeting logged';
  elsif e > 0 then stage := 'Engaged'; reason := e || case when e = 1 then ' person accepted or replied' else ' people accepted or replied' end;
  elsif n >= 4 then stage := 'Mapped'; reason := n || ' people mapped';
  elsif n >= 1 then stage := 'Researching'; reason := n || case when n = 1 then ' person so far' else ' people so far' end;
  elsif mq > 0 then stage := 'Researching'; reason := 'Ari is finding people';
  else stage := 'Target'; reason := 'No people yet';
  end if;
end $$;

-- forward-only catch-up for accounts Owner has not overridden; run by the sync every 10 minutes
create or replace function public.ari_account_stage_reconcile() returns int language plpgsql security definer set search_path = public as $$
declare a record; im record; k int := 0;
begin
  for a in select id, stage from public.accounts where deleted_at is null and not stage_override and public.ari_stage_rank(stage) > 0 loop
    select * into im from public.ari_account_implied(a.id);
    if public.ari_stage_rank(im.stage) > public.ari_stage_rank(a.stage) then
      perform public.ari_account_move(a.id, im.stage, 'ari', 'auto', im.reason); k := k + 1;
    end if;
  end loop;
  return k;
end $$;

-- one-time backfill (also flags: Hold status, Book flag customer / closed lost)
create or replace function public.ari_account_stage_backfill() returns jsonb language plpgsql security definer set search_path = public as $$
declare a record; im record; t text; why text; fl text; out jsonb := '{}'::jsonb;
begin
  for a in select * from public.accounts where deleted_at is null and not stage_override loop
    select string_agg(distinct b.flag, '; ') into fl from public.book b where lower(btrim(b.company)) = lower(btrim(a.company)) and coalesce(b.flag, '') <> '';
    if coalesce(a.status, '') ~* '^hold' then t := 'Hold'; why := a.status;
    elsif coalesce(fl, '') ~* 'customer' then t := 'Customer'; why := 'Flagged: ' || fl;
    elsif coalesce(fl, '') ~* 'closed' then t := 'Closed lost'; why := 'Flagged: ' || fl;
    elsif coalesce(fl, '') <> '' then t := 'Hold'; why := 'Flagged: ' || fl;
    else select * into im from public.ari_account_implied(a.id); t := im.stage; why := im.reason;
    end if;
    if a.stage <> t then
      perform public.ari_account_move(a.id, t, 'ari', 'backfill', why);
    else
      update public.accounts set stage_source = 'ari', stage_reason = why, stage_changed_at = coalesce(stage_changed_at, now())
       where id = a.id and stage_source is null;
    end if;
    out := out || jsonb_build_object(t, coalesce((out ->> t)::int, 0) + 1);
  end loop;
  return out;
end $$;

-- ---------- app RPCs ----------
create or replace function public.ari_set_account_stage(p_account text, p_stage text, p_op_id text default null, p_reason text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare acc uuid; hid bigint; prev jsonb; t text := public.ari_stage_norm(p_stage);
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  if t is null then raise exception 'unknown stage %', p_stage; end if;
  if p_op_id is not null then
    insert into public.ops(op_id, kind, target_table, target_id, payload, client_ts, device)
    values (p_op_id, 'stage', 'accounts', p_account, jsonb_build_object('stage', t), now(), null)
    on conflict (op_id) do nothing;
    if not found then
      select result into prev from public.ops where op_id = p_op_id;
      return coalesce(prev, '{}'::jsonb) || jsonb_build_object('duplicate', true);
    end if;
  end if;
  if p_account ~* '^[0-9a-f-]{36}$' then acc := p_account::uuid;
  else select id into acc from public.accounts where lower(btrim(company)) = lower(btrim(p_account)) and deleted_at is null; end if;
  if acc is null then raise exception 'account not found: %', p_account; end if;
  perform set_config('ari.actor', 'app', true);
  hid := public.ari_account_move(acc, t, 'shal', 'manual', coalesce(nullif(p_reason, ''), 'Moved by you'));
  prev := jsonb_build_object('ok', true, 'history_id', hid, 'account_id', acc, 'stage', t);
  if p_op_id is not null then update public.ops set result = prev, status = 'applied' where op_id = p_op_id; end if;
  return prev;
end $$;

create or replace function public.ari_stage_undo(p_history_id bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare h record; cur text; hid bigint;
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  select * into h from public.account_stage_history where id = p_history_id for update;
  if not found then raise exception 'history not found'; end if;
  if h.undone_at is not null then return jsonb_build_object('ok', true, 'already', true); end if;
  select stage into cur from public.accounts where id = h.account_id;
  if cur is distinct from h.to_stage then
    return jsonb_build_object('ok', false, 'moved_since', true, 'stage', cur);
  end if;
  perform set_config('ari.actor', 'app', true);
  hid := public.ari_account_move(h.account_id, coalesce(h.from_stage, 'Target'), 'shal', 'undo',
            case when h.source = 'ari' then 'You undid Ari''s move to ' || h.to_stage else 'Undo' end, h.id);
  update public.account_stage_history set undone_at = now() where id = h.id;
  return jsonb_build_object('ok', true, 'history_id', hid, 'stage', coalesce(h.from_stage, 'Target'));
end $$;

revoke all on function public.ari_set_account_stage(text, text, text, text) from public, anon;
grant execute on function public.ari_set_account_stage(text, text, text, text) to authenticated, service_role;
revoke all on function public.ari_stage_undo(bigint) from public, anon;
grant execute on function public.ari_stage_undo(bigint) to authenticated, service_role;
revoke all on function public.ari_account_move(uuid, text, text, text, text, bigint) from public, anon, authenticated;
revoke all on function public.ari_autoadvance(uuid, text, text) from public, anon, authenticated;
revoke all on function public.ari_account_stage_reconcile() from public, anon, authenticated;
revoke all on function public.ari_account_stage_backfill() from public, anon, authenticated;
grant execute on function public.ari_account_stage_reconcile() to service_role;
grant execute on function public.ari_account_stage_backfill() to service_role;
