-- app 0004: gmail-ingest storage for shadow mode. Cursor per mailbox (compare-and-set), idempotent event writes,
-- nightly shadow-diff reports with the promotion rule, and the "Who is this?" confirm command for people.
-- Worker side (app_jobs): ingest_cursor_get / ingest_cursor_advance / ingest_record / shadow_report_put / shadow_promotion_ready.
-- People side (authenticated members): ingest_confirm_match. Nothing here reads Gmail; see docs/gmail-fetch.md.

create table app.ingest_cursors (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  source text not null default 'gmail', mailbox text not null,          -- mailbox = the connected address's opaque key, never a token
  history_id numeric not null, last_resync_at timestamptz, updated_at timestamptz not null default now(),
  primary key (workspace_id, source, mailbox)
);
create table app.shadow_reports (
  workspace_id uuid not null references app.workspaces(id) on delete cascade,
  night date not null, agree boolean not null, unmatched int not null default 0, report jsonb not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, night)
);
alter table app.ingest_cursors enable row level security;  alter table app.ingest_cursors force row level security;
alter table app.shadow_reports enable row level security;  alter table app.shadow_reports force row level security;
create policy ws_read on app.shadow_reports for select to authenticated using ((select app.is_member(workspace_id)));
create policy ws_read on app.ingest_cursors for select to authenticated using ((select app.is_member(workspace_id)));
grant select on app.shadow_reports, app.ingest_cursors to authenticated;   -- members read their own workspace's reports and sync point; only the worker writes

-- people confirm a match from the "Who is this?" card: 'confirmed' joins the allowed methods
alter table app.ingest_events drop constraint if exists ingest_events_match_method_check;
alter table app.ingest_events add constraint ingest_events_match_method_check
  check (match_method in ('profile_url','vanity','name_company','none','confirmed','rejected'));

create function app.ingest_cursor_get(p_ws uuid, p_mailbox text, p_source text default 'gmail') returns text
language sql stable security definer set search_path = '' as $$
  select history_id::text from app.ingest_cursors where workspace_id = p_ws and source = p_source and mailbox = p_mailbox
$$;

-- compare-and-set: moves only from the value the caller read, and only forwards (a resync may set p_resync to allow a reset)
create function app.ingest_cursor_advance(p_ws uuid, p_mailbox text, p_from text, p_to text, p_resync boolean default false,
                                          p_source text default 'gmail') returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_to is null or p_to !~ '^[0-9]+$' then raise exception 'bad history id'; end if;
  if p_from is null then
    insert into app.ingest_cursors(workspace_id, source, mailbox, history_id, last_resync_at)
    values (p_ws, p_source, p_mailbox, p_to::numeric, now()) on conflict do nothing;
    get diagnostics n = row_count; return n = 1;
  end if;
  update app.ingest_cursors set history_id = p_to::numeric, updated_at = now(),
         last_resync_at = case when p_resync then now() else last_resync_at end
   where workspace_id = p_ws and source = p_source and mailbox = p_mailbox and history_id = p_from::numeric
     and (p_resync or p_to::numeric >= history_id);
  get diagnostics n = row_count; return n = 1;
end $$;

