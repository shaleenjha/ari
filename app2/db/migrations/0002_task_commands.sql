-- app2 0002: task graph behaviour + command RPCs. All writes by clients and the agent go through these functions;
-- direct table writes are revoked from authenticated (0001). Per-role rules live here and are tested in db/tests.

-- ---------- triggers ----------
create function app.touch() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger touch before update on app.accounts for each row execute function app.touch();
create trigger touch before update on app.people   for each row execute function app.touch();
create trigger touch before update on app.tasks    for each row execute function app.touch();

-- reject cycles on 'blocks' edges
create function app.task_edges_no_cycle() returns trigger language plpgsql as $$
begin
  if new.type = 'blocks' and exists (
    with recursive r(id) as (
      select e.to_id from app.task_edges e where e.workspace_id = new.workspace_id and e.from_id = new.to_id and e.type = 'blocks'
      union
      select e.to_id from app.task_edges e join r on e.from_id = r.id where e.workspace_id = new.workspace_id and e.type = 'blocks')
    select 1 from r where r.id = new.from_id) then
    raise exception 'cycle in blocks edges' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger no_cycle before insert or update on app.task_edges for each row execute function app.task_edges_no_cycle();

-- readiness: when a task is done, dependents that are blocked become ready once all their blockers are done
create function app.task_readiness() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    update app.tasks d set status = 'ready', version = d.version + 1
     where d.workspace_id = new.workspace_id and d.status = 'blocked'
       and d.id in (select e.to_id from app.task_edges e where e.workspace_id = new.workspace_id and e.from_id = new.id and e.type = 'blocks')
       and not exists (select 1 from app.task_edges e2 join app.tasks b on b.workspace_id = e2.workspace_id and b.id = e2.from_id
                       where e2.workspace_id = d.workspace_id and e2.to_id = d.id and e2.type = 'blocks' and b.status not in ('done','cancelled'));
  end if;
  return null;
end $$;
create trigger readiness after update of status on app.tasks for each row execute function app.task_readiness();

-- ---------- state machine ----------
create function app.task_transition_ok(f app.task_status, t app.task_status) returns boolean language sql immutable as $$
  select (f, t) in (
    ('proposed','todo'), ('proposed','cancelled'),
    ('todo','ready'), ('todo','in_progress'), ('todo','blocked'), ('todo','done'), ('todo','cancelled'),
    ('ready','in_progress'), ('ready','done'), ('ready','blocked'), ('ready','cancelled'),
    ('in_progress','done'), ('in_progress','blocked'), ('in_progress','todo'), ('in_progress','cancelled'),
    ('blocked','ready'), ('blocked','cancelled'),
    ('done','todo'), ('cancelled','todo'))          -- reopen is explicit: done/cancelled -> todo only
$$;

