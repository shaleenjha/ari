--
-- PostgreSQL database dump
--


-- Dumped from database version 17.11
-- Dumped by pg_dump version 17.11 (Debian 17.11-0+deb13u1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: account_briefs_notify(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_briefs_notify() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare co text;
begin
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then
    co := coalesce(nullif(new.company, ''), (select a.company from public.accounts a where a.id = new.account_id), 'an account');
    insert into public.notifications(kind, dedupe_key, title, body, url, account_id)
    values ('research_done', 'brief:' || new.account_id || ':' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'),
            'Brief ready: ' || co,
            coalesce(left(nullif(new.thesis, ''), 140), 'Read it and do the quick check to unlock drafts.'),
            '/ops?open=account:' || new.account_id || ':brief', new.account_id)
    on conflict (dedupe_key) do nothing;
  end if;
  return null;
end $$;


--
-- Name: account_briefs_touch(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_briefs_touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(nullif(current_setting('ari.actor', true), ''), case when auth.role() = 'authenticated' then 'app' else 'hark' end);
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then new.built_at := coalesce(new.built_at, now()); end if;
  if new.company is null then select a.company into new.company from public.accounts a where a.id = new.account_id; end if;
  return new;
end $$;


--
-- Name: account_health(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.account_health(p_ae text DEFAULT NULL::text) RETURNS TABLE(account_key text, account text, account_id uuid, ae text, stage text, score integer, band text, pts_recency integer, pts_accepts integer, pts_replies integer, pts_stage integer, pts_coverage integer, people integer, accepted integer, replied integer, last_touch timestamp with time zone, days_quiet integer, gap text)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with ev as (
    select e.account_key, max(e.ts) as lt
    from public.rpt_filtered(date '2000-01-01', date '2100-01-01') e
    where e.metric in ('connect','accept','dm1','dm2','dm3','reply','meeting','opp','stage_manual','withdrawn')
    group by 1
  ), pp as (
    select r.account_key, count(*)::int as n, count(*) filter (where r.accepted is not null)::int as acc,
           count(*) filter (where r.replied is not null)::int as rep
    from public.rpt_people r group by 1
  ), rax as materialized (select * from public.rpt_accounts
  ), b as (
    select ra.account_key, ra.account, ra.account_id, ra.ae, ra.stage, coalesce(pp.n, 0) as n, coalesce(pp.acc, 0) as acc,
           coalesce(pp.rep, 0) as rep, ev.lt,
           case when ev.lt is null then null else floor(extract(epoch from now() - ev.lt) / 86400)::int end as dq
    from rax ra
    left join pp on pp.account_key = ra.account_key
    left join ev on ev.account_key = ra.account_key
    where ra.account_key <> '(no company)'
      and (p_ae is null or p_ae = '' or lower(ra.ae) = lower(split_part(btrim(p_ae), ' ', 1)))
  ), s as (
    select b.*,
           case when dq is null then 0 else greatest(0, round(30 * (1 - least(dq, 14) / 14.0)))::int end as r,
           round(least(acc, 3) * 20 / 3.0)::int as e,
           (least(rep, 2) * 10)::int as p,
           case b.stage when 'Researching' then 3 when 'Mapped' then 6 when 'Engaged' then 9 when 'Meeting set' then 12
                        when 'Meeting held' then 14 when 'Opportunity created' then 15 when 'Customer' then 15 else 0 end as g,
           (least(n, 5) * 3)::int as c
    from b
  )
  select s.account_key, s.account, s.account_id, s.ae, s.stage, (s.r + s.e + s.p + s.g + s.c)::int,
         case when s.stage in ('Hold', 'Closed lost', 'Not a fit') then 'Parked'
              when s.r + s.e + s.p + s.g + s.c >= 70 then 'Strong' when s.r + s.e + s.p + s.g + s.c >= 45 then 'Steady'
              when s.r + s.e + s.p + s.g + s.c >= 25 then 'Cooling' else 'Cold' end,
         s.r, s.e, s.p, s.g, s.c, s.n, s.acc, s.rep, s.lt, s.dq,
         case when s.stage in ('Hold', 'Closed lost', 'Not a fit') then 'On the side'
              when s.n = 0 then 'No people mapped yet'
              when s.dq is null then 'Nobody touched yet'
              when s.dq >= 7 then 'No touch in ' || s.dq || ' days'
              when s.n < 4 then 'Only ' || s.n || ' of 4 to 5 people mapped'
              when s.acc = 0 then 'No accepts yet'
              when s.rep = 0 then 'No replies yet'
              else 'On track' end
  from s
  order by 6 desc, 2
$$;


--
-- Name: accounts_meeting_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accounts_meeting_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: accounts_notify(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accounts_notify() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if coalesce(new.updated_by, '') like 'backfill%' then return null; end if;
  if coalesce(new.updated_by, '') not like 'app%' and lower(coalesce(new.meeting_status, '')) = 'set'
     and (tg_op = 'INSERT' or lower(coalesce(old.meeting_status, '')) <> 'set') then
    perform public.ari_notify('meeting', 'meeting:account:' || new.id || ':' || coalesce(new.meeting_date, ''),
      'Meeting set: ' || new.company,
      concat_ws(' · ', nullif(new.meeting_person, ''), nullif(new.meeting_date, ''), nullif(new.meeting_ae, '')),
      '/ops?open=account:' || new.id, null, new.id);
  end if;
  return null;
end $$;


--
-- Name: accounts_stage_guard(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accounts_stage_guard() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: accounts_worked(date, date, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accounts_worked(p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_ae text DEFAULT NULL::text, p_play text DEFAULT NULL::text) RETURNS TABLE(account text, account_key text, account_id uuid, ae text, play text, stage text, connect integer, accept integer, dm1 integer, dm2 integer, dm3 integer, reply integer, meeting integer, opp integer, stage_manual integer, people integer, people_names text[], last_touch timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select ra.account, e.account_key, ra.account_id, max(e.ae), max(e.play), coalesce(ra.stage, 'Target'),
         count(distinct e.ref) filter (where e.metric = 'connect')::int, count(distinct e.ref) filter (where e.metric = 'accept')::int,
         count(distinct e.ref) filter (where e.metric = 'dm1')::int, count(distinct e.ref) filter (where e.metric = 'dm2')::int,
         count(distinct e.ref) filter (where e.metric = 'dm3')::int, count(distinct e.ref) filter (where e.metric = 'reply')::int,
         count(distinct e.ref) filter (where e.metric = 'meeting')::int, count(distinct e.ref) filter (where e.metric = 'opp')::int,
         count(distinct e.ref) filter (where e.metric = 'stage_manual')::int,
         count(distinct e.person_id)::int, array_agg(distinct e.person_name) filter (where e.person_name is not null), max(e.ts)
  from public.rpt_filtered(coalesce(p_from, public.rpt_today()), coalesce(p_to, p_from, public.rpt_today()), p_ae, p_play) e
  left join public.rpt_accounts ra on ra.account_key = e.account_key
  where e.metric in ('connect','accept','dm1','dm2','dm3','reply','meeting','opp','stage_manual','withdrawn')
  group by ra.account, e.account_key, ra.account_id, ra.stage
  order by max(e.ts) desc
$$;


--
-- Name: apply_op(text, text, text, text, jsonb, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.apply_op(p_op_id text, p_kind text, p_table text, p_id text, p_patch jsonb DEFAULT '{}'::jsonb, p_client_ts timestamp with time zone DEFAULT now(), p_device text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare
  prev jsonb; res jsonb; rowj jsonb; k text; applied text[] := '{}'; stale text[] := '{}';
  keycol text; rid text; cur jsonb; filt jsonb := '{}'::jsonb; ts jsonb := '{}'::jsonb; sets text := '';
  f text; today date := (now() at time zone 'Asia/Kolkata')::date; tsv timestamptz := coalesce(p_client_ts, now());
  stage_by jsonb := '{"connect_sent":"Connect sent","accepted":"Accepted","dm1_sent":"DM1 sent","dm2_sent":"DM2 sent","dm3_sent":"DM3 sent","replied":"Replied","meeting":"Meeting","withdrawn":"Withdrawn"}';
  p record; actor text := 'app' || coalesce(':' || p_device, '');
  allowed text[];
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  insert into public.ops(op_id, kind, target_table, target_id, payload, client_ts, device)
  values (p_op_id, p_kind, p_table, p_id, coalesce(p_patch, '{}'), p_client_ts, p_device)
  on conflict (op_id) do nothing;
  if not found then
    select result into prev from public.ops where op_id = p_op_id;
    return coalesce(prev, '{}'::jsonb) || jsonb_build_object('duplicate', true);
  end if;
  perform set_config('ari.actor', actor, true);

  if p_kind in ('mark','undo') then
    if p_table <> 'people' then raise exception 'mark/undo only on people'; end if;
    f := p_patch ->> 'field';
    if not stage_by ? f then raise exception 'bad field %', f; end if;
    select * into p from public.people where id = p_id for update;
    if not found then raise exception 'person not found: %', p_id; end if;
    if p_kind = 'mark' then
      if to_jsonb(p) ->> f is not null then
        res := jsonb_build_object('ok', true, 'already', true);
      else
        execute format('update public.people set %I = $1, stage = $2 where id = $3', f) using tsv, stage_by ->> f, p_id;
        if f = 'accepted' then
          update public.people set next_action = 'DM1 on ' || to_char(today, 'YYYY-MM-DD') where id = p_id;
        elsif f = 'dm1_sent' then
          update public.people set dm2_due = today + 4, dm3_due = today + 7,
                 next_action = 'DM2 on ' || to_char(today + 4, 'YYYY-MM-DD') where id = p_id;
        elsif f = 'dm2_sent' then
          update public.people set next_action = 'DM3 on ' || to_char(coalesce(p.dm3_due, today + 3), 'YYYY-MM-DD') where id = p_id;
        elsif f = 'dm3_sent' then
          update public.people set next_action = 'Sequence done. Park or try another angle.' where id = p_id;
        elsif f = 'replied' then
          update public.people set next_action = 'Hark drafting your answer' where id = p_id;
          insert into public.queue(action, target, details, updated_by)
          values ('Draft reply', p_id, p.name || ' (' || coalesce(p.company,'') || ') replied on LinkedIn. Paste their reply in the Hark chat for a sharper draft.', actor);
        elsif f = 'meeting' then
          update public.people set next_action = 'Log meeting in SFDC' where id = p_id;
        elsif f = 'withdrawn' then
          update public.people set next_action = '' where id = p_id;
        end if;
        insert into public.log_entries(ts, person_id, event, detail, source)
        values (tsv, p_id, stage_by ->> f, p.name || ' · ' || coalesce(p.company,''), 'app');
        res := jsonb_build_object('ok', true, 'applied', jsonb_build_array(f));
      end if;
    else
      execute format('update public.people set %I = null where id = $1', f) using p_id;
      update public.people x set stage = coalesce(
        case when x.meeting is not null then 'Meeting' when x.replied is not null then 'Replied'
             when x.dm3_sent is not null then 'DM3 sent' when x.dm2_sent is not null then 'DM2 sent'
             when x.dm1_sent is not null then 'DM1 sent' when x.accepted is not null then 'Accepted'
             when x.connect_sent is not null then 'Connect sent' end, 'Connect queued')
      where id = p_id;
      -- v17.1: the next step follows the restored stage, and an undone reply cancels its queued Draft reply
      update public.people x set next_action = case x.stage
          when 'Meeting' then 'Log meeting in SFDC'
          when 'Replied' then 'Hark drafting your answer'
          when 'DM3 sent' then 'Sequence done. Park or try another angle.'
          when 'DM2 sent' then 'DM3 on ' || to_char(coalesce(x.dm3_due, today + 3), 'YYYY-MM-DD')
          when 'DM1 sent' then 'DM2 on ' || to_char(coalesce(x.dm2_due, today + 4), 'YYYY-MM-DD')
          when 'Accepted' then 'Send DM1'
          when 'Connect sent' then 'Waiting on accept'
          else 'Send connect' end
       where id = p_id;
      if f = 'replied' then
        update public.queue set status = 'cancelled', result = 'Cancelled: the reply mark was undone in Ari.', updated_by = actor
         where target = p_id and action = 'Draft reply' and status = 'queued';
      end if;
      insert into public.log_entries(ts, person_id, event, detail, source) values (tsv, p_id, 'Undo ' || f, p.name, 'app');
      res := jsonb_build_object('ok', true, 'applied', jsonb_build_array(f));
    end if;
    select to_jsonb(x) into rowj from public.people x where id = p_id;

  elsif p_kind = 'insert' then
    if p_table not in ('queue','people','log_entries') then raise exception 'insert not allowed on %', p_table; end if;
    filt := jsonb_strip_nulls(p_patch || case when p_table = 'log_entries' then '{}'::jsonb
                                              else jsonb_build_object('updated_by', actor) end);
    select string_agg(format('%I', key), ', ') into sets from jsonb_object_keys(filt) key;
    execute format('insert into public.%I (%s) select %s from jsonb_populate_record(null::public.%I, $1) returning to_jsonb(%I.*)',
                   p_table, sets, sets, p_table, p_table) using filt into rowj;
    res := jsonb_build_object('ok', true, 'applied', '["insert"]'::jsonb);

  elsif p_kind = 'set' then
    if p_table not in ('people','accounts','queue','brief') then raise exception 'set not allowed on %', p_table; end if;
    keycol := case p_table when 'brief' then 'key' else 'id' end;
    rid := p_id;
    if p_table = 'accounts' and rid !~* '^[0-9a-f-]{36}$' then
      select id::text into rid from public.accounts where lower(btrim(company)) = lower(btrim(p_id));
      if rid is null then  -- like Apps Script setAccount: create the account row
        insert into public.accounts(company, updated_by) values (btrim(p_id), actor) returning id::text into rid;
      end if;
    end if;
    if p_table = 'brief' then
      insert into public.brief(key, updated_by) values (rid, actor) on conflict (key) do nothing;
    end if;
    execute format('select to_jsonb(t) from public.%I t where %I::text = $1 for update', p_table, keycol) into cur using rid;
    if cur is null then raise exception '% not found: %', p_table, p_id; end if;
    for k in select jsonb_object_keys(p_patch) loop
      if k in ('id','key','created_at','updated_at','updated_by','field_ts','sheet_row','ae') or not (cur ? k) then
        raise exception 'field not editable: %', k;
      end if;
      if (cur -> 'field_ts' ->> k) is not null and (cur -> 'field_ts' ->> k)::timestamptz > tsv then
        stale := stale || k;
      else
        applied := applied || k;
        filt := filt || jsonb_build_object(k, p_patch -> k);
        ts := ts || jsonb_build_object(k, tsv);
        sets := sets || format('%I = r.%I, ', k, k);
      end if;
    end loop;
    if array_length(applied, 1) > 0 then
      execute format('update public.%I t set %s field_ts = t.field_ts || $2, updated_by = $3 from jsonb_populate_record(null::public.%I, $1) r where t.%I::text = $4 returning to_jsonb(t.*)',
                     p_table, sets, p_table, keycol)
        using filt, ts, actor, rid into rowj;
      if p_table = 'accounts' and filt ->> 'meeting_status' = 'set' then
        insert into public.log_entries(ts, person_id, event, detail, source)
        values (tsv, null, 'Meeting set', concat_ws(' · ', rowj ->> 'company', rowj ->> 'meeting_source', rowj ->> 'meeting_person', rowj ->> 'meeting_date'), 'app');
      elsif p_table = 'people' then
        insert into public.log_entries(ts, person_id, event, detail, source)
        values (tsv, rid, 'Ari edit ' || array_to_string(applied, ','), concat_ws(' / ', rowj ->> 'name', rowj ->> 'company'), 'app');
      end if;
    else
      rowj := cur;
    end if;
    res := jsonb_build_object('ok', true, 'applied', to_jsonb(applied), 'stale', to_jsonb(stale));
  else
    raise exception 'unknown op kind %', p_kind;
  end if;

  res := res || jsonb_build_object('row', rowj, 'duplicate', false);
  update public.ops set result = res - 'row',
         status = case when cardinality(stale) > 0 and cardinality(applied) = 0 then 'stale'
                       when cardinality(stale) > 0 then 'partial' else 'applied' end
   where op_id = p_op_id;
  return res;
end $_$;


--
-- Name: ari_account_implied(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_account_implied(p_account uuid, OUT stage text, OUT reason text) RETURNS record
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: ari_account_move(uuid, text, text, text, text, bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_account_move(p_account uuid, p_to text, p_source text, p_kind text, p_reason text, p_undo_of bigint DEFAULT NULL::bigint) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: ari_account_stage_backfill(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_account_stage_backfill() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: ari_account_stage_reconcile(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_account_stage_reconcile() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: ari_activity(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_activity(p_limit integer DEFAULT 40) RETURNS TABLE(ts timestamp with time zone, kind text, title text, detail text, account text, person_id text, ref text)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: ari_autoadvance(uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_autoadvance(p_account uuid, p_to text, p_reason text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare cur text;
begin
  if p_account is null then return null; end if;
  select stage into cur from public.accounts where id = p_account and deleted_at is null;
  if cur is null then return null; end if;
  if public.ari_stage_rank(cur) = 0 then return null; end if;                 -- side state: never auto-move
  if public.ari_stage_rank(p_to) <= public.ari_stage_rank(cur) then return null; end if;  -- forward only
  return public.ari_account_move(p_account, p_to, 'ari', 'auto', p_reason);
end $$;


--
-- Name: ari_brief_check(uuid, jsonb, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_brief_check(p_account_id uuid, p_answers jsonb DEFAULT NULL::jsonb, p_via text DEFAULT 'answered'::text, p_reset boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: ari_brief_request(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_brief_request(p_account_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r public.account_briefs;
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  perform set_config('ari.actor', 'app', true);
  insert into public.account_briefs(account_id, status) values (p_account_id, 'queued')
  on conflict (account_id) do nothing;
  select * into r from public.account_briefs where account_id = p_account_id;
  return to_jsonb(r);
end $$;


--
-- Name: ari_brief_reviewed(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_brief_reviewed(p_account_id uuid, p_on boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r public.account_briefs;
begin
  if not (public.is_owner() or auth.role() = 'service_role') then raise exception 'not allowed'; end if;
  perform set_config('ari.actor', 'app', true);
  update public.account_briefs set reviewed_at = case when p_on then now() else null end
  where account_id = p_account_id returning * into r;
  if r.account_id is null then raise exception 'no brief for this account'; end if;
  return to_jsonb(r);
end $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id bigint NOT NULL,
    kind text NOT NULL,
    person_id text,
    account_id uuid,
    title text NOT NULL,
    body text,
    url text DEFAULT '/ops'::text NOT NULL,
    dedupe_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    attempts integer DEFAULT 0 NOT NULL,
    claimed_at timestamp with time zone,
    delivered integer DEFAULT 0 NOT NULL,
    error text,
    CONSTRAINT notifications_kind_check CHECK ((kind = ANY (ARRAY['accepted'::text, 'replied'::text, 'meeting'::text, 'research_done'::text, 'draft_due'::text, 'digest'::text, 'test'::text])))
);


--
-- Name: ari_claim_notifications(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_claim_notifications(p_limit integer DEFAULT 50) RETURNS SETOF public.notifications
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.notifications n set attempts = n.attempts + 1, claimed_at = now()
   where n.id in (select id from public.notifications
                   where sent_at is null and attempts < 5
                     and (claimed_at is null or claimed_at < now() - interval '2 minutes')
                   order by id for update skip locked limit p_limit)
  returning n.*;
$$;


--
-- Name: ari_due_digest(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_due_digest() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare today date := (now() at time zone 'Asia/Kolkata')::date; n1 int; n2 int; n3 int; total int;
begin
  select count(*) filter (where accepted is not null and dm1_sent is null),
         count(*) filter (where dm1_sent is not null and dm2_sent is null and dm2_due <= today),
         count(*) filter (where dm2_sent is not null and dm3_sent is null and dm3_due <= today)
    into n1, n2, n3
    from public.people
   where coalesce(review, 'lead') = 'lead' and deleted_at is null and skipped is null
     and replied is null and meeting is null and withdrawn is null
     and stage not in ('Hold', 'Founder') and (snooze_until is null or snooze_until <= today);
  total := n1 + n2 + n3;
  if total > 0 then
    perform public.ari_notify('draft_due', 'digest:' || today, total || ' follow-up' || case when total = 1 then '' else 's' end || ' due tonight',
      concat_ws(', ', case when n1 > 0 then n1 || ' DM1' end, case when n2 > 0 then n2 || ' DM2' end, case when n3 > 0 then n3 || ' DM3' end) || '. Ready when you are.',
      '/ops', null, null);
  end if;
  return total;
end $$;


--
-- Name: ari_finish_notifications(bigint[], integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_finish_notifications(p_ids bigint[], p_delivered integer, p_error text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.notifications set sent_at = case when p_error is null or p_delivered > 0 then now() end,
         delivered = p_delivered, error = p_error, claimed_at = null
   where id = any(p_ids);
$$;


--
-- Name: ari_lead_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_lead_count(p_account uuid) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  select count(*)::int from public.people p
   where p.account_id = p_account and p.deleted_at is null and coalesce(p.review, 'lead') <> 'personal'
     and coalesce(p.stage, '') <> 'Withdrawn'
$$;


--
-- Name: ari_notify(text, text, text, text, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_notify(p_kind text, p_key text, p_title text, p_body text, p_url text, p_person text DEFAULT NULL::text, p_account uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  insert into public.notifications(kind, dedupe_key, title, body, url, person_id, account_id)
  values (p_kind, p_key, p_title, p_body, coalesce(p_url, '/ops'), p_person, p_account)
  on conflict (dedupe_key) do nothing;
$$;


--
-- Name: ari_people_account(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_people_account(p_account uuid, p_company text) RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select coalesce(p_account, (select id from public.accounts where lower(btrim(company)) = lower(btrim(p_company)) and deleted_at is null limit 1))
$$;


--
-- Name: ari_pref(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_pref(p_key text, p_default jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select coalesce((select value from public.ari_prefs where key = p_key), p_default);
$$;


--
-- Name: ari_pref_set(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_pref_set(p_key text, p_value jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare n int;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if p_key = 'push_show_names' then
    if jsonb_typeof(p_value) <> 'boolean' then raise exception 'push_show_names takes true or false'; end if;
  elsif p_key = 'today15_cap_per_account' then
    n := (p_value #>> '{}')::int;
    if n not in (4, 5) then raise exception 'cap per account is 4 or 5'; end if;
    p_value := to_jsonb(n);
  elsif p_key in ('today15_size', 'today15_open_cap', 'weekly_invite_ceiling') then
    n := (p_value #>> '{}')::int;
    if n < 1 or n > 300 then raise exception 'out of range'; end if;
    p_value := to_jsonb(n);
  else
    raise exception 'unknown setting %', p_key;
  end if;
  insert into public.ari_prefs(key, value, updated_at, updated_by) values (p_key, p_value, now(), 'app')
  on conflict (key) do update set value = excluded.value, updated_at = now(), updated_by = 'app';
  return jsonb_build_object('key', p_key, 'value', p_value);
end $$;


--
-- Name: ari_push_ack(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_push_ack(p_endpoint text, p_tag text DEFAULT NULL::text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.push_subscriptions set last_rx_at = now(), last_rx_tag = left(p_tag, 64)
   where endpoint = p_endpoint and revoked_at is null;
$$;


--
-- Name: ari_push_config(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_push_config() RETURNS jsonb
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select jsonb_build_object(
    'hook_secret', (select decrypted_secret from vault.decrypted_secrets where name = 'ari_push_hook_secret'),
    'vapid_private_jwk', (select decrypted_secret from vault.decrypted_secrets where name = 'ari_vapid_private_jwk'),
    'vapid_public_key', (select value from public.app_config where key = 'vapid_public_key'),
    'subject', 'mailto:ops@example.com');
$$;


--
-- Name: ari_push_kick(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_push_kick() RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select net.http_post(
    url := 'https://rbkrqlzlblquvgmuohro.supabase.co/functions/v1/ari-push',
    headers := jsonb_build_object('content-type', 'application/json',
                 'x-ari-hook', (select decrypted_secret from vault.decrypted_secrets where name = 'ari_push_hook_secret')),
    body := '{"source":"db"}'::jsonb,
    timeout_milliseconds := 15000);
$$;


--
-- Name: ari_replies_open(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_replies_open(p_limit integer DEFAULT 20) RETURNS TABLE(id bigint, person_id text, name text, title text, company text, account_id uuid, owner text, linkedin_url text, thread_url text, received_at timestamp with time zone, age_min integer, msg_count integer, snippet text, snippet_source text, drafts jsonb, drafted_at timestamp with time zone, status text, last_sent text)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select r.id, r.person_id, p.name, p.title, p.company, coalesce(r.account_id, p.account_id), p.owner,
         p.linkedin_url, r.thread_url, r.received_at, (extract(epoch from now() - r.received_at) / 60)::int, r.msg_count,
         r.snippet, r.snippet_source, r.drafts, r.drafted_at, r.status,
         (select s.body from public.sent_messages s where s.person_id = r.person_id and s.kind <> 'note' order by s.sent_at desc limit 1)
  from public.replies r join public.people p on p.id = r.person_id
  where r.status = 'new' and p.deleted_at is null and coalesce(p.review, 'lead') <> 'personal'
  order by r.received_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;


--
-- Name: ari_reply_done(bigint, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_reply_done(p_id bigint, p_outcome text, p_body text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r public.replies;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if coalesce(p_outcome, '') not in ('answered', 'meeting', 'dismissed', 'new') then raise exception 'bad outcome'; end if;
  update public.replies set status = p_outcome,
         answered_at = case when p_outcome = 'new' then null else now() end,
         answer_body = case when p_outcome = 'new' then null else coalesce(nullif(btrim(coalesce(p_body, '')), ''), answer_body) end,
         updated_at = now()
  where id = p_id returning * into r;
  if not found then raise exception 'no such reply'; end if;
  if p_outcome in ('answered', 'meeting') and nullif(btrim(coalesce(p_body, '')), '') is not null then
    perform public.ari_sent_log(r.person_id, 'reply', p_body, now());
  end if;
  return to_jsonb(r);
end $$;


--
-- Name: ari_reply_paste(bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_reply_paste(p_id bigint, p_text text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare r public.replies;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if nullif(btrim(coalesce(p_text, '')), '') is null then raise exception 'empty text'; end if;
  update public.replies set snippet = left(btrim(p_text), 2000), snippet_source = 'pasted', drafts = null, drafted_at = null,
         status = 'new', updated_at = now()
  where id = p_id returning * into r;
  if not found then raise exception 'no such reply'; end if;
  return to_jsonb(r);
end $$;


--
-- Name: ari_sent_delete(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_sent_delete(p_id bigint) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  delete from public.sent_messages where id = p_id and kind in ('reply','note');
  return found;
end $$;


--
-- Name: ari_sent_edit(bigint, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_sent_edit(p_id bigint, p_body text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: ari_sent_log(text, text, text, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_sent_log(p_person_id text, p_kind text, p_body text, p_sent_at timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: ari_set_account_stage(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_set_account_stage(p_account text, p_stage text, p_op_id text DEFAULT NULL::text, p_reason text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
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
end $_$;


--
-- Name: ari_stage_norm(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_stage_norm(s text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case lower(regexp_replace(btrim(coalesce(s, '')), '\s+', ' ', 'g'))
    when 'target' then 'Target' when 'researching' then 'Researching' when 'mapped' then 'Mapped'
    when 'engaged' then 'Engaged' when 'meeting set' then 'Meeting set' when 'meeting held' then 'Meeting held'
    when 'opportunity created' then 'Opportunity created' when 'opportunity' then 'Opportunity created' when 'opp' then 'Opportunity created'
    when 'hold' then 'Hold' when 'on hold' then 'Hold' when 'customer' then 'Customer'
    when 'closed lost' then 'Closed lost' when 'closed-lost' then 'Closed lost' when 'not a fit' then 'Not a fit'
    else null end
$$;


--
-- Name: ari_stage_rank(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_stage_rank(s text) RETURNS integer
    LANGUAGE sql IMMUTABLE
    AS $$
  select case s when 'Target' then 1 when 'Researching' then 2 when 'Mapped' then 3 when 'Engaged' then 4
    when 'Meeting set' then 5 when 'Meeting held' then 6 when 'Opportunity created' then 7 else 0 end
$$;


--
-- Name: ari_stage_undo(bigint); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_stage_undo(p_history_id bigint) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: ari_stale(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_stale(p_ae text DEFAULT NULL::text) RETURNS TABLE(kind text, prio integer, person_id text, name text, title text, account text, account_key text, account_id uuid, ae text, since timestamp with time zone, days integer, due date, next_step text, detail text)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with t as (select public.rpt_today() as d),
  ra as materialized (select x.account_key, x.stage from public.rpt_accounts x),
  rpm as materialized (select * from public.rpt_people),
  pl as (
    select rp.person_id, rp.name, rp.title, rp.account, rp.account_key, rp.account_id, rp.ae, rp.connect_sent, rp.accepted,
           rp.dm1_sent, rp.dm2_sent, rp.dm3_sent, rp.dm, rp.dm2_text, rp.dm3_text, p.dm2_due, p.dm3_due
    from rpm rp
    join public.people p on p.id = rp.person_id
    left join ra on ra.account_key = rp.account_key
    where coalesce(rp.review, 'lead') = 'lead' and p.skipped is null
      and (p.snooze_until is null or p.snooze_until <= (select d from t))
      and coalesce(rp.stage, '') not in ('Hold', 'Founder', 'Withdrawn', 'Personal') and coalesce(lower(p.lane), 'shal') <> 'founder'
      and rp.withdrawn is null and rp.replied is null and rp.meeting is null
      and coalesce(ra.stage, '') not in ('Meeting set', 'Meeting held', 'Opportunity created', 'Hold', 'Customer', 'Closed lost', 'Not a fit')
      and (p_ae is null or p_ae = '' or lower(rp.ae) = lower(split_part(btrim(p_ae), ' ', 1)))
  ), x as (
    select 'dm2_overdue'::text as k, 1 as pr, pl.*, pl.dm1_sent as since_ts, coalesce(pl.dm2_due, public.rpt_day(pl.dm1_sent) + 4) as due_d,
           case when coalesce(pl.dm2_text, '') <> '' then 'Send DM2. The draft is ready' else 'Send DM2' end as ns
    from pl where pl.dm1_sent is not null and pl.dm2_sent is null and coalesce(pl.dm2_due, public.rpt_day(pl.dm1_sent) + 4) < (select d from t)
    union all
    select 'dm3_overdue', 1, pl.*, pl.dm2_sent, coalesce(pl.dm3_due, public.rpt_day(pl.dm2_sent) + 7),
           case when coalesce(pl.dm3_text, '') <> '' then 'Send DM3. The draft is ready' else 'Send DM3' end
    from pl where pl.dm2_sent is not null and pl.dm3_sent is null and coalesce(pl.dm3_due, public.rpt_day(pl.dm2_sent) + 7) < (select d from t)
    union all
    select 'accepted_no_dm1', 2, pl.*, pl.accepted, public.rpt_day(pl.accepted) + 2,
           case when coalesce(pl.dm, '') <> '' then 'Send DM1. The draft is ready' else 'Send DM1. Ask Ari for a draft' end
    from pl where pl.accepted is not null and pl.dm1_sent is null and pl.accepted < now() - interval '2 days'
    union all
    select 'connect_withdraw', 4, pl.*, pl.connect_sent, public.rpt_day(pl.connect_sent) + 14, 'Withdraw the invite'
    from pl where pl.connect_sent is not null and pl.accepted is null and pl.connect_sent < now() - interval '14 days'
  )
  select x.k, x.pr, x.person_id, x.name, x.title, x.account, x.account_key, x.account_id, x.ae, x.since_ts,
         floor(extract(epoch from now() - x.since_ts) / 86400)::int, x.due_d, x.ns,
         case x.k when 'dm2_overdue' then 'DM2 was due ' || to_char(x.due_d, 'Mon FMDD')
                  when 'dm3_overdue' then 'DM3 was due ' || to_char(x.due_d, 'Mon FMDD')
                  when 'accepted_no_dm1' then 'Accepted ' || floor(extract(epoch from now() - x.since_ts) / 86400)::int || ' days ago, no DM1'
                  else 'Invite pending ' || floor(extract(epoch from now() - x.since_ts) / 86400)::int || ' days' end
  from x
  union all
  select 'engaged_quiet', 3, null, null, null, h.account, h.account_key, h.account_id, h.ae, h.last_touch, h.days_quiet, null,
         'Touch someone at ' || h.account || ': a follow-up or a new connect',
         case when h.days_quiet is null then 'Engaged, nobody touched yet' else 'Engaged, no touch in ' || h.days_quiet || ' days' end
  from public.account_health(p_ae) h
  where h.stage = 'Engaged' and (h.days_quiet is null or h.days_quiet >= 7)
  order by 2, 11 desc nulls last, 4
$$;


--
-- Name: ari_subscription_result(uuid, boolean, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_subscription_result(p_id uuid, p_ok boolean, p_status integer, p_error text) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.push_subscriptions set
    last_ok_at = case when p_ok then now() else last_ok_at end,
    failures = case when p_ok then 0 else failures + 1 end,
    last_error = case when p_ok then null else left(coalesce(p_status::text, '') || ' ' || coalesce(p_error, ''), 300) end,
    revoked_at = case when p_status in (404, 410) then now() else revoked_at end
  where id = p_id;
$$;


--
-- Name: ari_test_ping(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_test_ping(p_note text DEFAULT NULL::text) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare nid bigint; t text := to_char(now() at time zone 'Asia/Kolkata', 'HH24:MI:SS');
begin
  if not (public.is_owner() or coalesce(auth.role(), '') = 'service_role' or session_user::text in ('postgres', 'supabase_admin')) then
    raise exception 'not allowed'; end if;
  insert into public.notifications(kind, dedupe_key, title, body, url)
  values ('test', 'test:' || extract(epoch from clock_timestamp())::text, 'Ari test ping',
          'Sent ' || t || coalesce(' · ' || nullif(left(p_note, 60), ''), '') || '. If you can read this, pings work on this device.', '/ops')
  returning id into nid;
  return nid;
end $$;


--
-- Name: ari_today15(date, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_today15(p_day date DEFAULT NULL::date, p_limit integer DEFAULT NULL::integer) RETURNS TABLE(rank integer, person_id text, name text, title text, company text, account_id uuid, owner text, linkedin_url text, score numeric, wave integer, why text, hook text, hook_date date, signal_age_days integer, connect_day date, priority text, has_dm1 boolean, cap_left_after integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
with cfg as (
  select coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date) as d,
         coalesce(p_limit, (public.ari_pref('today15_size', '15'::jsonb) #>> '{}')::int) as lim,
         (public.ari_pref('today15_cap_per_account', '4'::jsonb) #>> '{}')::int as cap,
         (public.ari_pref('today15_open_cap', '8'::jsonb) #>> '{}')::int as open_cap
),
prio as (
  select (pp ->> 'person_id') as person_id, min(pp ->> 'priority') as priority
  from public.account_briefs b, jsonb_array_elements(coalesce(b.committee, '[]'::jsonb)) t, jsonb_array_elements(coalesce(t -> 'people', '[]'::jsonb)) pp
  where pp ? 'person_id' group by 1
),
acct_load as (
  select coalesce(p.account_id::text, 'co:' || lower(coalesce(p.company, ''))) as akey,
         count(*) filter (where (p.connect_sent at time zone 'Asia/Kolkata')::date = (select d from cfg)) as sent_day,
         count(*) filter (where p.connect_sent is not null and p.accepted is null and p.withdrawn is null and p.replied is null) as open_inv
  from public.people p where p.deleted_at is null group by 1
),
elig as (
  select p.*, a.hook, a.hook_date, a.stage as astage,
         coalesce(p.account_id::text, 'co:' || lower(coalesce(p.company, ''))) as akey,
         pr.priority,
         case when a.hook_date is null then null else ((select d from cfg) - a.hook_date) end as age
  from public.people p
  left join public.accounts a on a.id = p.account_id
  left join prio pr on pr.person_id = p.id
  where p.deleted_at is null and p.stage = 'Connect queued' and p.connect_sent is null and p.withdrawn is null
    and coalesce(p.review, 'lead') = 'lead'
    and coalesce(p.lane, 'shal') not in ('founder', 'Founder') and coalesce(p.route, '') not ilike '%founder%'
    and nullif(btrim(coalesce(p.linkedin_url, '')), '') is not null
    and (p.snooze_until is null or p.snooze_until <= (select d from cfg))
    and (p.skipped is null or p.skipped <> (select d from cfg))
    and not (coalesce(p.flags, '{}') && array['dnc','hold','do-not'])
    and (a.id is null or (a.deleted_at is null and coalesce(a.stage, '') not in ('Hold', 'Meeting set', 'Closed')
         and coalesce(a.meeting_status, '') = '' and coalesce(array_length(a.flags, 1), 0) = 0))
),
scored as (
  select e.*,
         round(
           (case when e.age is null then 10 else greatest(0, 90 - e.age) * 50.0 / 90 end)
           + (case when e.connect_day is null then 10 when e.connect_day <= (select d from cfg) then 30 else greatest(0, 20 - 5 * (e.connect_day - (select d from cfg))) end)
           + (case e.priority when 'P1' then 20 when 'P2' then 10 else 0 end)
           + (case when coalesce(e.dm, '') <> '' then 5 else 0 end)
           + (case when e.title ~* '(chief|vp|vice president|head of|svp|director)' then 5 else 0 end), 1) as score
  from elig e
),
ranked as (
  select s.*, row_number() over (partition by s.akey order by s.score desc, s.created_at, s.id) as wave,
         greatest(0, least((select cap from cfg) - coalesce(l.sent_day, 0), (select open_cap from cfg) - coalesce(l.open_inv, 0))) as allowed
  from scored s left join acct_load l on l.akey = s.akey
),
picked as (
  select r.*, row_number() over (order by r.wave, r.score desc, r.id) as rk
  from ranked r where r.wave <= r.allowed
)
select rk::int, id, name, title, company, account_id, owner, linkedin_url, score, wave::int,
       concat_ws(' · ',
         case when hook_date is not null then 'Signal ' || age || 'd old' else 'No dated signal' end,
         case when connect_day is null then null when connect_day < (select d from cfg) then 'overdue since ' || to_char(connect_day, 'Mon DD')
              when connect_day = (select d from cfg) then 'planned today' end,
         case when priority in ('P1','P2') then priority || ' in brief' end,
         case when coalesce(dm, '') <> '' then 'DM1 ready' end),
       hook, hook_date, age::int, connect_day, priority, coalesce(dm, '') <> '', (allowed - wave)::int
from picked
where rk <= (select lim from cfg)
order by rk;
$$;


--
-- Name: ari_today15_meta(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_today15_meta(p_day date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
with cfg as (
  select coalesce(p_day, (now() at time zone 'Asia/Kolkata')::date) as d,
         (public.ari_pref('today15_cap_per_account', '4'::jsonb) #>> '{}')::int as cap,
         (public.ari_pref('today15_open_cap', '8'::jsonb) #>> '{}')::int as open_cap,
         (public.ari_pref('weekly_invite_ceiling', '100'::jsonb) #>> '{}')::int as ceiling,
         (public.ari_pref('today15_size', '15'::jsonb) #>> '{}')::int as size
),
per as (
  select coalesce(p.company, '(no company)') as company, p.account_id,
         count(*) filter (where (p.connect_sent at time zone 'Asia/Kolkata')::date = (select d from cfg)) as sent_day,
         count(*) filter (where p.connect_sent is not null and p.accepted is null and p.withdrawn is null and p.replied is null) as open_inv
  from public.people p where p.deleted_at is null group by 1, 2
)
select jsonb_build_object(
  'day', (select d from cfg),
  'size', (select size from cfg),
  'cap_per_account', (select cap from cfg),
  'open_cap', (select open_cap from cfg),
  'sent_today', (select count(*) from public.people where deleted_at is null and (connect_sent at time zone 'Asia/Kolkata')::date = (select d from cfg)),
  'sent_7d', (select count(*) from public.people where deleted_at is null and connect_sent >= ((select d from cfg) - 6)::timestamp at time zone 'Asia/Kolkata'),
  'weekly_ceiling', (select ceiling from cfg),
  'over_cap_today', coalesce((select jsonb_agg(jsonb_build_object('company', company, 'account_id', account_id, 'sent_today', sent_day) order by sent_day desc)
                              from per where sent_day > (select cap from cfg)), '[]'::jsonb),
  'accounts_today', coalesce((select jsonb_agg(jsonb_build_object('company', company, 'account_id', account_id, 'sent_today', sent_day, 'open_invites', open_inv,
                              'cap_left', greatest(0, least((select cap from cfg) - sent_day, (select open_cap from cfg) - open_inv))) order by sent_day desc)
                              from per where sent_day > 0), '[]'::jsonb)
);
$$;


--
-- Name: ari_today_top(date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_today_top(p_day date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select jsonb_build_object(
    'replies', coalesce((select jsonb_agg(to_jsonb(r)) from public.ari_replies_open(20) r), '[]'::jsonb),
    'connects', coalesce((select jsonb_agg(to_jsonb(c) order by c.rank) from public.ari_today15(p_day, null) c), '[]'::jsonb),
    'meta', public.ari_today15_meta(p_day),
    'push_show_names', coalesce(public.ari_pref('push_show_names', 'false'::jsonb), 'false'::jsonb),
    'as_of', now());
$$;


--
-- Name: ari_token_result(uuid, boolean, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_token_result(p_id uuid, p_ok boolean, p_error text, p_unregistered boolean DEFAULT false) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  update public.push_tokens set
    last_ok_at = case when p_ok then now() else last_ok_at end,
    failures = case when p_ok then 0 else failures + 1 end,
    last_error = case when p_ok then null else left(coalesce(p_error, ''), 300) end,
    revoked_at = case when p_unregistered then now() else revoked_at end,
    active = case when p_unregistered then false else active end
  where id = p_id;
$$;


--
-- Name: ari_weekly_digest(boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ari_weekly_digest(p_dry boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare s jsonb; c jsonb; t date := public.rpt_today(); wk date := date_trunc('week', public.rpt_today())::date;
        n_stale int; title text; body text; k text; mt int; ar numeric;
begin
  s := public.report_summary('this_week'); c := s -> 'counts';
  select count(*) into n_stale from public.ari_stale();
  mt := coalesce((c ->> 'meeting')::int, 0); ar := (s -> 'rates' ->> 'accept_rate_period')::numeric;
  title := 'Your week: ' || coalesce(c ->> 'connect', '0') || ' of 75 connects';
  body := coalesce(c ->> 'dms', '0') || ' DMs, ' || coalesce(c ->> 'accept', '0') || ' accepts'
          || coalesce(' (' || round(ar) || '% of connects)', '') || ', '
          || coalesce(c ->> 'reply', '0') || ' repl' || case when coalesce((c ->> 'reply')::int, 0) = 1 then 'y' else 'ies' end || ', '
          || mt || ' meeting' || case when mt = 1 then '' else 's' end || ' of 3 to 4.'
          || case when n_stale > 0 then ' ' || n_stale || ' going cold, first steps are in Today.' else ' Nothing going cold.' end;
  k := 'weekly:' || wk;
  if not p_dry then
    perform public.ari_notify('digest', k, title, body, '/ops?open=report', null, null);
  end if;
  return jsonb_build_object('title', title, 'body', body, 'key', k, 'dry', p_dry, 'week_from', wk, 'as_of', t,
                            'counts', c, 'stale', n_stale);
end $$;


--
-- Name: current_actor(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.current_actor() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select coalesce(nullif(current_setting('ari.actor', true), ''),
                  case when auth.role() = 'service_role'
                       then nullif(left(coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json ->> 'x-ari-actor', 40), '') end,
                  case when auth.role() = 'authenticated' then 'app' else 'hark' end)
$$;


--
-- Name: events_chain(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.events_chain() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare p text;
begin
  select hash into p from public.events order by id desc limit 1;
  new.prev_hash := p;
  new.hash := encode(extensions.digest(coalesce(p,'') || new.ts::text || new.actor || new.verb ||
              coalesce(new.person_id,'') || new.payload::text, 'sha256'), 'hex');
  return new;
end $$;


--
-- Name: hark_exec(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hark_exec(sql text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$ begin execute sql; end $$;


--
-- Name: hark_query(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hark_query(sql text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$ declare r jsonb; begin
  perform set_config('transaction_read_only', 'on', true);
  perform set_config('statement_timeout', '20s', true);
  execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (' || sql || ') t' into r; return r; end $$;


--
-- Name: hark_time(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.hark_time(sql text, n integer DEFAULT 3) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$
declare t0 timestamptz; r jsonb := '[]'; i int; x jsonb;
begin perform set_config('transaction_read_only', 'on', true); perform set_config('statement_timeout', '20s', true);
  for i in 1..least(n, 5) loop t0 := clock_timestamp(); execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (' || sql || ') t' into x; r := r || to_jsonb(round(extract(epoch from clock_timestamp()-t0)*1000)); end loop; return r; end $$;


--
-- Name: is_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_owner() RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'owner@example.com'
     and coalesce((auth.jwt() -> 'user_metadata' ->> 'email_verified')::boolean, true)
$$;


--
-- Name: notifications_kick(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notifications_kick() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  perform public.ari_push_kick();
  return null;
end $$;


--
-- Name: people_copy_guidance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.people_copy_guidance() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: people_notify(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.people_notify() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  ins boolean := tg_op = 'INSERT';
  who text := coalesce(new.name, 'Someone');
  co text := coalesce(nullif(new.company, ''), 'their company');
  url text := '/ops?open=person:' || new.id;
  research_now boolean;
begin
  if coalesce(new.updated_by, '') like 'backfill%' then return null; end if;
  if new.review = 'personal' or new.deleted_at is not null or new.stage in ('Hold', 'Founder') then return null; end if;

  if new.accepted is not null and (ins or old.accepted is null) and coalesce(new.updated_by, '') not like 'app%' then
    perform public.ari_notify('accepted', 'accepted:' || new.id, who || ' accepted',
      co || case when coalesce(new.dm, '') <> '' then '. DM1 draft is ready.' else '. I''m on the DM1.' end, url, new.id, new.account_id);
  end if;
  if new.replied is not null and (ins or old.replied is null) and coalesce(new.updated_by, '') not like 'app%' then
    perform public.ari_notify('replied', 'replied:' || new.id, who || ' replied', co || '. Open LinkedIn, I''ll draft your answer.', url, new.id, new.account_id);
  end if;
  if new.meeting is not null and (ins or old.meeting is null) and coalesce(new.updated_by, '') not like 'app%' then
    perform public.ari_notify('meeting', 'meeting:person:' || new.id, 'Meeting set with ' || who, co || '. Log it in SFDC.', url, new.id, new.account_id);
  end if;

  research_now := coalesce(new.research, '') in ('done', 'Draft ready')
                  and not ins and coalesce(old.research, '') ilike 'research%';
  if research_now then
    perform public.ari_notify('research_done', 'research:' || new.id || ':' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'),
      'Research done: ' || who,
      co || case when coalesce(new.dm, '') <> '' and new.dm1_sent is null then '. DM1 draft is ready to send.' else '.' end, url, new.id, new.account_id);
  elsif new.accepted is not null and new.dm1_sent is null and coalesce(new.dm, '') <> ''
        and (ins or coalesce(old.dm, '') = '') then
    perform public.ari_notify('draft_due', 'draft:dm1:' || new.id, 'DM1 ready for ' || who, co || '. Ready for you to send.', url, new.id, new.account_id);
  end if;
  if not ins and coalesce(new.dm2_text, '') <> '' and coalesce(old.dm2_text, '') = '' and new.dm2_sent is null and new.replied is null then
    perform public.ari_notify('draft_due', 'draft:dm2:' || new.id, 'DM2 drafted for ' || who,
      co || coalesce('. Due ' || to_char(new.dm2_due, 'Mon DD') || '.', '.'), url, new.id, new.account_id);
  end if;
  if not ins and coalesce(new.dm3_text, '') <> '' and coalesce(old.dm3_text, '') = '' and new.dm3_sent is null and new.replied is null then
    perform public.ari_notify('draft_due', 'draft:dm3:' || new.id, 'DM3 drafted for ' || who,
      co || coalesce('. Due ' || to_char(new.dm3_due, 'Mon DD') || '.', '.'), url, new.id, new.account_id);
  end if;
  return null;
end $$;


--
-- Name: people_sent_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.people_sent_snapshot() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: people_stage_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.people_stage_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: people_stage_ts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.people_stage_ts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'INSERT' or new.stage is distinct from old.stage then new.stage_changed_at := now(); end if;
  return new;
end $$;


--
-- Name: push_device_set(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_device_set(p_id uuid, p_action text) RETURNS text
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if p_action = 'remove' then
    update public.push_subscriptions set revoked_at = now(), active = false, paused_reason = 'removed by you' where id = p_id;
    update public.push_tokens set revoked_at = now(), active = false where id = p_id;
  elsif p_action = 'pause' then
    update public.push_subscriptions set active = false, paused_reason = 'paused by you' where id = p_id;
    update public.push_tokens set active = false where id = p_id;
  elsif p_action = 'resume' then
    update public.push_subscriptions set active = true, paused_reason = null where id = p_id and revoked_at is null;
    update public.push_tokens set active = true where id = p_id and revoked_at is null;
  else raise exception 'unknown action %', p_action; end if;
  return p_action;
end $$;


--
-- Name: push_devices(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.push_devices() RETURNS TABLE(id uuid, kind text, platform text, device text, browser text, standalone boolean, active boolean, paused_reason text, created_at timestamp with time zone, last_ok_at timestamp with time zone, last_error text, endpoint_tail text, last_seen_at timestamp with time zone, last_rx_at timestamp with time zone)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select id, 'web', platform, device, browser, standalone, active, paused_reason, created_at, last_ok_at, last_error, right(endpoint, 16), last_seen_at, last_rx_at
    from public.push_subscriptions where revoked_at is null and public.is_owner()
  union all
  select id, 'app', platform, device, 'ari-app', true, active, null, created_at, last_ok_at, last_error, right(token, 12), null::timestamptz, null::timestamptz
    from public.push_tokens where revoked_at is null and public.is_owner()
  order by created_at desc;
$$;


--
-- Name: queue_stage_events(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.queue_stage_events() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare acc uuid;
begin
  if new.action !~* '^map (account|more people)' then return null; end if;
  if coalesce(new.details, '') ~* 'QA test' then return null; end if;
  acc := public.ari_people_account(null, new.target);
  perform public.ari_autoadvance(acc, 'Researching', 'Ari is finding people');
  return null;
end $$;


--
-- Name: register_push(text, text, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_push(p_endpoint text, p_p256dh text, p_auth text, p_platform text DEFAULT NULL::text, p_device text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare rid uuid;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  insert into public.push_subscriptions(endpoint, p256dh, auth, platform, device, user_agent)
  values (p_endpoint, p_p256dh, p_auth, p_platform, p_device, p_user_agent)
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
     platform = coalesce(excluded.platform, push_subscriptions.platform),
     device = coalesce(excluded.device, push_subscriptions.device),
     user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
     revoked_at = null, failures = 0, last_error = null
  returning id into rid;
  return rid;
end $$;


--
-- Name: register_push2(text, text, text, text, text, text, text, boolean, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_push2(p_endpoint text, p_p256dh text, p_auth text, p_platform text DEFAULT NULL::text, p_device text DEFAULT NULL::text, p_user_agent text DEFAULT NULL::text, p_browser text DEFAULT NULL::text, p_standalone boolean DEFAULT NULL::boolean, p_install_id text DEFAULT NULL::text, p_explicit boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare rid uuid;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  insert into public.push_subscriptions(endpoint, p256dh, auth, platform, device, user_agent, browser, standalone, install_id, active, last_seen_at)
  values (p_endpoint, p_p256dh, p_auth, p_platform, p_device, p_user_agent, p_browser, p_standalone, p_install_id, true, now())
  on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
     platform = coalesce(excluded.platform, push_subscriptions.platform),
     device = coalesce(excluded.device, push_subscriptions.device),
     user_agent = coalesce(excluded.user_agent, push_subscriptions.user_agent),
     browser = coalesce(excluded.browser, push_subscriptions.browser),
     standalone = coalesce(excluded.standalone, push_subscriptions.standalone),
     install_id = coalesce(excluded.install_id, push_subscriptions.install_id),
     failures = 0, last_error = null, last_seen_at = now(),
     revoked_at = case when p_explicit or push_subscriptions.paused_reason is null then null else push_subscriptions.revoked_at end,
     active = case when p_explicit or push_subscriptions.paused_reason is null then true else push_subscriptions.active end,
     paused_reason = case when p_explicit then null else push_subscriptions.paused_reason end
  returning id into rid;
  if p_install_id is not null then
    update public.push_subscriptions set revoked_at = now(), active = false, paused_reason = 'replaced by a newer subscription'
     where id <> rid and install_id = p_install_id and revoked_at is null;
  end if;
  if coalesce(p_standalone, false) then
    update public.push_subscriptions set active = false, paused_reason = 'superseded by the installed Ari app'
     where id <> rid and revoked_at is null and active and coalesce(standalone, false) = false
       and coalesce(platform, '') = coalesce(p_platform, '');
  end if;
  return rid;
end $$;


--
-- Name: register_push_token(text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_push_token(p_token text, p_platform text DEFAULT NULL::text, p_device text DEFAULT NULL::text, p_app_version text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $_$
declare rid uuid;
begin
  if not public.is_owner() then raise exception 'not allowed'; end if;
  if p_token !~ '^Expo(nent)?PushToken\[.+\]$' then raise exception 'not an Expo push token'; end if;
  insert into public.push_tokens(token, platform, device, app_version)
  values (p_token, p_platform, p_device, p_app_version)
  on conflict (token) do update set platform = coalesce(excluded.platform, push_tokens.platform),
     device = coalesce(excluded.device, push_tokens.device), app_version = coalesce(excluded.app_version, push_tokens.app_version),
     revoked_at = null, failures = 0, last_error = null, active = true
  returning id into rid;
  update public.push_subscriptions set active = false, paused_reason = 'superseded by the Ari app'
   where revoked_at is null and active and coalesce(platform, '') = coalesce(p_platform, '');
  return rid;
end $_$;


--
-- Name: report_dashboard(text, date, date, text, text, text, text, date, date, integer, integer, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_dashboard(p_period text DEFAULT 'today'::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_ae text DEFAULT NULL::text, p_play text DEFAULT NULL::text, p_stage text DEFAULT NULL::text, p_part text DEFAULT 'all'::text, p_prev_from date DEFAULT NULL::date, p_prev_to date DEFAULT NULL::date, p_days integer DEFAULT NULL::integer, p_heat_days integer DEFAULT NULL::integer, p_aw_from date DEFAULT NULL::date, p_aw_to date DEFAULT NULL::date) RETURNS jsonb
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
declare
  rg record; t date := public.rpt_today(); n_len int; pf date; pt date; nd int; nh int; af date; at2 date;
  part text := lower(coalesce(nullif(p_part, ''), 'all')); r jsonb := '{}'::jsonb; t0 timestamptz := clock_timestamp();
begin
  if to_regclass('pg_temp.rpt_ev_cache') is null then
    create temp table rpt_ev_cache on commit drop as select * from public.rpt_events;
  else
    truncate pg_temp.rpt_ev_cache; insert into pg_temp.rpt_ev_cache select * from public.rpt_events;
  end if;
  perform set_config('ari.rpt_cache', '1', true);
  select * into rg from public.rpt_range(p_period, p_from, p_to);
  n_len := greatest(1, least(rg.d_to, t) - rg.d_from + 1);
  pt := coalesce(p_prev_to, rg.d_from - 1); pf := coalesce(p_prev_from, pt - n_len + 1);
  nd := greatest(1, least(coalesce(p_days, 7), 400)); nh := greatest(1, least(coalesce(p_heat_days, 84), 400));
  af := coalesce(p_aw_from, rg.d_from); at2 := coalesce(p_aw_to, least(rg.d_to, t));
  if part in ('all', 'first', 'hero') then
    r := r || jsonb_build_object(
      'S', public.report_summary(p_period, p_from, p_to, p_ae, p_play, p_stage),
      'T', public.report_summary('today', null, null, p_ae, p_play, p_stage),
      'W', public.report_summary('this_week', null, null, p_ae, p_play, p_stage),
      'M', public.report_summary('this_month', null, null, p_ae, p_play, p_stage),
      'P', public.report_summary('custom', pf, pt, p_ae, p_play, p_stage));
  end if;
  if part in ('all', 'first', 'side') then
    r := r || jsonb_build_object(
      'st', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.report_stage_times(p_ae, p_play) x),
      'dc', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('connect', 'day', nd, p_ae, p_play, p_stage) x),
      'dd', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('dms', 'day', nd, p_ae, p_play, p_stage) x),
      'da', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('accept', 'day', nd, p_ae, p_play, p_stage) x),
      'aw', case when rg.d_from <= t then (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.accounts_worked(af, at2, p_ae, p_play) x) else '[]'::jsonb end);
  end if;
  if part in ('all', 'more', 'trend') then
    r := r || jsonb_build_object(
      'wc', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('connect', 'week', 8, p_ae, p_play, p_stage) x),
      'wa', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('accept', 'week', 8, p_ae, p_play, p_stage) x),
      'wd', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('dms', 'week', 8, p_ae, p_play, p_stage) x),
      'wr', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('reply', 'week', 8, p_ae, p_play, p_stage) x),
      'wm', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('meeting', 'week', 8, p_ae, p_play, p_stage) x),
      'hm', (select coalesce(jsonb_agg(to_jsonb(x) order by x.bucket_start), '[]'::jsonb) from public.report_series('touches', 'day', nh, p_ae, p_play, p_stage) x));
  end if;
  if part in ('all', 'more', 'extra') then
    r := r || jsonb_build_object(
      'hk', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.report_hooks('last_8w', null, null, p_ae, p_play, 1) x),
      'health', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.account_health(p_ae) x),
      'stale', (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from public.ari_stale(p_ae) x));
  end if;
  perform set_config('ari.rpt_cache', '', true);
  return r || jsonb_build_object('part', part, 'range', jsonb_build_object('from', rg.d_from, 'to', rg.d_to, 'today', t, 'prev_from', pf, 'prev_to', pt),
                                 'ms', round(extract(epoch from clock_timestamp() - t0) * 1000));
end $$;


--
-- Name: report_hooks(text, date, date, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_hooks(p_period text DEFAULT 'last_8w'::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_ae text DEFAULT NULL::text, p_play text DEFAULT NULL::text, p_min_sent integer DEFAULT 1) RETURNS TABLE(kind text, label text, dm1_sent integer, replied integer, reply_rate numeric, accepted integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with rg as (select * from public.rpt_range(p_period, p_from, p_to)),
  c as (
    select distinct e.person_id from rg, public.rpt_filtered(rg.d_from, rg.d_to, p_ae, p_play) e where e.metric = 'dm1'
  ), x as (
    select rp.*, coalesce(nullif(p.extra ->> 'variant', ''),
             case when coalesce(rp.dm, '') = '' then '(no DM text)'
                  when rp.dm ~* '\mhiring|job post|open role|\mrole\M' then 'Hiring signal'
                  when rp.dm ~* 'rais|funding|series [a-e]|acqui|\mdeal|partnership' then 'Funding / deal'
                  when rp.dm ~* 'launch|releas|shipped|announc|rolled out|\mGA\M' then 'Launch / release'
                  when rp.dm ~* '\mpost|talk|podcast|webinar|interview|keynote|panel|wrote|article|blog' then 'Their post / talk'
                  when rp.dm ~* '\mnews|report|filing|10-k|press' then 'News / filing'
                  else 'Other angle' end) as opener
    from c join public.rpt_people rp using (person_id) join public.people p on p.id = rp.person_id
  )
  select * from (
    select 'hook'::text as k, coalesce(nullif(hook, ''), '(no hook)') as l, count(*)::int as sent, count(*) filter (where replied is not null)::int as rep,
           round(100.0 * count(*) filter (where replied is not null) / nullif(count(*), 0), 1) as rr, count(*) filter (where accepted is not null)::int as acc
    from x group by 2
    union all
    select 'dm1_variant', coalesce(nullif(opener, ''), '(no DM text)'), count(*)::int, count(*) filter (where replied is not null)::int,
           round(100.0 * count(*) filter (where replied is not null) / nullif(count(*), 0), 1), count(*) filter (where accepted is not null)::int
    from x group by 2
  ) s where s.sent >= p_min_sent
  order by 1, 5 desc nulls last, 3 desc
$$;


--
-- Name: report_rows(text, text, date, date, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_rows(p_metric text, p_period text DEFAULT 'this_week'::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_ae text DEFAULT NULL::text, p_play text DEFAULT NULL::text, p_stage text DEFAULT NULL::text, p_account text DEFAULT NULL::text) RETURNS TABLE(metric text, unit text, person_id text, name text, title text, account text, account_key text, ae text, play text, account_stage text, person_stage text, ts timestamp with time zone, day date, src text, linkedin_url text)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with rg as (select * from public.rpt_range(p_period, p_from, p_to)),
  ev as (select e.* from rg, public.rpt_filtered(rg.d_from, rg.d_to, p_ae, p_play, p_stage, p_account) e),
  pick as (
    select e.*, row_number() over (partition by
             case when p_metric = 'accounts_worked' then e.account_key when p_metric = 'touches' then e.person_id
                  else e.metric || ':' || e.ref end
           order by e.ts) rn
    from ev e
    where case lower(p_metric)
            when 'dms' then e.metric in ('dm1','dm2','dm3')
            when 'touches' then e.metric in ('connect','accept','dm1','dm2','dm3','reply')
            when 'accounts_worked' then e.metric in ('connect','accept','dm1','dm2','dm3','reply','meeting','opp','stage_manual','withdrawn')
            when 'accepted_from_connects' then e.metric = 'connect' and exists (select 1 from public.rpt_people x where x.person_id = e.person_id and x.accepted is not null)
            when 'replied_from_dm1' then e.metric = 'dm1' and exists (select 1 from public.rpt_people x where x.person_id = e.person_id and x.replied is not null)
            else e.metric = lower(p_metric) end
  )
  select k.metric, public.rpt_unit(k.metric), k.person_id, coalesce(rp.name, k.person_name), rp.title, k.account, k.account_key,
         k.ae, k.play, k.account_stage, rp.stage, k.ts, k.day, k.src, rp.linkedin_url
  from pick k left join public.rpt_people rp on rp.person_id = k.person_id
  where k.rn = 1
  order by k.ts desc
$$;


--
-- Name: report_series(text, text, integer, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_series(p_metric text, p_bucket text DEFAULT 'week'::text, p_n integer DEFAULT 8, p_ae text DEFAULT NULL::text, p_play text DEFAULT NULL::text, p_stage text DEFAULT NULL::text) RETURNS TABLE(bucket_start date, bucket_end date, value integer)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with b as (
    select case p_bucket when 'day' then g::date when 'month' then date_trunc('month', g)::date else date_trunc('week', g)::date end s
    from generate_series(
      case p_bucket when 'day' then public.rpt_today() - (p_n - 1)
                    when 'month' then (date_trunc('month', public.rpt_today()) - ((p_n - 1) || ' months')::interval)::date
                    else date_trunc('week', public.rpt_today())::date - 7 * (p_n - 1) end,
      public.rpt_today(),
      case p_bucket when 'day' then interval '1 day' when 'month' then interval '1 month' else interval '1 week' end) g
  ), bk as (
    select s, case p_bucket when 'day' then s when 'month' then (s + interval '1 month')::date - 1 else s + 6 end e from b
  ), ev as (
    select * from public.rpt_filtered((select min(s) from bk), (select max(e) from bk), p_ae, p_play, p_stage)
  )
  select bk.s, bk.e,
         (case lower(p_metric)
            when 'dms' then (select count(distinct metric || ref) from ev where metric in ('dm1','dm2','dm3') and day between bk.s and bk.e)
            when 'accounts_worked' then (select count(distinct account_key) from ev where metric in ('connect','accept','dm1','dm2','dm3','reply','meeting','opp','stage_manual','withdrawn') and day between bk.s and bk.e)
            when 'touches' then (select count(distinct person_id) from ev where metric in ('connect','accept','dm1','dm2','dm3','reply') and day between bk.s and bk.e)
            else (select count(distinct ref) from ev where metric = lower(p_metric) and day between bk.s and bk.e) end)::int
  from bk order by bk.s
$$;


--
-- Name: report_stage_times(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_stage_times(p_ae text DEFAULT NULL::text, p_play text DEFAULT NULL::text) RETURNS TABLE(level text, stage text, n integer, avg_days numeric, median_days numeric, max_days numeric, oldest text)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with p as (
    select r.stage, r.name || ' (' || r.account || ')' as who,
           extract(epoch from now() - coalesce(case r.stage when 'Connect sent' then r.connect_sent when 'Accepted' then r.accepted
             when 'DM1 sent' then r.dm1_sent when 'DM2 sent' then r.dm2_sent when 'DM3 sent' then r.dm3_sent when 'Replied' then r.replied
             when 'Meeting' then r.meeting when 'Withdrawn' then r.withdrawn end, r.stage_changed_at, r.created_at)) / 86400.0 as d
    from public.rpt_people r
    where (p_ae is null or lower(r.ae) = lower(split_part(btrim(p_ae), ' ', 1))) and (p_play is null or r.play ilike '%' || p_play || '%')
  ), a as (
    select ra.stage, ra.account as who, extract(epoch from now() - ra.stage_since) / 86400.0 as d
    from public.rpt_accounts ra
    where (p_ae is null or lower(ra.ae) = lower(split_part(btrim(p_ae), ' ', 1))) and (p_play is null or ra.play ilike '%' || p_play || '%')
  )
  select 'person', stage, count(*)::int, round(avg(d)::numeric, 1), round((percentile_cont(0.5) within group (order by d))::numeric, 1),
         round(max(d)::numeric, 1), (array_agg(who order by d desc))[1] from p group by stage
  union all
  select 'account', stage, count(*)::int, round(avg(d)::numeric, 1), round((percentile_cont(0.5) within group (order by d))::numeric, 1),
         round(max(d)::numeric, 1), (array_agg(who order by d desc))[1] from a group by stage
  order by 1 desc, 2
$$;


--
-- Name: report_summary(text, date, date, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.report_summary(p_period text DEFAULT 'this_week'::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, p_ae text DEFAULT NULL::text, p_play text DEFAULT NULL::text, p_stage text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  with rg as (select * from public.rpt_range(p_period, p_from, p_to)),
  ev as (select e.* from rg, public.rpt_filtered(rg.d_from, rg.d_to, p_ae, p_play, p_stage) e),
  touchm(m) as (values ('connect'),('accept'),('dm1'),('dm2'),('dm3'),('reply'),('meeting'),('opp'),('stage_manual'),('withdrawn')),
  c as (
    select jsonb_object_agg(m, (select count(distinct e.ref) from ev e where e.metric = m)) j
    from unnest(array['connect','accept','dm1','dm2','dm3','reply','meeting','opp','withdrawn','stage_change','stage_manual',
                      'draft','signal','account_added','person_added']) m
  ), c2 as (
    select c.j || jsonb_build_object(
      'dms', (c.j ->> 'dm1')::int + (c.j ->> 'dm2')::int + (c.j ->> 'dm3')::int,
      'touches', (select count(distinct person_id) from ev where metric in ('connect','accept','dm1','dm2','dm3','reply')),
      'accounts_worked', (select count(distinct account_key) from ev where metric in (select m from touchm)),
      'drafted_people', (select count(distinct person_id) from ev where metric = 'draft')) j
    from c
  ), coh as (
    select jsonb_build_object(
      'connects', (select count(*) from (select distinct person_id from ev where metric = 'connect') x),
      'accepted', (select count(*) from (select distinct person_id from ev where metric = 'connect') x join public.rpt_people rp using (person_id) where rp.accepted is not null),
      'dm1s', (select count(*) from (select distinct person_id from ev where metric = 'dm1') x),
      'replied', (select count(*) from (select distinct person_id from ev where metric = 'dm1') x join public.rpt_people rp using (person_id) where rp.replied is not null)) j
  ), grp as (
    select 'ae' dim, ae val, metric, ref, account_key from ev union all select 'play', play, metric, ref, account_key from ev
  ), brk as (
    select dim, coalesce(jsonb_agg(jsonb_build_object(dim, val, 'connect', cn, 'accept', ac, 'dms', dm, 'reply', rp, 'meeting', mt,
                                                      'opp', op, 'accounts_worked', aw) order by val), '[]') j
    from (
      select dim, val,
             count(distinct ref) filter (where metric = 'connect') cn, count(distinct ref) filter (where metric = 'accept') ac,
             count(distinct metric || ref) filter (where metric in ('dm1','dm2','dm3')) dm,
             count(distinct ref) filter (where metric = 'reply') rp, count(distinct ref) filter (where metric = 'meeting') mt,
             count(distinct ref) filter (where metric = 'opp') op,
             count(distinct account_key) filter (where metric in (select m from touchm)) aw
      from grp group by dim, val) s
    group by dim
  )
  select jsonb_build_object(
    'range', (select jsonb_build_object('from', d_from, 'to', d_to, 'label', label, 'today', public.rpt_today()) from rg),
    'filters', jsonb_strip_nulls(jsonb_build_object('ae', nullif(p_ae, ''), 'play', nullif(p_play, ''), 'stage', nullif(p_stage, ''))),
    'counts', c2.j,
    'rates', jsonb_build_object(
      'accept_rate', round(100.0 * (coh.j ->> 'accepted')::int / nullif((coh.j ->> 'connects')::int, 0), 1),
      'reply_rate', round(100.0 * (coh.j ->> 'replied')::int / nullif((coh.j ->> 'dm1s')::int, 0), 1),
      'accept_rate_period', round(100.0 * (c2.j ->> 'accept')::int / nullif((c2.j ->> 'connect')::int, 0), 1),
      'reply_rate_period', round(100.0 * (c2.j ->> 'reply')::int / nullif((c2.j ->> 'dm1')::int, 0), 1)),
    'cohort', coh.j,
    'by_ae', coalesce((select j from brk where dim = 'ae'), '[]'),
    'by_play', coalesce((select j from brk where dim = 'play'), '[]'))
  from c2, coh
$$;


--
-- Name: rpt_day(timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rpt_day(t timestamp with time zone) RETURNS date
    LANGUAGE sql IMMUTABLE
    AS $$ select (t at time zone 'Asia/Kolkata')::date $$;


--
-- Name: account_stage_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_stage_history (
    id bigint NOT NULL,
    account_id uuid NOT NULL,
    company text,
    from_stage text,
    to_stage text NOT NULL,
    source text NOT NULL,
    kind text NOT NULL,
    reason text,
    actor text,
    undo_of bigint,
    undone_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company text NOT NULL,
    owner text,
    ae text GENERATED ALWAYS AS (split_part(COALESCE(owner, ''::text), ' '::text, 1)) STORED,
    one_liner text,
    hook text,
    hook_date date,
    hook_url text,
    why_vendor text,
    suggested_order text,
    status text,
    play text,
    meeting_status text,
    meeting_source text,
    meeting_date text,
    meeting_person text,
    meeting_ae text,
    meeting_notes text,
    flags text[] DEFAULT '{}'::text[] NOT NULL,
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    sheet_row integer,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    field_ts jsonb DEFAULT '{}'::jsonb NOT NULL,
    domain text,
    stage text DEFAULT 'Target'::text NOT NULL,
    stage_changed_at timestamp with time zone,
    stage_source text,
    stage_reason text,
    stage_override boolean DEFAULT false NOT NULL
);


--
-- Name: log_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_entries (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    person_id text,
    event text NOT NULL,
    detail text,
    source text DEFAULT 'app'::text NOT NULL,
    sheet_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT log_entries_source_check CHECK ((source = ANY (ARRAY['sheet'::text, 'app'::text, 'hark'::text, 'backfill'::text])))
);


--
-- Name: people_app_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.people_app_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: people; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.people (
    id text DEFAULT ('PA'::text || lpad((nextval('public.people_app_seq'::regclass))::text, 4, '0'::text)) NOT NULL,
    account_id uuid,
    company text,
    owner text,
    name text NOT NULL,
    title text,
    linkedin_url text,
    role text,
    route text,
    connect_day date,
    stage text DEFAULT 'Connect queued'::text NOT NULL,
    stage_changed_at timestamp with time zone,
    dm text,
    dm2_text text,
    dm3_text text,
    connect_sent timestamp with time zone,
    accepted timestamp with time zone,
    dm1_sent timestamp with time zone,
    dm2_due date,
    dm2_sent timestamp with time zone,
    dm3_due date,
    dm3_sent timestamp with time zone,
    replied timestamp with time zone,
    meeting timestamp with time zone,
    withdrawn timestamp with time zone,
    next_action text,
    notes text,
    source text,
    review text,
    research text,
    why_this_person text,
    snooze_until date,
    skipped date,
    play text,
    lane text DEFAULT 'shal'::text NOT NULL,
    flags text[] DEFAULT '{}'::text[] NOT NULL,
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    sheet_row integer,
    deleted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    field_ts jsonb DEFAULT '{}'::jsonb NOT NULL,
    context text,
    CONSTRAINT people_lane_check CHECK ((lane = ANY (ARRAY['shal'::text, 'founder'::text, 'wren'::text]))),
    CONSTRAINT people_review_check CHECK ((review = ANY (ARRAY['lead'::text, 'pending'::text, 'personal'::text])))
);


--
-- Name: queue_app_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.queue_app_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.queue (
    id text DEFAULT ('QA'::text || lpad((nextval('public.queue_app_seq'::regclass))::text, 4, '0'::text)) NOT NULL,
    created timestamp with time zone DEFAULT now() NOT NULL,
    action text NOT NULL,
    target text,
    details text,
    status text DEFAULT 'queued'::text NOT NULL,
    result text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    sheet_row integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    field_ts jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: rpt_people; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.rpt_people WITH (security_invoker='true') AS
 SELECT p.id AS person_id,
    p.name,
    p.title,
    p.linkedin_url,
    p.stage,
    p.review,
    p.lane,
    p.research,
    COALESCE(NULLIF(btrim(a.company), ''::text), NULLIF(btrim(p.company), ''::text), '(no company)'::text) AS account,
    lower(COALESCE(NULLIF(btrim(a.company), ''::text), NULLIF(btrim(p.company), ''::text), '(no company)'::text)) AS account_key,
    a.id AS account_id,
    COALESCE(NULLIF(split_part(btrim(COALESCE(p.owner, ''::text)), ' '::text, 1), ''::text), NULLIF(a.ae, ''::text), 'Unassigned'::text) AS ae,
    COALESCE(p.play, a.play, 'Unassigned'::text) AS play,
    a.hook,
    p.connect_sent,
    p.accepted,
    p.dm1_sent,
    p.dm2_sent,
    p.dm3_sent,
    p.replied,
    p.meeting,
    p.withdrawn,
    p.stage_changed_at,
    p.dm,
    p.dm2_text,
    p.dm3_text,
    p.field_ts,
    p.created_at
   FROM (public.people p
     LEFT JOIN LATERAL ( SELECT x.id,
            x.company,
            x.owner,
            x.ae,
            x.one_liner,
            x.hook,
            x.hook_date,
            x.hook_url,
            x.why_vendor,
            x.suggested_order,
            x.status,
            x.play,
            x.meeting_status,
            x.meeting_source,
            x.meeting_date,
            x.meeting_person,
            x.meeting_ae,
            x.meeting_notes,
            x.flags,
            x.extra,
            x.sheet_row,
            x.deleted_at,
            x.created_at,
            x.updated_at,
            x.updated_by,
            x.field_ts,
            x.domain,
            x.stage,
            x.stage_changed_at,
            x.stage_source,
            x.stage_reason,
            x.stage_override
           FROM public.accounts x
          WHERE ((x.deleted_at IS NULL) AND ((x.id = p.account_id) OR ((p.account_id IS NULL) AND (lower(btrim(x.company)) = lower(btrim(p.company))))))
          ORDER BY (x.id = p.account_id) DESC
         LIMIT 1) a ON (true))
  WHERE ((p.deleted_at IS NULL) AND (COALESCE(p.review, 'lead'::text) <> 'personal'::text));


--
-- Name: rpt_accounts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.rpt_accounts WITH (security_invoker='true') AS
 WITH ppl AS (
         SELECT rpt_people.account_key,
            min(rpt_people.account) AS account,
            count(*) AS people_n,
            count(*) FILTER (WHERE ((rpt_people.accepted IS NOT NULL) OR (rpt_people.replied IS NOT NULL))) AS engaged_n,
            min(LEAST(rpt_people.accepted, rpt_people.replied)) AS engaged_at,
            min(rpt_people.meeting) AS meeting_at,
            mode() WITHIN GROUP (ORDER BY rpt_people.ae) AS ae,
            mode() WITHIN GROUP (ORDER BY rpt_people.play) AS play
           FROM public.rpt_people
          GROUP BY rpt_people.account_key
        ), acc AS (
         SELECT a.id,
            a.company,
            lower(btrim(a.company)) AS account_key,
            a.ae,
            a.play,
            a.status,
            a.meeting_status,
            a.hook,
            a.created_at,
            a.field_ts,
            NULLIF((to_jsonb(a.*) ->> 'stage'::text), ''::text) AS stored_stage,
            COALESCE(((to_jsonb(a.*) ->> 'stage_changed_at'::text))::timestamp with time zone, ((a.field_ts ->> 'stage'::text))::timestamp with time zone) AS stored_stage_at
           FROM public.accounts a
          WHERE (a.deleted_at IS NULL)
        ), base AS (
         SELECT COALESCE(acc.account_key, ppl.account_key) AS account_key,
            COALESCE(acc.company, ppl.account) AS account,
            acc.id AS account_id,
            COALESCE(NULLIF(acc.ae, ''::text), ppl.ae, 'Unassigned'::text) AS ae,
            COALESCE(acc.play, ppl.play, 'Unassigned'::text) AS play,
            acc.status,
            acc.meeting_status,
            acc.hook,
            acc.created_at,
            acc.field_ts,
            acc.stored_stage,
            acc.stored_stage_at,
            COALESCE(ppl.people_n, (0)::bigint) AS people_n,
            COALESCE(ppl.engaged_n, (0)::bigint) AS engaged_n,
            ppl.engaged_at,
            ppl.meeting_at
           FROM (acc
             FULL JOIN ppl ON ((ppl.account_key = acc.account_key)))
        )
 SELECT account_key,
    account,
    account_id,
    ae,
    play,
    status,
    meeting_status,
    hook,
    people_n,
    engaged_n,
    COALESCE(stored_stage,
        CASE
            WHEN (status ~~* 'hold%'::text) THEN 'Hold'::text
            WHEN (meeting_status ~~* 'held%'::text) THEN 'Meeting held'::text
            WHEN ((meeting_status ~~* 'set%'::text) OR (status ~~* 'meeting%'::text) OR (meeting_at IS NOT NULL)) THEN 'Meeting set'::text
            WHEN (engaged_n > 0) THEN 'Engaged'::text
            WHEN (people_n >= 4) THEN 'Mapped'::text
            WHEN (people_n >= 1) THEN 'Researching'::text
            ELSE 'Target'::text
        END) AS stage,
    (stored_stage IS NOT NULL) AS stage_is_stored,
    COALESCE(stored_stage_at,
        CASE
            WHEN (stored_stage IS NOT NULL) THEN NULL::timestamp with time zone
            WHEN ((meeting_status IS NOT NULL) AND (meeting_status <> ''::text)) THEN ((field_ts ->> 'meeting_status'::text))::timestamp with time zone
            WHEN (engaged_n > 0) THEN engaged_at
            ELSE NULL::timestamp with time zone
        END, created_at) AS stage_since,
    stored_stage_at,
    created_at
   FROM base b;


--
-- Name: rpt_events; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.rpt_events WITH (security_invoker='true') AS
 WITH col AS (
         SELECT r.person_id,
            r.account_key,
            m.metric,
            m.ts
           FROM (public.rpt_people r
             CROSS JOIN LATERAL ( VALUES ('connect'::text,r.connect_sent), ('accept'::text,r.accepted), ('dm1'::text,r.dm1_sent), ('dm2'::text,r.dm2_sent), ('dm3'::text,r.dm3_sent), ('reply'::text,r.replied), ('meeting'::text,r.meeting), ('withdrawn'::text,r.withdrawn)) m(metric, ts))
          WHERE (m.ts IS NOT NULL)
        ), evmap(event, metric, field) AS (
         VALUES ('Connect sent'::text,'connect'::text,'connect_sent'::text), ('Accepted'::text,'accept'::text,'accepted'::text), ('DM1 sent'::text,'dm1'::text,'dm1_sent'::text), ('DM2 sent'::text,'dm2'::text,'dm2_sent'::text), ('DM3 sent'::text,'dm3'::text,'dm3_sent'::text), ('Replied'::text,'reply'::text,'replied'::text), ('Meeting'::text,'meeting'::text,'meeting'::text), ('Withdrawn'::text,'withdrawn'::text,'withdrawn'::text)
        ), lg AS (
         SELECT l.person_id,
            m.metric,
            min(l.ts) AS ts
           FROM (public.log_entries l
             JOIN evmap m ON ((m.event = l.event)))
          WHERE ((l.person_id IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
                   FROM public.log_entries u_1
                  WHERE ((u_1.person_id = l.person_id) AND (u_1.event = ('Undo '::text || m.field)) AND (u_1.ts >= l.ts))))))
          GROUP BY l.person_id, m.metric
        ), acct_meet_log AS (
         SELECT ( SELECT ra_1.account_key
                   FROM public.rpt_accounts ra_1
                  WHERE (l.detail ~~* (ra_1.account || '%'::text))
                  ORDER BY (length(ra_1.account)) DESC
                 LIMIT 1) AS account_key,
            min(l.ts) AS ts
           FROM public.log_entries l
          WHERE ((l.event = ANY (ARRAY['Meeting set'::text, 'Meeting'::text])) AND (l.person_id IS NULL))
          GROUP BY ( SELECT ra_1.account_key
                   FROM public.rpt_accounts ra_1
                  WHERE (l.detail ~~* (ra_1.account || '%'::text))
                  ORDER BY (length(ra_1.account)) DESC
                 LIMIT 1)
        ), unioned AS (
         SELECT c.person_id AS ref,
            c.person_id,
            c.account_key,
            c.metric,
            c.ts,
            'people'::text AS src
           FROM col c
        UNION ALL
         SELECT g.person_id,
            g.person_id,
            r.account_key,
            g.metric,
            g.ts,
            'log'::text
           FROM (lg g
             JOIN public.rpt_people r ON ((r.person_id = g.person_id)))
          WHERE (NOT (EXISTS ( SELECT 1
                   FROM col c
                  WHERE ((c.person_id = g.person_id) AND (c.metric = g.metric)))))
        UNION ALL
         SELECT x.account_key,
            NULL::text,
            x.account_key,
            'meeting'::text,
            x.ts,
            'log'::text
           FROM acct_meet_log x
          WHERE (x.account_key IS NOT NULL)
        UNION ALL
         SELECT ra_1.account_key,
            NULL::text,
            ra_1.account_key,
            'meeting'::text,
            COALESCE(((a.field_ts ->> 'meeting_status'::text))::timestamp with time zone, a.updated_at) AS "coalesce",
            'accounts'::text
           FROM (public.rpt_accounts ra_1
             JOIN public.accounts a ON ((a.id = ra_1.account_id)))
          WHERE ((COALESCE(a.meeting_status, ''::text) ~* '^(set|held)'::text) AND (NOT (EXISTS ( SELECT 1
                   FROM acct_meet_log x
                  WHERE (x.account_key = ra_1.account_key)))))
        UNION ALL
         SELECT lower(btrim(h.company)) AS lower,
            NULL::text,
            lower(btrim(h.company)) AS lower,
            m.metric,
            h.created_at,
            'stage_history'::text
           FROM (public.account_stage_history h
             CROSS JOIN LATERAL ( VALUES ('stage_change'::text), (
                        CASE
                            WHEN (h.source = 'shal'::text) THEN 'stage_manual'::text
                            ELSE NULL::text
                        END)) m(metric))
          WHERE ((h.kind <> 'backfill'::text) AND (h.undone_at IS NULL) AND (m.metric IS NOT NULL))
        UNION ALL
         SELECT lower(btrim(h.company)) AS lower,
            NULL::text,
            lower(btrim(h.company)) AS lower,
                CASE
                    WHEN (h.to_stage ~~* 'opp%'::text) THEN 'opp'::text
                    ELSE 'meeting'::text
                END AS "case",
            min(h.created_at) AS min,
            'stage_history'::text
           FROM public.account_stage_history h
          WHERE ((h.undone_at IS NULL) AND (h.kind <> 'backfill'::text) AND ((h.to_stage ~~* 'opp%'::text) OR (h.to_stage = 'Meeting set'::text)))
          GROUP BY (lower(btrim(h.company))),
                CASE
                    WHEN (h.to_stage ~~* 'opp%'::text) THEN 'opp'::text
                    ELSE 'meeting'::text
                END
        UNION ALL
         SELECT ra_1.account_key,
            NULL::text,
            ra_1.account_key,
            'opp'::text,
            ra_1.stage_since,
            'accounts'::text
           FROM public.rpt_accounts ra_1
          WHERE ((ra_1.stage ~~* 'opp%'::text) AND (ra_1.stage_since IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
                   FROM public.account_stage_history h
                  WHERE ((lower(btrim(h.company)) = ra_1.account_key) AND (h.to_stage ~~* 'opp%'::text) AND (h.undone_at IS NULL) AND (h.kind <> 'backfill'::text))))))
        UNION ALL
         SELECT ((r.person_id || ':'::text) || d.k),
            r.person_id,
            r.account_key,
            'draft'::text,
            ((r.field_ts ->> d.k))::timestamp with time zone AS timestamptz,
            'people'::text
           FROM (public.rpt_people r
             CROSS JOIN LATERAL ( VALUES ('dm'::text), ('dm2_text'::text), ('dm3_text'::text)) d(k))
          WHERE ((r.field_ts ? d.k) AND (COALESCE((to_jsonb(r.*) ->> d.k), ''::text) <> ''::text))
        UNION ALL
         SELECT ((l.person_id || ':log:'::text) || l.id),
            l.person_id,
            r.account_key,
            'draft'::text,
            l.ts,
            'log'::text
           FROM (public.log_entries l
             JOIN public.rpt_people r ON ((r.person_id = l.person_id)))
          WHERE ((l.event ~~* 'Hark draft%'::text) AND (NOT (EXISTS ( SELECT 1
                   FROM public.rpt_people r2
                  WHERE ((r2.person_id = l.person_id) AND (r2.field_ts ? 'dm'::text) AND (abs(EXTRACT(epoch FROM (((r2.field_ts ->> 'dm'::text))::timestamp with time zone - l.ts))) < (3600)::numeric))))))
        UNION ALL
         SELECT ('q:'::text || q.id),
            NULL::text,
            lower(btrim(q.target)) AS lower,
            'signal'::text,
            q.created,
            'queue'::text
           FROM public.queue q
          WHERE (q.action = ANY (ARRAY['New signal'::text, 'Claimable'::text]))
        UNION ALL
         SELECT ra_1.account_key,
            NULL::text,
            ra_1.account_key,
            'account_added'::text,
            ra_1.created_at,
            'accounts'::text
           FROM public.rpt_accounts ra_1
          WHERE ((ra_1.account_id IS NOT NULL) AND (ra_1.created_at > '2026-10-15 18:00:00+00'::timestamp with time zone))
        UNION ALL
         SELECT r.person_id,
            r.person_id,
            r.account_key,
            'person_added'::text,
            r.created_at,
            'people'::text
           FROM public.rpt_people r
          WHERE (r.created_at > '2026-10-15 18:00:00+00'::timestamp with time zone)
        ), dedup AS (
         SELECT unioned.ref,
            unioned.person_id,
            unioned.account_key,
            unioned.metric,
            unioned.ts,
            unioned.src
           FROM unioned
          WHERE (unioned.metric <> ALL (ARRAY['meeting'::text, 'opp'::text]))
        UNION ALL
         SELECT DISTINCT ON (unioned.metric, unioned.account_key) unioned.ref,
            unioned.person_id,
            unioned.account_key,
            unioned.metric,
            unioned.ts,
            unioned.src
           FROM unioned
          WHERE (unioned.metric = ANY (ARRAY['meeting'::text, 'opp'::text]))
  ORDER BY 4, 3, 5
        )
 SELECT u.metric,
    u.ref,
    u.person_id,
    u.account_key,
    u.ts,
    public.rpt_day(u.ts) AS day,
    u.src,
    COALESCE(rp.ae, ra.ae, 'Unassigned'::text) AS ae,
    COALESCE(rp.play, ra.play, 'Unassigned'::text) AS play,
    COALESCE(ra.stage, 'Target'::text) AS account_stage,
    COALESCE(ra.account, rp.account, u.account_key) AS account,
    rp.name AS person_name
   FROM ((dedup u
     LEFT JOIN public.rpt_people rp ON ((rp.person_id = u.person_id)))
     LEFT JOIN public.rpt_accounts ra ON ((ra.account_key = u.account_key)));


--
-- Name: rpt_filtered(date, date, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rpt_filtered(d_from date, d_to date, p_ae text DEFAULT NULL::text, p_play text DEFAULT NULL::text, p_stage text DEFAULT NULL::text, p_account text DEFAULT NULL::text) RETURNS SETOF public.rpt_events
    LANGUAGE plpgsql STABLE
    SET search_path TO 'public'
    AS $$
begin
  if coalesce(current_setting('ari.rpt_cache', true), '') = '1' and to_regclass('pg_temp.rpt_ev_cache') is not null then
    return query select e.* from pg_temp.rpt_ev_cache e
      where e.day between d_from and d_to
        and (p_ae is null or p_ae = '' or lower(e.ae) = lower(split_part(btrim(p_ae), ' ', 1)))
        and (p_play is null or p_play = '' or e.play ilike '%' || p_play || '%')
        and (p_stage is null or p_stage = '' or e.account_stage ilike p_stage || '%')
        and (p_account is null or p_account = '' or e.account ilike '%' || p_account || '%');
  else
    return query select e.* from public.rpt_events e
      where e.day between d_from and d_to
        and (p_ae is null or p_ae = '' or lower(e.ae) = lower(split_part(btrim(p_ae), ' ', 1)))
        and (p_play is null or p_play = '' or e.play ilike '%' || p_play || '%')
        and (p_stage is null or p_stage = '' or e.account_stage ilike p_stage || '%')
        and (p_account is null or p_account = '' or e.account ilike '%' || p_account || '%');
  end if;
end $$;


--
-- Name: rpt_range(text, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rpt_range(p_period text DEFAULT 'this_week'::text, p_from date DEFAULT NULL::date, p_to date DEFAULT NULL::date, OUT d_from date, OUT d_to date, OUT label text) RETURNS record
    LANGUAGE plpgsql STABLE
    AS $_$
declare t date := public.rpt_today(); per text := lower(coalesce(nullif(btrim(p_period), ''), 'this_week')); n int;
begin
  if p_from is not null or per = 'custom' then
    d_from := coalesce(p_from, date '2000-01-01'); d_to := coalesce(p_to, t); label := d_from || '..' || d_to; return;
  end if;
  label := per;
  if per = 'today' then d_from := t; d_to := t;
  elsif per = 'yesterday' then d_from := t - 1; d_to := t - 1;
  elsif per = 'this_week' then d_from := date_trunc('week', t)::date; d_to := d_from + 6;
  elsif per = 'last_week' then d_from := date_trunc('week', t)::date - 7; d_to := d_from + 6;
  elsif per = 'this_month' then d_from := date_trunc('month', t)::date; d_to := (date_trunc('month', t) + interval '1 month')::date - 1;
  elsif per = 'last_month' then d_from := (date_trunc('month', t) - interval '1 month')::date; d_to := date_trunc('month', t)::date - 1;
  elsif per = 'all' then d_from := date '2000-01-01'; d_to := t;
  elsif per ~ '^last_[0-9]+d$' then n := substring(per from '[0-9]+')::int; d_from := t - n + 1; d_to := t;
  elsif per ~ '^last_[0-9]+w$' then n := substring(per from '[0-9]+')::int; d_from := date_trunc('week', t)::date - 7 * (n - 1); d_to := date_trunc('week', t)::date + 6;
  else d_from := date_trunc('week', t)::date; d_to := d_from + 6; label := 'this_week';
  end if;
end $_$;


--
-- Name: rpt_today(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rpt_today() RETURNS date
    LANGUAGE sql STABLE
    AS $$ select (now() at time zone 'Asia/Kolkata')::date $$;


--
-- Name: rpt_unit(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rpt_unit(p_metric text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $$
  select case when p_metric in ('meeting', 'opp', 'stage_change', 'stage_manual', 'account_added') then 'account'
              when p_metric = 'signal' then 'signal' else 'person' end $$;


--
-- Name: touch_row(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_row() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare o jsonb; n jsonb; k text; ts jsonb;
begin
  if tg_op = 'INSERT' then
    new.updated_at := coalesce(new.updated_at, now());
    new.updated_by := coalesce(new.updated_by, public.current_actor());
    new.field_ts := coalesce(new.field_ts, '{}'::jsonb);
    return new;
  end if;
  o := to_jsonb(old); n := to_jsonb(new); ts := coalesce(new.field_ts, '{}'::jsonb);
  new.updated_at := now();
  if new.updated_by is not distinct from old.updated_by then new.updated_by := public.current_actor(); end if;
  for k in select jsonb_object_keys(n) loop
    if k not in ('updated_at','updated_by','field_ts','created_at','extra')
       and (n -> k) is distinct from (o -> k)
       and (ts ->> k) is not distinct from (old.field_ts ->> k) then
      ts := ts || jsonb_build_object(k, now());
    end if;
  end loop;
  new.field_ts := ts;
  return new;
end $$;


--
-- Name: account_briefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.account_briefs (
    account_id uuid NOT NULL,
    company text,
    status text DEFAULT 'queued'::text NOT NULL,
    thesis text,
    why_now jsonb DEFAULT '[]'::jsonb NOT NULL,
    data_flow jsonb DEFAULT '[]'::jsonb NOT NULL,
    committee jsonb DEFAULT '[]'::jsonb NOT NULL,
    angle text,
    soft_angles jsonb DEFAULT '[]'::jsonb NOT NULL,
    quick_check jsonb DEFAULT '[]'::jsonb NOT NULL,
    check_answers jsonb,
    checked_at timestamp with time zone,
    check_via text,
    sequences jsonb DEFAULT '[]'::jsonb NOT NULL,
    doc_url text,
    reviewed_at timestamp with time zone,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    built_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    CONSTRAINT account_briefs_check_via_check CHECK (((check_via IS NULL) OR (check_via = ANY (ARRAY['answered'::text, 'skip'::text])))),
    CONSTRAINT account_briefs_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'building'::text, 'ready'::text])))
);


--
-- Name: account_stage_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.account_stage_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: account_stage_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.account_stage_history_id_seq OWNED BY public.account_stage_history.id;


--
-- Name: app_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request text NOT NULL,
    diff_ref text,
    channel text DEFAULT 'preview'::text NOT NULL,
    approved_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT app_changes_channel_check CHECK ((channel = ANY (ARRAY['preview'::text, 'production'::text])))
);


--
-- Name: app_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_config (
    key text NOT NULL,
    value text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ari_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ari_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    body text NOT NULL,
    needs_you boolean DEFAULT false NOT NULL,
    action jsonb,
    read_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ari_prefs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ari_prefs (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text
);


--
-- Name: attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.attachments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    storage_path text NOT NULL,
    mime text,
    size integer,
    sha256 text
);


--
-- Name: book; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.book (
    key text NOT NULL,
    company text NOT NULL,
    owner text,
    tier text,
    flag text,
    cluster text,
    fit text,
    last_checked text,
    last_signal text,
    website text,
    play text,
    sheet_row integer,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brief; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brief (
    key text NOT NULL,
    value text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    field_ts jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: copy_guidance; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.copy_guidance (
    id bigint NOT NULL,
    account_id uuid,
    company text,
    person_id text,
    ae text,
    kind text NOT NULL,
    before text,
    after text,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: copy_guidance_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.copy_guidance ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.copy_guidance_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: decisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.decisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    question text NOT NULL,
    context text,
    options jsonb DEFAULT '[]'::jsonb NOT NULL,
    ari_opinion text,
    status text DEFAULT 'open'::text NOT NULL,
    answer text,
    answered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT decisions_status_check CHECK ((status = ANY (ARRAY['open'::text, 'answered'::text, 'applied'::text, 'expired'::text])))
);


--
-- Name: emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emails (
    id text NOT NULL,
    created timestamp with time zone,
    to_name text,
    to_email text,
    company text,
    subject text,
    body text,
    status text,
    extra jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text,
    field_ts jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.events (
    id bigint NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    actor text NOT NULL,
    verb text NOT NULL,
    person_id text,
    account_id uuid,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    prev_hash text,
    hash text,
    CONSTRAINT events_actor_check CHECK ((actor = ANY (ARRAY['you'::text, 'system'::text])))
);


--
-- Name: events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: log_entries_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.log_entries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.log_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id uuid,
    author text NOT NULL,
    body text NOT NULL,
    kind text DEFAULT 'text'::text NOT NULL,
    screen text,
    entity_type text,
    entity_id text,
    context jsonb DEFAULT '{}'::jsonb NOT NULL,
    tags jsonb DEFAULT '[]'::jsonb NOT NULL,
    task_id uuid,
    person_ids text[] DEFAULT '{}'::text[] NOT NULL,
    client_id text,
    status text DEFAULT 'sent'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT messages_author_check CHECK ((author = ANY (ARRAY['you'::text, 'ari'::text]))),
    CONSTRAINT messages_check CHECK (((entity_type IS NULL) = (entity_id IS NULL))),
    CONSTRAINT messages_entity_type_check CHECK ((entity_type = ANY (ARRAY['person'::text, 'account'::text, 'task'::text, 'decision'::text, 'note'::text, 'step'::text, 'screen'::text, 'app'::text]))),
    CONSTRAINT messages_kind_check CHECK ((kind = ANY (ARRAY['text'::text, 'voice'::text, 'media'::text, 'file'::text, 'task_card'::text]))),
    CONSTRAINT messages_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'seen'::text, 'answered'::text])))
);


--
-- Name: notifications_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.notifications ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.notifications_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: ops; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ops (
    op_id text NOT NULL,
    kind text NOT NULL,
    target_table text NOT NULL,
    target_id text,
    payload jsonb DEFAULT '{}'::jsonb NOT NULL,
    client_ts timestamp with time zone,
    device text,
    status text DEFAULT 'applied'::text NOT NULL,
    result jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ops_status_check CHECK ((status = ANY (ARRAY['applied'::text, 'partial'::text, 'stale'::text, 'error'::text])))
);


--
-- Name: plays; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plays (
    name text NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: push_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    endpoint text NOT NULL,
    p256dh text NOT NULL,
    auth text NOT NULL,
    platform text,
    user_agent text,
    device text,
    kinds text[] DEFAULT '{accepted,replied,meeting,research_done,draft_due,digest,test}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_ok_at timestamp with time zone,
    last_error text,
    failures integer DEFAULT 0 NOT NULL,
    revoked_at timestamp with time zone,
    browser text,
    standalone boolean,
    install_id text,
    active boolean DEFAULT true NOT NULL,
    paused_reason text,
    last_seen_at timestamp with time zone,
    last_rx_at timestamp with time zone,
    last_rx_tag text
);


--
-- Name: push_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.push_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token text NOT NULL,
    provider text DEFAULT 'expo'::text NOT NULL,
    platform text,
    device text,
    app_version text,
    kinds text[] DEFAULT '{accepted,replied,meeting,research_done,draft_due,digest,test}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_ok_at timestamp with time zone,
    last_error text,
    failures integer DEFAULT 0 NOT NULL,
    active boolean DEFAULT true NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.replies (
    id bigint NOT NULL,
    person_id text NOT NULL,
    account_id uuid,
    gmail_id text,
    source text DEFAULT 'gmail'::text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    msg_count integer,
    thread_url text,
    headline text,
    snippet text,
    snippet_source text DEFAULT 'none'::text NOT NULL,
    matched_by text,
    status text DEFAULT 'new'::text NOT NULL,
    drafts jsonb,
    drafted_at timestamp with time zone,
    answered_at timestamp with time zone,
    answer_body text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT replies_matched_by_check CHECK ((matched_by = ANY (ARRAY['profile_url'::text, 'name'::text, 'app'::text]))),
    CONSTRAINT replies_snippet_source_check CHECK ((snippet_source = ANY (ARRAY['email'::text, 'pasted'::text, 'none'::text]))),
    CONSTRAINT replies_source_check CHECK ((source = ANY (ARRAY['gmail'::text, 'app'::text, 'backfill'::text]))),
    CONSTRAINT replies_status_check CHECK ((status = ANY (ARRAY['new'::text, 'answered'::text, 'meeting'::text, 'dismissed'::text])))
);


--
-- Name: replies_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.replies_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: replies_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.replies_id_seq OWNED BY public.replies.id;


--
-- Name: research; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.research (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    person_id text,
    account_id uuid,
    source_url text NOT NULL,
    dated date,
    summary text NOT NULL,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT research_check CHECK (((person_id IS NOT NULL) OR (account_id IS NOT NULL)))
);


--
-- Name: scan_heartbeat; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scan_heartbeat (
    id integer DEFAULT 1 NOT NULL,
    last_scan_at timestamp with time zone,
    last_started_at timestamp with time zone,
    running boolean DEFAULT false NOT NULL,
    interval_sec integer DEFAULT 600 NOT NULL,
    anchor_at timestamp with time zone,
    next_scan_at timestamp with time zone,
    trigger text,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    checks text[] DEFAULT '{linkedin_emails,drafts,research,sheet}'::text[] NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT scan_heartbeat_id_check CHECK ((id = 1))
);


--
-- Name: sent_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sent_messages (
    id bigint NOT NULL,
    person_id text NOT NULL,
    account_id uuid,
    kind text NOT NULL,
    body text,
    sent_at timestamp with time zone DEFAULT now() NOT NULL,
    source text DEFAULT 'tick'::text NOT NULL,
    original_body text,
    edited_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sent_messages_kind_check CHECK ((kind = ANY (ARRAY['dm1'::text, 'dm2'::text, 'dm3'::text, 'reply'::text, 'note'::text]))),
    CONSTRAINT sent_messages_source_check CHECK ((source = ANY (ARRAY['tick'::text, 'edited'::text, 'backfill'::text])))
);


--
-- Name: sent_messages_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.sent_messages ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.sent_messages_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: sync_state; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sync_state (
    key text NOT NULL,
    value jsonb NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: targets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.targets (
    week date NOT NULL,
    metric text NOT NULL,
    min integer,
    max integer
);


--
-- Name: task_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.task_events (
    id bigint NOT NULL,
    task_id uuid NOT NULL,
    ts timestamp with time zone DEFAULT now() NOT NULL,
    step integer,
    text text NOT NULL
);


--
-- Name: task_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.task_events ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.task_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tasks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tasks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    origin text DEFAULT 'system'::text NOT NULL,
    thread_id uuid,
    status text DEFAULT 'queued'::text NOT NULL,
    steps text[] DEFAULT '{}'::text[] NOT NULL,
    current_step integer DEFAULT 0 NOT NULL,
    eta_minutes integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT tasks_origin_check CHECK ((origin = ANY (ARRAY['chat'::text, 'system'::text, 'wren'::text]))),
    CONSTRAINT tasks_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'running'::text, 'needs_you'::text, 'done'::text, 'failed'::text])))
);


--
-- Name: threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    entity_type text,
    entity_id text,
    title text NOT NULL,
    last_message_at timestamp with time zone,
    archived boolean DEFAULT false NOT NULL,
    CONSTRAINT threads_check CHECK (((kind = 'main'::text) = (entity_type IS NULL))),
    CONSTRAINT threads_entity_type_check CHECK ((entity_type = ANY (ARRAY['person'::text, 'account'::text, 'task'::text, 'decision'::text, 'note'::text, 'step'::text, 'screen'::text, 'app'::text]))),
    CONSTRAINT threads_kind_check CHECK ((kind = ANY (ARRAY['main'::text, 'item'::text])))
);


--
-- Name: weekly_metrics; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.weekly_metrics WITH (security_invoker='true') AS
 SELECT (date_trunc('week'::text, (ts AT TIME ZONE 'Asia/Kolkata'::text)))::date AS week,
    count(*) FILTER (WHERE (event = 'Connect sent'::text)) AS connects,
    count(*) FILTER (WHERE (event = 'Accepted'::text)) AS accepts,
    count(*) FILTER (WHERE (event = ANY (ARRAY['DM1 sent'::text, 'DM2 sent'::text, 'DM3 sent'::text]))) AS dms,
    count(*) FILTER (WHERE (event = 'Replied'::text)) AS replies,
    count(*) FILTER (WHERE (event = ANY (ARRAY['Meeting'::text, 'Meeting set'::text]))) AS meetings
   FROM public.log_entries
  GROUP BY ((date_trunc('week'::text, (ts AT TIME ZONE 'Asia/Kolkata'::text)))::date);


--
-- Name: account_stage_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_stage_history ALTER COLUMN id SET DEFAULT nextval('public.account_stage_history_id_seq'::regclass);


--
-- Name: replies id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies ALTER COLUMN id SET DEFAULT nextval('public.replies_id_seq'::regclass);


--
-- Name: account_briefs account_briefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_briefs
    ADD CONSTRAINT account_briefs_pkey PRIMARY KEY (account_id);


--
-- Name: account_stage_history account_stage_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_stage_history
    ADD CONSTRAINT account_stage_history_pkey PRIMARY KEY (id);


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (id);


--
-- Name: app_changes app_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_changes
    ADD CONSTRAINT app_changes_pkey PRIMARY KEY (id);


--
-- Name: app_config app_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_config
    ADD CONSTRAINT app_config_pkey PRIMARY KEY (key);


--
-- Name: ari_notes ari_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ari_notes
    ADD CONSTRAINT ari_notes_pkey PRIMARY KEY (id);


--
-- Name: ari_prefs ari_prefs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ari_prefs
    ADD CONSTRAINT ari_prefs_pkey PRIMARY KEY (key);


--
-- Name: attachments attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_pkey PRIMARY KEY (id);


--
-- Name: book book_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book
    ADD CONSTRAINT book_pkey PRIMARY KEY (key);


--
-- Name: brief brief_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brief
    ADD CONSTRAINT brief_pkey PRIMARY KEY (key);


--
-- Name: copy_guidance copy_guidance_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.copy_guidance
    ADD CONSTRAINT copy_guidance_pkey PRIMARY KEY (id);


--
-- Name: decisions decisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.decisions
    ADD CONSTRAINT decisions_pkey PRIMARY KEY (id);


--
-- Name: emails emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emails
    ADD CONSTRAINT emails_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: log_entries log_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_entries
    ADD CONSTRAINT log_entries_pkey PRIMARY KEY (id);


--
-- Name: log_entries log_entries_sheet_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_entries
    ADD CONSTRAINT log_entries_sheet_key_key UNIQUE (sheet_key);


--
-- Name: messages messages_client_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_client_id_key UNIQUE (client_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: notifications notifications_dedupe_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_dedupe_key_key UNIQUE (dedupe_key);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: ops ops_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ops
    ADD CONSTRAINT ops_pkey PRIMARY KEY (op_id);


--
-- Name: people people_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_pkey PRIMARY KEY (id);


--
-- Name: plays plays_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plays
    ADD CONSTRAINT plays_pkey PRIMARY KEY (name);


--
-- Name: push_subscriptions push_subscriptions_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint);


--
-- Name: push_subscriptions push_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_subscriptions
    ADD CONSTRAINT push_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: push_tokens push_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_tokens
    ADD CONSTRAINT push_tokens_pkey PRIMARY KEY (id);


--
-- Name: push_tokens push_tokens_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.push_tokens
    ADD CONSTRAINT push_tokens_token_key UNIQUE (token);


--
-- Name: queue queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.queue
    ADD CONSTRAINT queue_pkey PRIMARY KEY (id);


--
-- Name: replies replies_gmail_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_gmail_id_key UNIQUE (gmail_id);


--
-- Name: replies replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_pkey PRIMARY KEY (id);


--
-- Name: research research_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research
    ADD CONSTRAINT research_pkey PRIMARY KEY (id);


--
-- Name: scan_heartbeat scan_heartbeat_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scan_heartbeat
    ADD CONSTRAINT scan_heartbeat_pkey PRIMARY KEY (id);


--
-- Name: sent_messages sent_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sent_messages
    ADD CONSTRAINT sent_messages_pkey PRIMARY KEY (id);


--
-- Name: sync_state sync_state_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sync_state
    ADD CONSTRAINT sync_state_pkey PRIMARY KEY (key);


--
-- Name: targets targets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.targets
    ADD CONSTRAINT targets_pkey PRIMARY KEY (week, metric);


--
-- Name: task_events task_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_events
    ADD CONSTRAINT task_events_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: threads threads_entity_type_entity_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_entity_type_entity_id_key UNIQUE (entity_type, entity_id);


--
-- Name: threads threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads
    ADD CONSTRAINT threads_pkey PRIMARY KEY (id);


--
-- Name: account_briefs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX account_briefs_status ON public.account_briefs USING btree (status, requested_at DESC);


--
-- Name: accounts_company_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX accounts_company_key ON public.accounts USING btree (lower(btrim(company)));


--
-- Name: ash_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ash_account ON public.account_stage_history USING btree (account_id, created_at DESC);


--
-- Name: copy_guidance_ae; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX copy_guidance_ae ON public.copy_guidance USING btree (ae, created_at DESC);


--
-- Name: events_person_id_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX events_person_id_ts_idx ON public.events USING btree (person_id, ts);


--
-- Name: log_entries_person_id_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX log_entries_person_id_ts_idx ON public.log_entries USING btree (person_id, ts);


--
-- Name: log_entries_ts_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX log_entries_ts_idx ON public.log_entries USING btree (ts);


--
-- Name: messages_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_created_at_idx ON public.messages USING btree (created_at);


--
-- Name: messages_entity_type_entity_id_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_entity_type_entity_id_created_at_idx ON public.messages USING btree (entity_type, entity_id, created_at);


--
-- Name: messages_tags_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messages_tags_idx ON public.messages USING gin (tags jsonb_path_ops);


--
-- Name: notifications_unsent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX notifications_unsent ON public.notifications USING btree (id) WHERE (sent_at IS NULL);


--
-- Name: ops_created_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ops_created_at_idx ON public.ops USING btree (created_at);


--
-- Name: people_account_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_account_id_idx ON public.people USING btree (account_id);


--
-- Name: people_review_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_review_idx ON public.people USING btree (review);


--
-- Name: people_stage_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_stage_idx ON public.people USING btree (stage);


--
-- Name: people_updated_at_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX people_updated_at_idx ON public.people USING btree (updated_at);


--
-- Name: queue_status_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX queue_status_created_idx ON public.queue USING btree (status, created);


--
-- Name: replies_open_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replies_open_idx ON public.replies USING btree (status, received_at DESC);


--
-- Name: replies_person_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX replies_person_idx ON public.replies USING btree (person_id);


--
-- Name: sent_messages_one_dm; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX sent_messages_one_dm ON public.sent_messages USING btree (person_id, kind) WHERE (kind = ANY (ARRAY['dm1'::text, 'dm2'::text, 'dm3'::text]));


--
-- Name: sent_messages_person; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sent_messages_person ON public.sent_messages USING btree (person_id, sent_at);


--
-- Name: threads_one_main; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX threads_one_main ON public.threads USING btree (kind) WHERE (kind = 'main'::text);


--
-- Name: account_briefs account_briefs_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_briefs_notify AFTER INSERT OR UPDATE OF status ON public.account_briefs FOR EACH ROW EXECUTE FUNCTION public.account_briefs_notify();


--
-- Name: account_briefs account_briefs_touch; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER account_briefs_touch BEFORE INSERT OR UPDATE ON public.account_briefs FOR EACH ROW EXECUTE FUNCTION public.account_briefs_touch();


--
-- Name: accounts accounts_meeting_events; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_meeting_events AFTER UPDATE OF meeting_status ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.accounts_meeting_events();


--
-- Name: accounts accounts_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_notify AFTER INSERT OR UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.accounts_notify();


--
-- Name: accounts accounts_stage_guard; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER accounts_stage_guard BEFORE INSERT OR UPDATE OF stage ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.accounts_stage_guard();


--
-- Name: events events_chain; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER events_chain BEFORE INSERT ON public.events FOR EACH ROW EXECUTE FUNCTION public.events_chain();


--
-- Name: notifications notifications_kick; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER notifications_kick AFTER INSERT ON public.notifications FOR EACH STATEMENT EXECUTE FUNCTION public.notifications_kick();


--
-- Name: people people_copy_guidance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER people_copy_guidance AFTER UPDATE OF dm, dm2_text, dm3_text ON public.people FOR EACH ROW EXECUTE FUNCTION public.people_copy_guidance();


--
-- Name: people people_notify; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER people_notify AFTER INSERT OR UPDATE ON public.people FOR EACH ROW EXECUTE FUNCTION public.people_notify();


--
-- Name: people people_sent_snapshot; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER people_sent_snapshot AFTER INSERT OR UPDATE OF dm1_sent, dm2_sent, dm3_sent ON public.people FOR EACH ROW EXECUTE FUNCTION public.people_sent_snapshot();


--
-- Name: people people_stage_events; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER people_stage_events AFTER INSERT OR UPDATE ON public.people FOR EACH ROW EXECUTE FUNCTION public.people_stage_events();


--
-- Name: people people_stage_ts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER people_stage_ts BEFORE INSERT OR UPDATE ON public.people FOR EACH ROW EXECUTE FUNCTION public.people_stage_ts();


--
-- Name: queue queue_stage_events; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER queue_stage_events AFTER INSERT ON public.queue FOR EACH ROW EXECUTE FUNCTION public.queue_stage_events();


--
-- Name: accounts touch_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.accounts FOR EACH ROW EXECUTE FUNCTION public.touch_row();


--
-- Name: brief touch_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.brief FOR EACH ROW EXECUTE FUNCTION public.touch_row();


--
-- Name: emails touch_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.emails FOR EACH ROW EXECUTE FUNCTION public.touch_row();


--
-- Name: people touch_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.people FOR EACH ROW EXECUTE FUNCTION public.touch_row();


--
-- Name: queue touch_row; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER touch_row BEFORE INSERT OR UPDATE ON public.queue FOR EACH ROW EXECUTE FUNCTION public.touch_row();


--
-- Name: account_briefs account_briefs_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_briefs
    ADD CONSTRAINT account_briefs_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: account_stage_history account_stage_history_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.account_stage_history
    ADD CONSTRAINT account_stage_history_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: accounts accounts_play_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.accounts
    ADD CONSTRAINT accounts_play_fkey FOREIGN KEY (play) REFERENCES public.plays(name) ON UPDATE CASCADE;


--
-- Name: attachments attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.attachments
    ADD CONSTRAINT attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: book book_play_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.book
    ADD CONSTRAINT book_play_fkey FOREIGN KEY (play) REFERENCES public.plays(name) ON UPDATE CASCADE;


--
-- Name: messages messages_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE SET NULL;


--
-- Name: messages messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE SET NULL;


--
-- Name: people people_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE SET NULL;


--
-- Name: people people_play_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.people
    ADD CONSTRAINT people_play_fkey FOREIGN KEY (play) REFERENCES public.plays(name) ON UPDATE CASCADE;


--
-- Name: replies replies_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.replies
    ADD CONSTRAINT replies_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id);


--
-- Name: research research_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research
    ADD CONSTRAINT research_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.accounts(id) ON DELETE CASCADE;


--
-- Name: research research_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.research
    ADD CONSTRAINT research_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;


--
-- Name: sent_messages sent_messages_person_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sent_messages
    ADD CONSTRAINT sent_messages_person_id_fkey FOREIGN KEY (person_id) REFERENCES public.people(id) ON DELETE CASCADE;


--
-- Name: task_events task_events_task_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.task_events
    ADD CONSTRAINT task_events_task_id_fkey FOREIGN KEY (task_id) REFERENCES public.tasks(id) ON DELETE CASCADE;


--
-- Name: tasks tasks_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tasks
    ADD CONSTRAINT tasks_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.threads(id) ON DELETE SET NULL;


--
-- Name: account_briefs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_briefs ENABLE ROW LEVEL SECURITY;

--
-- Name: account_stage_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.account_stage_history ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: app_changes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_changes ENABLE ROW LEVEL SECURITY;

--
-- Name: app_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_config ENABLE ROW LEVEL SECURITY;

--
-- Name: ari_notes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ari_notes ENABLE ROW LEVEL SECURITY;

--
-- Name: ari_prefs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ari_prefs ENABLE ROW LEVEL SECURITY;

--
-- Name: attachments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.attachments ENABLE ROW LEVEL SECURITY;

--
-- Name: book; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.book ENABLE ROW LEVEL SECURITY;

--
-- Name: brief; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.brief ENABLE ROW LEVEL SECURITY;

--
-- Name: copy_guidance; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.copy_guidance ENABLE ROW LEVEL SECURITY;

--
-- Name: decisions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.decisions ENABLE ROW LEVEL SECURITY;

--
-- Name: emails; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.emails ENABLE ROW LEVEL SECURITY;

--
-- Name: events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;

--
-- Name: log_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.log_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: ops; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ops ENABLE ROW LEVEL SECURITY;

--
-- Name: accounts owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.accounts TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: app_changes owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.app_changes TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: ari_notes owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.ari_notes TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: attachments owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.attachments TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: book owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.book TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: brief owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.brief TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: decisions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.decisions TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: emails owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.emails TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: messages owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.messages TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: ops owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.ops TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: people owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.people TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: plays owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.plays TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: push_subscriptions owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.push_subscriptions TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: push_tokens owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.push_tokens TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: queue owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.queue TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: research owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.research TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: targets owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.targets TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: task_events owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.task_events TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: tasks owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.tasks TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: threads owner_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_all ON public.threads TO authenticated USING (( SELECT public.is_owner() AS is_owner)) WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: events owner_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_insert ON public.events FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: log_entries owner_insert; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_insert ON public.log_entries FOR INSERT TO authenticated WITH CHECK (( SELECT public.is_owner() AS is_owner));


--
-- Name: account_briefs owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.account_briefs FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: account_stage_history owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.account_stage_history FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: app_config owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.app_config FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: ari_prefs owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.ari_prefs FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: copy_guidance owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.copy_guidance FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: events owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.events FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: log_entries owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.log_entries FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: notifications owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.notifications FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: replies owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.replies FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: scan_heartbeat owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.scan_heartbeat FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: sent_messages owner_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY owner_read ON public.sent_messages FOR SELECT TO authenticated USING (( SELECT public.is_owner() AS is_owner));


--
-- Name: people; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.people ENABLE ROW LEVEL SECURITY;

--
-- Name: plays; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plays ENABLE ROW LEVEL SECURITY;

--
-- Name: push_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: push_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.queue ENABLE ROW LEVEL SECURITY;

--
-- Name: replies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.replies ENABLE ROW LEVEL SECURITY;

--
-- Name: research; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.research ENABLE ROW LEVEL SECURITY;

--
-- Name: scan_heartbeat; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scan_heartbeat ENABLE ROW LEVEL SECURITY;

--
-- Name: sent_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sent_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: sync_state; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.sync_state ENABLE ROW LEVEL SECURITY;

--
-- Name: targets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.targets ENABLE ROW LEVEL SECURITY;

--
-- Name: task_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.task_events ENABLE ROW LEVEL SECURITY;

--
-- Name: tasks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

--
-- Name: threads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION account_briefs_notify(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.account_briefs_notify() TO anon;
GRANT ALL ON FUNCTION public.account_briefs_notify() TO authenticated;
GRANT ALL ON FUNCTION public.account_briefs_notify() TO service_role;


--
-- Name: FUNCTION account_briefs_touch(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.account_briefs_touch() TO anon;
GRANT ALL ON FUNCTION public.account_briefs_touch() TO authenticated;
GRANT ALL ON FUNCTION public.account_briefs_touch() TO service_role;


--
-- Name: FUNCTION account_health(p_ae text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.account_health(p_ae text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.account_health(p_ae text) TO authenticated;
GRANT ALL ON FUNCTION public.account_health(p_ae text) TO service_role;


--
-- Name: FUNCTION accounts_meeting_events(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.accounts_meeting_events() TO anon;
GRANT ALL ON FUNCTION public.accounts_meeting_events() TO authenticated;
GRANT ALL ON FUNCTION public.accounts_meeting_events() TO service_role;


--
-- Name: FUNCTION accounts_notify(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.accounts_notify() TO anon;
GRANT ALL ON FUNCTION public.accounts_notify() TO authenticated;
GRANT ALL ON FUNCTION public.accounts_notify() TO service_role;


--
-- Name: FUNCTION accounts_stage_guard(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.accounts_stage_guard() TO anon;
GRANT ALL ON FUNCTION public.accounts_stage_guard() TO authenticated;
GRANT ALL ON FUNCTION public.accounts_stage_guard() TO service_role;


--
-- Name: FUNCTION accounts_worked(p_from date, p_to date, p_ae text, p_play text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accounts_worked(p_from date, p_to date, p_ae text, p_play text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accounts_worked(p_from date, p_to date, p_ae text, p_play text) TO authenticated;
GRANT ALL ON FUNCTION public.accounts_worked(p_from date, p_to date, p_ae text, p_play text) TO service_role;


--
-- Name: FUNCTION apply_op(p_op_id text, p_kind text, p_table text, p_id text, p_patch jsonb, p_client_ts timestamp with time zone, p_device text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.apply_op(p_op_id text, p_kind text, p_table text, p_id text, p_patch jsonb, p_client_ts timestamp with time zone, p_device text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.apply_op(p_op_id text, p_kind text, p_table text, p_id text, p_patch jsonb, p_client_ts timestamp with time zone, p_device text) TO authenticated;
GRANT ALL ON FUNCTION public.apply_op(p_op_id text, p_kind text, p_table text, p_id text, p_patch jsonb, p_client_ts timestamp with time zone, p_device text) TO service_role;


--
-- Name: FUNCTION ari_account_implied(p_account uuid, OUT stage text, OUT reason text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_account_implied(p_account uuid, OUT stage text, OUT reason text) TO anon;
GRANT ALL ON FUNCTION public.ari_account_implied(p_account uuid, OUT stage text, OUT reason text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_account_implied(p_account uuid, OUT stage text, OUT reason text) TO service_role;


--
-- Name: FUNCTION ari_account_move(p_account uuid, p_to text, p_source text, p_kind text, p_reason text, p_undo_of bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_account_move(p_account uuid, p_to text, p_source text, p_kind text, p_reason text, p_undo_of bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_account_move(p_account uuid, p_to text, p_source text, p_kind text, p_reason text, p_undo_of bigint) TO service_role;


--
-- Name: FUNCTION ari_account_stage_backfill(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_account_stage_backfill() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_account_stage_backfill() TO service_role;


--
-- Name: FUNCTION ari_account_stage_reconcile(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_account_stage_reconcile() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_account_stage_reconcile() TO service_role;


--
-- Name: FUNCTION ari_activity(p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_activity(p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.ari_activity(p_limit integer) TO service_role;


--
-- Name: FUNCTION ari_autoadvance(p_account uuid, p_to text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_autoadvance(p_account uuid, p_to text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_autoadvance(p_account uuid, p_to text, p_reason text) TO service_role;


--
-- Name: FUNCTION ari_brief_check(p_account_id uuid, p_answers jsonb, p_via text, p_reset boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_brief_check(p_account_id uuid, p_answers jsonb, p_via text, p_reset boolean) TO authenticated;
GRANT ALL ON FUNCTION public.ari_brief_check(p_account_id uuid, p_answers jsonb, p_via text, p_reset boolean) TO service_role;


--
-- Name: FUNCTION ari_brief_request(p_account_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_brief_request(p_account_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.ari_brief_request(p_account_id uuid) TO service_role;


--
-- Name: FUNCTION ari_brief_reviewed(p_account_id uuid, p_on boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_brief_reviewed(p_account_id uuid, p_on boolean) TO authenticated;
GRANT ALL ON FUNCTION public.ari_brief_reviewed(p_account_id uuid, p_on boolean) TO service_role;


--
-- Name: TABLE notifications; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.notifications TO authenticated;
GRANT ALL ON TABLE public.notifications TO service_role;


--
-- Name: FUNCTION ari_claim_notifications(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_claim_notifications(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_claim_notifications(p_limit integer) TO service_role;


--
-- Name: FUNCTION ari_due_digest(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_due_digest() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_due_digest() TO service_role;


--
-- Name: FUNCTION ari_finish_notifications(p_ids bigint[], p_delivered integer, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_finish_notifications(p_ids bigint[], p_delivered integer, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_finish_notifications(p_ids bigint[], p_delivered integer, p_error text) TO service_role;


--
-- Name: FUNCTION ari_lead_count(p_account uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_lead_count(p_account uuid) TO anon;
GRANT ALL ON FUNCTION public.ari_lead_count(p_account uuid) TO authenticated;
GRANT ALL ON FUNCTION public.ari_lead_count(p_account uuid) TO service_role;


--
-- Name: FUNCTION ari_notify(p_kind text, p_key text, p_title text, p_body text, p_url text, p_person text, p_account uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_notify(p_kind text, p_key text, p_title text, p_body text, p_url text, p_person text, p_account uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_notify(p_kind text, p_key text, p_title text, p_body text, p_url text, p_person text, p_account uuid) TO service_role;


--
-- Name: FUNCTION ari_people_account(p_account uuid, p_company text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_people_account(p_account uuid, p_company text) TO anon;
GRANT ALL ON FUNCTION public.ari_people_account(p_account uuid, p_company text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_people_account(p_account uuid, p_company text) TO service_role;


--
-- Name: FUNCTION ari_pref(p_key text, p_default jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_pref(p_key text, p_default jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_pref(p_key text, p_default jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.ari_pref(p_key text, p_default jsonb) TO service_role;


--
-- Name: FUNCTION ari_pref_set(p_key text, p_value jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_pref_set(p_key text, p_value jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_pref_set(p_key text, p_value jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.ari_pref_set(p_key text, p_value jsonb) TO service_role;


--
-- Name: FUNCTION ari_push_ack(p_endpoint text, p_tag text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_push_ack(p_endpoint text, p_tag text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_push_ack(p_endpoint text, p_tag text) TO anon;
GRANT ALL ON FUNCTION public.ari_push_ack(p_endpoint text, p_tag text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_push_ack(p_endpoint text, p_tag text) TO service_role;


--
-- Name: FUNCTION ari_push_config(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_push_config() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_push_config() TO service_role;


--
-- Name: FUNCTION ari_push_kick(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_push_kick() FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_push_kick() TO service_role;


--
-- Name: FUNCTION ari_replies_open(p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_replies_open(p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_replies_open(p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.ari_replies_open(p_limit integer) TO service_role;


--
-- Name: FUNCTION ari_reply_done(p_id bigint, p_outcome text, p_body text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_reply_done(p_id bigint, p_outcome text, p_body text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_reply_done(p_id bigint, p_outcome text, p_body text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_reply_done(p_id bigint, p_outcome text, p_body text) TO service_role;


--
-- Name: FUNCTION ari_reply_paste(p_id bigint, p_text text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_reply_paste(p_id bigint, p_text text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_reply_paste(p_id bigint, p_text text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_reply_paste(p_id bigint, p_text text) TO service_role;


--
-- Name: FUNCTION ari_sent_delete(p_id bigint); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_sent_delete(p_id bigint) TO authenticated;
GRANT ALL ON FUNCTION public.ari_sent_delete(p_id bigint) TO service_role;


--
-- Name: FUNCTION ari_sent_edit(p_id bigint, p_body text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_sent_edit(p_id bigint, p_body text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_sent_edit(p_id bigint, p_body text) TO service_role;


--
-- Name: FUNCTION ari_sent_log(p_person_id text, p_kind text, p_body text, p_sent_at timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_sent_log(p_person_id text, p_kind text, p_body text, p_sent_at timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.ari_sent_log(p_person_id text, p_kind text, p_body text, p_sent_at timestamp with time zone) TO service_role;


--
-- Name: FUNCTION ari_set_account_stage(p_account text, p_stage text, p_op_id text, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_set_account_stage(p_account text, p_stage text, p_op_id text, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_set_account_stage(p_account text, p_stage text, p_op_id text, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_set_account_stage(p_account text, p_stage text, p_op_id text, p_reason text) TO service_role;


--
-- Name: FUNCTION ari_stage_norm(s text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_stage_norm(s text) TO anon;
GRANT ALL ON FUNCTION public.ari_stage_norm(s text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_stage_norm(s text) TO service_role;


--
-- Name: FUNCTION ari_stage_rank(s text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.ari_stage_rank(s text) TO anon;
GRANT ALL ON FUNCTION public.ari_stage_rank(s text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_stage_rank(s text) TO service_role;


--
-- Name: FUNCTION ari_stage_undo(p_history_id bigint); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_stage_undo(p_history_id bigint) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_stage_undo(p_history_id bigint) TO authenticated;
GRANT ALL ON FUNCTION public.ari_stage_undo(p_history_id bigint) TO service_role;


--
-- Name: FUNCTION ari_stale(p_ae text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_stale(p_ae text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_stale(p_ae text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_stale(p_ae text) TO service_role;


--
-- Name: FUNCTION ari_subscription_result(p_id uuid, p_ok boolean, p_status integer, p_error text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_subscription_result(p_id uuid, p_ok boolean, p_status integer, p_error text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_subscription_result(p_id uuid, p_ok boolean, p_status integer, p_error text) TO service_role;


--
-- Name: FUNCTION ari_test_ping(p_note text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_test_ping(p_note text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_test_ping(p_note text) TO authenticated;
GRANT ALL ON FUNCTION public.ari_test_ping(p_note text) TO service_role;


--
-- Name: FUNCTION ari_today15(p_day date, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_today15(p_day date, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_today15(p_day date, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.ari_today15(p_day date, p_limit integer) TO service_role;


--
-- Name: FUNCTION ari_today15_meta(p_day date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_today15_meta(p_day date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_today15_meta(p_day date) TO authenticated;
GRANT ALL ON FUNCTION public.ari_today15_meta(p_day date) TO service_role;


--
-- Name: FUNCTION ari_today_top(p_day date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_today_top(p_day date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_today_top(p_day date) TO authenticated;
GRANT ALL ON FUNCTION public.ari_today_top(p_day date) TO service_role;


--
-- Name: FUNCTION ari_token_result(p_id uuid, p_ok boolean, p_error text, p_unregistered boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_token_result(p_id uuid, p_ok boolean, p_error text, p_unregistered boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_token_result(p_id uuid, p_ok boolean, p_error text, p_unregistered boolean) TO service_role;


--
-- Name: FUNCTION ari_weekly_digest(p_dry boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ari_weekly_digest(p_dry boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ari_weekly_digest(p_dry boolean) TO service_role;


--
-- Name: FUNCTION current_actor(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.current_actor() TO anon;
GRANT ALL ON FUNCTION public.current_actor() TO authenticated;
GRANT ALL ON FUNCTION public.current_actor() TO service_role;


--
-- Name: FUNCTION events_chain(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.events_chain() TO anon;
GRANT ALL ON FUNCTION public.events_chain() TO authenticated;
GRANT ALL ON FUNCTION public.events_chain() TO service_role;


--
-- Name: FUNCTION hark_exec(sql text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hark_exec(sql text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hark_exec(sql text) TO service_role;


--
-- Name: FUNCTION hark_query(sql text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hark_query(sql text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hark_query(sql text) TO service_role;


--
-- Name: FUNCTION hark_time(sql text, n integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.hark_time(sql text, n integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.hark_time(sql text, n integer) TO service_role;


--
-- Name: FUNCTION is_owner(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_owner() TO anon;
GRANT ALL ON FUNCTION public.is_owner() TO authenticated;
GRANT ALL ON FUNCTION public.is_owner() TO service_role;


--
-- Name: FUNCTION notifications_kick(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.notifications_kick() TO anon;
GRANT ALL ON FUNCTION public.notifications_kick() TO authenticated;
GRANT ALL ON FUNCTION public.notifications_kick() TO service_role;


--
-- Name: FUNCTION people_copy_guidance(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.people_copy_guidance() TO anon;
GRANT ALL ON FUNCTION public.people_copy_guidance() TO authenticated;
GRANT ALL ON FUNCTION public.people_copy_guidance() TO service_role;


--
-- Name: FUNCTION people_notify(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.people_notify() TO anon;
GRANT ALL ON FUNCTION public.people_notify() TO authenticated;
GRANT ALL ON FUNCTION public.people_notify() TO service_role;


--
-- Name: FUNCTION people_sent_snapshot(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.people_sent_snapshot() TO anon;
GRANT ALL ON FUNCTION public.people_sent_snapshot() TO authenticated;
GRANT ALL ON FUNCTION public.people_sent_snapshot() TO service_role;


--
-- Name: FUNCTION people_stage_events(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.people_stage_events() TO anon;
GRANT ALL ON FUNCTION public.people_stage_events() TO authenticated;
GRANT ALL ON FUNCTION public.people_stage_events() TO service_role;


--
-- Name: FUNCTION people_stage_ts(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.people_stage_ts() TO anon;
GRANT ALL ON FUNCTION public.people_stage_ts() TO authenticated;
GRANT ALL ON FUNCTION public.people_stage_ts() TO service_role;


--
-- Name: FUNCTION push_device_set(p_id uuid, p_action text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.push_device_set(p_id uuid, p_action text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.push_device_set(p_id uuid, p_action text) TO authenticated;
GRANT ALL ON FUNCTION public.push_device_set(p_id uuid, p_action text) TO service_role;


--
-- Name: FUNCTION push_devices(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.push_devices() FROM PUBLIC;
GRANT ALL ON FUNCTION public.push_devices() TO authenticated;
GRANT ALL ON FUNCTION public.push_devices() TO service_role;


--
-- Name: FUNCTION queue_stage_events(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.queue_stage_events() TO anon;
GRANT ALL ON FUNCTION public.queue_stage_events() TO authenticated;
GRANT ALL ON FUNCTION public.queue_stage_events() TO service_role;


--
-- Name: FUNCTION register_push(p_endpoint text, p_p256dh text, p_auth text, p_platform text, p_device text, p_user_agent text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.register_push(p_endpoint text, p_p256dh text, p_auth text, p_platform text, p_device text, p_user_agent text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_push(p_endpoint text, p_p256dh text, p_auth text, p_platform text, p_device text, p_user_agent text) TO authenticated;
GRANT ALL ON FUNCTION public.register_push(p_endpoint text, p_p256dh text, p_auth text, p_platform text, p_device text, p_user_agent text) TO service_role;


--
-- Name: FUNCTION register_push2(p_endpoint text, p_p256dh text, p_auth text, p_platform text, p_device text, p_user_agent text, p_browser text, p_standalone boolean, p_install_id text, p_explicit boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.register_push2(p_endpoint text, p_p256dh text, p_auth text, p_platform text, p_device text, p_user_agent text, p_browser text, p_standalone boolean, p_install_id text, p_explicit boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_push2(p_endpoint text, p_p256dh text, p_auth text, p_platform text, p_device text, p_user_agent text, p_browser text, p_standalone boolean, p_install_id text, p_explicit boolean) TO authenticated;
GRANT ALL ON FUNCTION public.register_push2(p_endpoint text, p_p256dh text, p_auth text, p_platform text, p_device text, p_user_agent text, p_browser text, p_standalone boolean, p_install_id text, p_explicit boolean) TO service_role;


--
-- Name: FUNCTION register_push_token(p_token text, p_platform text, p_device text, p_app_version text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.register_push_token(p_token text, p_platform text, p_device text, p_app_version text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.register_push_token(p_token text, p_platform text, p_device text, p_app_version text) TO authenticated;
GRANT ALL ON FUNCTION public.register_push_token(p_token text, p_platform text, p_device text, p_app_version text) TO service_role;


--
-- Name: FUNCTION report_dashboard(p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text, p_part text, p_prev_from date, p_prev_to date, p_days integer, p_heat_days integer, p_aw_from date, p_aw_to date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.report_dashboard(p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text, p_part text, p_prev_from date, p_prev_to date, p_days integer, p_heat_days integer, p_aw_from date, p_aw_to date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_dashboard(p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text, p_part text, p_prev_from date, p_prev_to date, p_days integer, p_heat_days integer, p_aw_from date, p_aw_to date) TO authenticated;
GRANT ALL ON FUNCTION public.report_dashboard(p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text, p_part text, p_prev_from date, p_prev_to date, p_days integer, p_heat_days integer, p_aw_from date, p_aw_to date) TO service_role;


--
-- Name: FUNCTION report_hooks(p_period text, p_from date, p_to date, p_ae text, p_play text, p_min_sent integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.report_hooks(p_period text, p_from date, p_to date, p_ae text, p_play text, p_min_sent integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_hooks(p_period text, p_from date, p_to date, p_ae text, p_play text, p_min_sent integer) TO authenticated;
GRANT ALL ON FUNCTION public.report_hooks(p_period text, p_from date, p_to date, p_ae text, p_play text, p_min_sent integer) TO service_role;


--
-- Name: FUNCTION report_rows(p_metric text, p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text, p_account text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.report_rows(p_metric text, p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text, p_account text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_rows(p_metric text, p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text, p_account text) TO authenticated;
GRANT ALL ON FUNCTION public.report_rows(p_metric text, p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text, p_account text) TO service_role;


--
-- Name: FUNCTION report_series(p_metric text, p_bucket text, p_n integer, p_ae text, p_play text, p_stage text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.report_series(p_metric text, p_bucket text, p_n integer, p_ae text, p_play text, p_stage text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_series(p_metric text, p_bucket text, p_n integer, p_ae text, p_play text, p_stage text) TO authenticated;
GRANT ALL ON FUNCTION public.report_series(p_metric text, p_bucket text, p_n integer, p_ae text, p_play text, p_stage text) TO service_role;


--
-- Name: FUNCTION report_stage_times(p_ae text, p_play text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.report_stage_times(p_ae text, p_play text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_stage_times(p_ae text, p_play text) TO authenticated;
GRANT ALL ON FUNCTION public.report_stage_times(p_ae text, p_play text) TO service_role;


--
-- Name: FUNCTION report_summary(p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.report_summary(p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.report_summary(p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text) TO authenticated;
GRANT ALL ON FUNCTION public.report_summary(p_period text, p_from date, p_to date, p_ae text, p_play text, p_stage text) TO service_role;


--
-- Name: FUNCTION rpt_day(t timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rpt_day(t timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rpt_day(t timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.rpt_day(t timestamp with time zone) TO service_role;


--
-- Name: TABLE account_stage_history; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.account_stage_history TO authenticated;
GRANT ALL ON TABLE public.account_stage_history TO service_role;


--
-- Name: TABLE accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.accounts TO authenticated;
GRANT ALL ON TABLE public.accounts TO service_role;


--
-- Name: TABLE log_entries; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.log_entries TO authenticated;
GRANT ALL ON TABLE public.log_entries TO service_role;


--
-- Name: SEQUENCE people_app_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.people_app_seq TO authenticated;
GRANT ALL ON SEQUENCE public.people_app_seq TO service_role;


--
-- Name: TABLE people; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.people TO authenticated;
GRANT ALL ON TABLE public.people TO service_role;


--
-- Name: SEQUENCE queue_app_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.queue_app_seq TO authenticated;
GRANT ALL ON SEQUENCE public.queue_app_seq TO service_role;


--
-- Name: TABLE queue; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.queue TO authenticated;
GRANT ALL ON TABLE public.queue TO service_role;


--
-- Name: TABLE rpt_people; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rpt_people TO authenticated;
GRANT ALL ON TABLE public.rpt_people TO service_role;


--
-- Name: TABLE rpt_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rpt_accounts TO authenticated;
GRANT ALL ON TABLE public.rpt_accounts TO service_role;


--
-- Name: TABLE rpt_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rpt_events TO authenticated;
GRANT ALL ON TABLE public.rpt_events TO service_role;


--
-- Name: FUNCTION rpt_filtered(d_from date, d_to date, p_ae text, p_play text, p_stage text, p_account text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rpt_filtered(d_from date, d_to date, p_ae text, p_play text, p_stage text, p_account text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rpt_filtered(d_from date, d_to date, p_ae text, p_play text, p_stage text, p_account text) TO authenticated;
GRANT ALL ON FUNCTION public.rpt_filtered(d_from date, d_to date, p_ae text, p_play text, p_stage text, p_account text) TO service_role;


--
-- Name: FUNCTION rpt_range(p_period text, p_from date, p_to date, OUT d_from date, OUT d_to date, OUT label text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rpt_range(p_period text, p_from date, p_to date, OUT d_from date, OUT d_to date, OUT label text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rpt_range(p_period text, p_from date, p_to date, OUT d_from date, OUT d_to date, OUT label text) TO authenticated;
GRANT ALL ON FUNCTION public.rpt_range(p_period text, p_from date, p_to date, OUT d_from date, OUT d_to date, OUT label text) TO service_role;


--
-- Name: FUNCTION rpt_today(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rpt_today() FROM PUBLIC;
GRANT ALL ON FUNCTION public.rpt_today() TO authenticated;
GRANT ALL ON FUNCTION public.rpt_today() TO service_role;


--
-- Name: FUNCTION rpt_unit(p_metric text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.rpt_unit(p_metric text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.rpt_unit(p_metric text) TO authenticated;
GRANT ALL ON FUNCTION public.rpt_unit(p_metric text) TO service_role;


--
-- Name: FUNCTION touch_row(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.touch_row() TO anon;
GRANT ALL ON FUNCTION public.touch_row() TO authenticated;
GRANT ALL ON FUNCTION public.touch_row() TO service_role;


--
-- Name: TABLE account_briefs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.account_briefs TO authenticated;
GRANT ALL ON TABLE public.account_briefs TO service_role;


--
-- Name: SEQUENCE account_stage_history_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.account_stage_history_id_seq TO anon;
GRANT ALL ON SEQUENCE public.account_stage_history_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.account_stage_history_id_seq TO service_role;


--
-- Name: TABLE app_changes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_changes TO authenticated;
GRANT ALL ON TABLE public.app_changes TO service_role;


--
-- Name: TABLE app_config; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.app_config TO authenticated;
GRANT ALL ON TABLE public.app_config TO service_role;


--
-- Name: TABLE ari_notes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ari_notes TO authenticated;
GRANT ALL ON TABLE public.ari_notes TO service_role;


--
-- Name: TABLE ari_prefs; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.ari_prefs TO authenticated;
GRANT ALL ON TABLE public.ari_prefs TO service_role;


--
-- Name: TABLE attachments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.attachments TO authenticated;
GRANT ALL ON TABLE public.attachments TO service_role;


--
-- Name: TABLE book; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.book TO authenticated;
GRANT ALL ON TABLE public.book TO service_role;


--
-- Name: TABLE brief; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.brief TO authenticated;
GRANT ALL ON TABLE public.brief TO service_role;


--
-- Name: TABLE copy_guidance; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.copy_guidance TO authenticated;
GRANT ALL ON TABLE public.copy_guidance TO service_role;


--
-- Name: SEQUENCE copy_guidance_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.copy_guidance_id_seq TO anon;
GRANT ALL ON SEQUENCE public.copy_guidance_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.copy_guidance_id_seq TO service_role;


--
-- Name: TABLE decisions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.decisions TO authenticated;
GRANT ALL ON TABLE public.decisions TO service_role;


--
-- Name: TABLE emails; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.emails TO authenticated;
GRANT ALL ON TABLE public.emails TO service_role;


--
-- Name: TABLE events; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN ON TABLE public.events TO authenticated;
GRANT ALL ON TABLE public.events TO service_role;


--
-- Name: SEQUENCE events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.events_id_seq TO service_role;


--
-- Name: SEQUENCE log_entries_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.log_entries_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.log_entries_id_seq TO service_role;


--
-- Name: TABLE messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.messages TO authenticated;
GRANT ALL ON TABLE public.messages TO service_role;


--
-- Name: SEQUENCE notifications_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.notifications_id_seq TO anon;
GRANT ALL ON SEQUENCE public.notifications_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.notifications_id_seq TO service_role;


--
-- Name: TABLE ops; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE public.ops TO authenticated;
GRANT ALL ON TABLE public.ops TO service_role;


--
-- Name: TABLE plays; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.plays TO authenticated;
GRANT ALL ON TABLE public.plays TO service_role;


--
-- Name: TABLE push_subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.push_subscriptions TO authenticated;
GRANT ALL ON TABLE public.push_subscriptions TO service_role;


--
-- Name: TABLE push_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.push_tokens TO authenticated;
GRANT ALL ON TABLE public.push_tokens TO service_role;


--
-- Name: TABLE replies; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.replies TO authenticated;
GRANT ALL ON TABLE public.replies TO service_role;


--
-- Name: SEQUENCE replies_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.replies_id_seq TO anon;
GRANT ALL ON SEQUENCE public.replies_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.replies_id_seq TO service_role;


--
-- Name: TABLE research; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.research TO authenticated;
GRANT ALL ON TABLE public.research TO service_role;


--
-- Name: TABLE scan_heartbeat; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.scan_heartbeat TO authenticated;
GRANT ALL ON TABLE public.scan_heartbeat TO service_role;


--
-- Name: TABLE sent_messages; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,MAINTAIN ON TABLE public.sent_messages TO authenticated;
GRANT ALL ON TABLE public.sent_messages TO service_role;


--
-- Name: SEQUENCE sent_messages_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.sent_messages_id_seq TO anon;
GRANT ALL ON SEQUENCE public.sent_messages_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.sent_messages_id_seq TO service_role;


--
-- Name: TABLE sync_state; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.sync_state TO service_role;


--
-- Name: TABLE targets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.targets TO authenticated;
GRANT ALL ON TABLE public.targets TO service_role;


--
-- Name: TABLE task_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.task_events TO authenticated;
GRANT ALL ON TABLE public.task_events TO service_role;


--
-- Name: SEQUENCE task_events_id_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.task_events_id_seq TO authenticated;
GRANT ALL ON SEQUENCE public.task_events_id_seq TO service_role;


--
-- Name: TABLE tasks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tasks TO authenticated;
GRANT ALL ON TABLE public.tasks TO service_role;


--
-- Name: TABLE threads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.threads TO authenticated;
GRANT ALL ON TABLE public.threads TO service_role;


--
-- Name: TABLE weekly_metrics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.weekly_metrics TO authenticated;
GRANT ALL ON TABLE public.weekly_metrics TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--