-- idempotent batch write: one row per Gmail message id; replays insert nothing. Returns rows inserted.
create function app.ingest_record(p_ws uuid, p_rows jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be an array'; end if;
  insert into app.ingest_events(workspace_id, source, source_msg_id, kind, parsed, matched_person_id, match_method, mode, received_at)
  select p_ws, coalesce(r->>'source','gmail'), r->>'source_msg_id', r->>'kind', coalesce(r->'parsed','{}'::jsonb),
         p.id, coalesce(r->>'match_method','none'), coalesce(r->>'mode','shadow'), (r->>'received_at')::timestamptz
    from jsonb_array_elements(p_rows) r
    left join app.people p on p.workspace_id = p_ws and p.id = nullif(r->>'matched_person_id','')::uuid   -- cross-workspace ids drop to null
  on conflict (workspace_id, source, source_msg_id) do nothing;
  get diagnostics n = row_count; return n;
end $$;

create function app.shadow_report_put(p_ws uuid, p_night date, p_report jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into app.shadow_reports(workspace_id, night, agree, unmatched, report)
  values (p_ws, p_night, coalesce((p_report->>'agree')::boolean, false), coalesce((p_report->'counts'->>'unmatched')::int, 0), p_report)
  on conflict (workspace_id, night) do update set agree = excluded.agree, unmatched = excluded.unmatched, report = excluded.report, created_at = now()
$$;

-- promote to live only after the last 3 nights (consecutive dates ending yesterday or today) all agree with unmatched <= 1
create function app.shadow_promotion_ready(p_ws uuid, p_today date default current_date) returns boolean
language sql stable security definer set search_path = '' as $$
  with last3 as (select night, agree, unmatched from app.shadow_reports where workspace_id = p_ws order by night desc limit 3)
  select count(*) = 3 and bool_and(agree and unmatched <= 1) and max(night) >= p_today - 1 and max(night) - min(night) = 2 from last3
$$;

-- "Who is this?": a member picks the person an unmatched accept/reply belongs to (or says none of them)
create function app.ingest_confirm_match(p_ws uuid, p_event uuid, p_person uuid, p_op uuid default null) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r app.role_t := app.my_role(p_ws); e app.ingest_events; res jsonb;
begin
  if r is null or r = 'agent' then raise exception 'members confirm matches; Ari proposes them' using errcode = 'insufficient_privilege'; end if;
  if p_op is not null and app._replay(p_ws, p_op) is not null then return app._replay(p_ws, p_op); end if;
  select * into e from app.ingest_events where workspace_id = p_ws and id = p_event for update;
  if not found then raise exception 'no such event'; end if;
  if e.matched_person_id is not null and e.match_method <> 'none' then
    return jsonb_build_object('ok', false, 'conflict', true, 'person', e.matched_person_id);
  end if;
  if p_person is not null and not exists (select 1 from app.people where workspace_id = p_ws and id = p_person) then
    raise exception 'no such person';
  end if;
  update app.ingest_events set matched_person_id = p_person, match_method = case when p_person is null then 'rejected' else 'confirmed' end
   where workspace_id = p_ws and id = p_event;
  if p_person is not null and e.mode = 'live' and e.kind in ('accept','reply') then
    perform app.person_mark(p_ws, p_person, case e.kind when 'accept' then 'accepted' else 'replied' end, e.received_at, null);
  end if;
  perform app._log(p_ws, case when p_person is null then 'ingest_match_rejected' else 'ingest_match_confirmed' end,
                   case when p_person is null then 'workspace' else 'person' end, coalesce(p_person, p_ws),
                   jsonb_build_object('event', p_event, 'kind', e.kind));
  res := jsonb_build_object('ok', true, 'event', p_event, 'person', p_person);
  if p_op is not null then perform app._record(p_ws, p_op, 'ingest_confirm_match', res); end if;
  return res;
end $$;

revoke all on function app.ingest_cursor_get(uuid, text, text), app.ingest_cursor_advance(uuid, text, text, text, boolean, text),
                       app.ingest_record(uuid, jsonb), app.shadow_report_put(uuid, date, jsonb), app.shadow_promotion_ready(uuid, date),
                       app.ingest_confirm_match(uuid, uuid, uuid, uuid) from public;
grant execute on function app.ingest_cursor_get(uuid, text, text), app.ingest_cursor_advance(uuid, text, text, text, boolean, text),
                          app.ingest_record(uuid, jsonb), app.shadow_report_put(uuid, date, jsonb), app.shadow_promotion_ready(uuid, date)
  to app_jobs;
grant execute on function app.ingest_confirm_match(uuid, uuid, uuid, uuid) to authenticated;
