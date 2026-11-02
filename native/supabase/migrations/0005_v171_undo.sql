-- 0005 (v17.1, Oct 16 2026): apply_op undo restores next_action from the restored stage and cancels a queued Draft reply when a reply mark is undone.
CREATE OR REPLACE FUNCTION public.apply_op(p_op_id text, p_kind text, p_table text, p_id text, p_patch jsonb DEFAULT '{}'::jsonb, p_client_ts timestamp with time zone DEFAULT now(), p_device text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
end $function$
;