-- ---------- helpers ----------
create function app._log(ws uuid, verb text, st text, sid uuid, payload jsonb default '{}'::jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into app.activity(workspace_id, actor_kind, actor_user_id, verb, subject_type, subject_id, payload)
  values (ws, app.actor_kind(ws), auth.uid(), verb, st, sid, payload)
$$;
create function app._replay(ws uuid, op uuid) returns jsonb language sql stable security definer set search_path = '' as $$
  select c.result from app.command_log c where c.workspace_id = ws and c.op_id = op
$$;
create function app._record(ws uuid, op uuid, cmd text, res jsonb) returns jsonb language sql security definer set search_path = '' as $$
  insert into app.command_log(workspace_id, op_id, user_id, command, result) values (ws, op, auth.uid(), cmd, res)
  on conflict do nothing returning res
$$;
create function app._on_account_team(ws uuid, acc uuid, uid uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select acc is not null and exists (select 1 from app.account_team t where t.workspace_id = ws and t.account_id = acc and t.user_id = uid)
$$;

-- ---------- commands ----------
-- task_create: anyone in the workspace for themselves; an "ask" to another role only on a shared account (SDR<->AE);
-- managers/admins anyone; the agent only proposes (status 'proposed', a human accepts).
create function app.task_create(p_ws uuid, p_kind app.task_kind, p_title text, p_assignee_role app.role_t,
                                p_assignee_user uuid default null, p_account uuid default null, p_person uuid default null,
                                p_due timestamptz default null, p_body jsonb default '{}'::jsonb, p_op uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); r app.role_t := app.my_role(p_ws); tid uuid; st app.task_status := 'todo'; res jsonb;
begin
  if r is null then raise exception 'not a member' using errcode = 'insufficient_privilege'; end if;
  if p_op is not null and app._replay(p_ws, p_op) is not null then return app._replay(p_ws, p_op); end if;
  if coalesce(btrim(p_title), '') = '' then raise exception 'title required'; end if;
  if r = 'agent' then
    st := 'proposed';
  elsif r in ('sdr','ae') and coalesce(p_assignee_user, me) <> me then
    if not (app._on_account_team(p_ws, p_account, me) and app._on_account_team(p_ws, p_account, p_assignee_user)) then
      raise exception 'asks to others need a shared account' using errcode = 'insufficient_privilege';
    end if;
  end if;
  if p_assignee_user is not null and not exists (select 1 from app.memberships m where m.workspace_id = p_ws and m.user_id = p_assignee_user and m.status = 'active') then
    raise exception 'assignee not in workspace' using errcode = 'insufficient_privilege';
  end if;
  insert into app.tasks(workspace_id, kind, title, body, status, assignee_user_id, assignee_role, created_by, created_by_kind,
                        account_id, person_id, due_at)
  values (p_ws, p_kind, p_title, coalesce(p_body, '{}'::jsonb), st,
          case when r = 'agent' then p_assignee_user else coalesce(p_assignee_user, case when r = p_assignee_role then me end) end,
          p_assignee_role, me, app.actor_kind(p_ws), p_account, p_person, p_due)
  returning id into tid;
  insert into app.task_events(workspace_id, task_id, actor_id, actor_kind, type, to_value)
  values (p_ws, tid, me, app.actor_kind(p_ws), 'created', st::text);
  perform app._log(p_ws, 'task_created', 'task', tid, jsonb_build_object('kind', p_kind, 'status', st));
  res := jsonb_build_object('ok', true, 'id', tid, 'status', st, 'version', 1);
  if p_op is not null then perform app._record(p_ws, p_op, 'task_create', res); end if;
  return res;
end $$;

-- task_transition: optimistic concurrency (expected_version); state machine guard; who may move what:
--   assignee, or creator while todo/proposed; manager/admin anyone; agent only tasks it created; proposed->todo by a human only.
create function app.task_transition(p_ws uuid, p_task uuid, p_to app.task_status, p_expected_version int, p_op uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); r app.role_t := app.my_role(p_ws); t app.tasks; res jsonb;
begin
  if r is null then raise exception 'not a member' using errcode = 'insufficient_privilege'; end if;
  if p_op is not null and app._replay(p_ws, p_op) is not null then return app._replay(p_ws, p_op); end if;
  select * into t from app.tasks where workspace_id = p_ws and id = p_task for update;
  if not found then raise exception 'no such task' using errcode = 'no_data_found'; end if;
  if t.version <> p_expected_version then
    return jsonb_build_object('ok', false, 'conflict', true, 'current', jsonb_build_object('status', t.status, 'version', t.version, 'updated_at', t.updated_at));
  end if;
  if not app.task_transition_ok(t.status, p_to) then
    raise exception 'illegal transition % -> %', t.status, p_to using errcode = 'check_violation';
  end if;
  if r = 'agent' then
    if t.created_by <> me or t.status = 'proposed' then raise exception 'agent may only move its own accepted tasks' using errcode = 'insufficient_privilege'; end if;
  elsif r not in ('manager','admin') then
    if not (t.assignee_user_id = me
            or (t.assignee_user_id is null and t.assignee_role = r)
            or (t.created_by = me and t.status in ('todo','proposed'))
            or (t.status = 'proposed' and t.assignee_role = r)) then
      raise exception 'not your task' using errcode = 'insufficient_privilege';
    end if;
  end if;
  update app.tasks set status = p_to, version = version + 1,
         done_at = case when p_to = 'done' then now() else null end,
         assignee_user_id = case when t.assignee_user_id is null and r = t.assignee_role and p_to in ('in_progress','done') then me else assignee_user_id end
   where workspace_id = p_ws and id = p_task;
  insert into app.task_events(workspace_id, task_id, actor_id, actor_kind, type, from_value, to_value)
  values (p_ws, p_task, me, app.actor_kind(p_ws), case when t.status = 'proposed' and p_to = 'todo' then 'accepted' else 'status' end, t.status::text, p_to::text);
  perform app._log(p_ws, 'task_' || p_to::text, 'task', p_task, jsonb_build_object('from', t.status));
  res := jsonb_build_object('ok', true, 'id', p_task, 'status', p_to, 'version', t.version + 1);
  if p_op is not null then perform app._record(p_ws, p_op, 'task_transition', res); end if;
  return res;
end $$;

-- task_link: dependencies between tasks in the same workspace (any human member; the agent proposes via body instead)
create function app.task_link(p_ws uuid, p_from uuid, p_to uuid, p_type app.edge_t default 'blocks') returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not app.has_role(p_ws, array['admin','manager','ae','sdr']::app.role_t[]) then raise exception 'not allowed' using errcode = 'insufficient_privilege'; end if;
  insert into app.task_edges(workspace_id, from_id, to_id, type) values (p_ws, p_from, p_to, p_type);
  if p_type = 'blocks' then
    update app.tasks set status = 'blocked', version = version + 1
     where workspace_id = p_ws and id = p_to and status in ('todo','ready')
       and exists (select 1 from app.tasks b where b.workspace_id = p_ws and b.id = p_from and b.status not in ('done','cancelled'));
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- nudge: a comment-style event on a task to the person who holds it (rate limit 1 per task per sender per 10 min)
create function app.task_nudge(p_ws uuid, p_task uuid, p_message text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); r app.role_t := app.my_role(p_ws); t app.tasks;
begin
  if r is null or r = 'agent' then raise exception 'humans nudge; Ari suggests' using errcode = 'insufficient_privilege'; end if;
  select * into t from app.tasks where workspace_id = p_ws and id = p_task;
  if not found then raise exception 'no such task'; end if;
  if r in ('sdr','ae') and not (app._on_account_team(p_ws, t.account_id, me) or t.created_by = me) then
    raise exception 'nudges only on your accounts' using errcode = 'insufficient_privilege';
  end if;
  if exists (select 1 from app.task_events e where e.workspace_id = p_ws and e.task_id = p_task and e.actor_id = me
             and e.type = 'nudge' and e.created_at > now() - interval '10 minutes') then
    return jsonb_build_object('ok', false, 'rate_limited', true);
  end if;
  insert into app.task_events(workspace_id, task_id, actor_id, actor_kind, type, payload)
  values (p_ws, p_task, me, app.actor_kind(p_ws), 'nudge', jsonb_build_object('message', left(p_message, 500)));
  if t.assignee_user_id is not null and t.assignee_user_id <> me then
    insert into app.notifications(workspace_id, user_id, kind, title, body, dedupe_key)
    values (p_ws, t.assignee_user_id, 'nudge', 'Nudge on: ' || left(t.title, 80), left(p_message, 200), 'nudge:' || p_task || ':' || me || ':' || to_char(now(), 'YYYYMMDDHH24MI'))
    on conflict do nothing;
  end if;
  return jsonb_build_object('ok', true);
end $$;

-- person_mark: the SDR's send flow (connect sent / accepted / DM sent / replied), op_id idempotent, exact tap time,
-- stage follows the furthest fact, DM2/DM3 due dates scheduled (+4 / +7 days, carried from prod).
create function app.person_mark(p_ws uuid, p_person uuid, p_field text, p_at timestamptz default now(), p_op uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r app.role_t := app.my_role(p_ws); res jsonb; p app.people; n int;
begin
  if r is null then raise exception 'not a member' using errcode = 'insufficient_privilege'; end if;
  if r = 'agent' and p_field not in ('accepted','replied') then raise exception 'Ari records accepts and replies only; people send' using errcode = 'insufficient_privilege'; end if;
  if p_op is not null and app._replay(p_ws, p_op) is not null then return app._replay(p_ws, p_op); end if;
  if p_field not in ('connect_sent','accepted','dm1_sent','dm2_sent','dm3_sent','replied','withdrawn') then raise exception 'bad field'; end if;
  execute format('update app.people set %I = coalesce(%I, $1) where workspace_id = $2 and id = $3', p_field || '_at', p_field || '_at')
    using p_at, p_ws, p_person;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'no such person'; end if;
  select * into p from app.people where workspace_id = p_ws and id = p_person;
  update app.people set
    stage = case when p.replied_at is not null then 'replied' when p.withdrawn_at is not null then 'withdrawn'
                 when p.dm3_sent_at is not null then 'dm3_sent' when p.dm2_sent_at is not null then 'dm2_sent'
                 when p.dm1_sent_at is not null then 'dm1_sent' when p.accepted_at is not null then 'accepted'
                 when p.connect_sent_at is not null then 'connect_sent' else stage end::app.person_stage_t,
    dm2_due = coalesce(dm2_due, case when p.dm1_sent_at is not null then (p.dm1_sent_at + interval '4 days')::date end),
    dm3_due = coalesce(dm3_due, case when p.dm2_sent_at is not null then (p.dm2_sent_at + interval '7 days')::date end)
  where workspace_id = p_ws and id = p_person;
  insert into app.metric_facts(workspace_id, metric, occurred_at, user_id, account_id, person_id, dedupe_key)
  values (p_ws, p_field, p_at, auth.uid(), p.account_id, p_person, p_field || ':' || p_person) on conflict do nothing;
  perform app._log(p_ws, 'marked_' || p_field, 'person', p_person, jsonb_build_object('at', p_at));
  res := jsonb_build_object('ok', true, 'person', p_person, 'field', p_field);
  if p_op is not null then perform app._record(p_ws, p_op, 'person_mark', res); end if;
  return res;
end $$;

revoke all on function app.task_create(uuid, app.task_kind, text, app.role_t, uuid, uuid, uuid, timestamptz, jsonb, uuid),
                       app.task_transition(uuid, uuid, app.task_status, int, uuid),
                       app.task_link(uuid, uuid, uuid, app.edge_t),
                       app.task_nudge(uuid, uuid, text),
                       app.person_mark(uuid, uuid, text, timestamptz, uuid),
                       app._log(uuid, text, text, uuid, jsonb), app._replay(uuid, uuid), app._record(uuid, uuid, text, jsonb),
                       app._on_account_team(uuid, uuid, uuid), app.task_readiness(), app.task_edges_no_cycle(), app.touch()
  from public;
grant execute on function app.task_create(uuid, app.task_kind, text, app.role_t, uuid, uuid, uuid, timestamptz, jsonb, uuid),
                          app.task_transition(uuid, uuid, app.task_status, int, uuid),
                          app.task_link(uuid, uuid, uuid, app.edge_t),
                          app.task_nudge(uuid, uuid, text),
                          app.person_mark(uuid, uuid, text, timestamptz, uuid)
  to authenticated;

-- role execution layers are views over one graph (security_invoker so RLS applies to the caller)
create view app.my_queue with (security_invoker = true) as
  select t.* from app.tasks t
  where t.status in ('todo','ready','in_progress','blocked','proposed')
    and (t.assignee_user_id = auth.uid() or (t.assignee_user_id is null and t.assignee_role = app.my_role(t.workspace_id)));
grant select on app.my_queue to authenticated;
