-- 0051 drafting in Ask Kyte (Owner Oct 30 2026 04:01 IST, option A; build go 04:47 IST). WRITTEN, staging only; never prod without Owner + a PAT.
-- Kyte writes a DM (first message, follow-up, last note) or a reply for one named person inside the chat, and the app shows it as
-- a card with "Save to <name>'s page". Chat itself never writes Owner's data: the draft is kept here (ai_chat_drafts) and reaches
-- the person's page ONLY when the app calls ari-ai action chat_draft_save on Owner's tap. Nothing is ever sent to anyone.
-- 1. ai_chat_drafts: one row per chat draft (who, which message, the text, the copy check result, the slot text it was written
--    against). Owner may read; only the ari-ai function writes. Kept 30 days (pruned with the chat turns, cron ari-ai-chat-draft-prune).
-- 2. ari_ai_chat_draft_target(question, person, kind): who the ask is for and whether a draft may be written. The SAME rules
--    everywhere: no draft for review pending or personal, Hold, the exec track, customer / closed lost / not a fit / do-not-contact
--    accounts, a meeting set (person or account), withdrawn or skipped, a message already sent, a reply already in (DMs stop), or
--    before they accept. Kind is inferred from where the person stands when the ask does not name it. Exec-track people are
--    matched only to refuse them; their names never leave this function.
-- 3. ari_ai_chat_draft_put(...): records a generated draft (service only).
-- 4. ari_ai_chat_draft_save(draft, confirm_overwrite, undo): the save behind Owner's tap. Re-checks eligibility, never writes
--    over Owner's own edit (or any text changed since the draft was written) unless confirm_overwrite, writes through the SAME
--    function as Redraft (ari_ai_save_draft mode 'rewrite' / ari_ai_save_reply_draft, both refuse a slot that moved), keeps the
--    text it replaced for undo, and is idempotent per draft id (a second tap returns the first result). undo puts the replaced
--    text back only while the slot still holds the chat draft.
-- Switch: app_config 'ask_draft' = 'true' (missing or anything else = off: the target says disabled, save refuses). Default off.
-- Service role only for every function; never anon, authenticated or ari_worker. Needs 0041 (ari_ai_save_draft), 0031
-- (draft_edits) and 0049 (ai_chat). Rollback: 0051_ai_chat_draft_rollback.sql. Checks: test/checks_after_0051.sql.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $$ begin
  if to_regprocedure('public.ari_ai_save_draft(text, text, text, jsonb, text, text)') is null or to_regclass('public.ai_chat') is null
     or to_regclass('public.draft_edits') is null then raise exception '0051 needs 0041, 0031 and 0049 first'; end if;
end $$;

-- 1. the drafts ---------------------------------------------------------------------------------------------------------------
create table if not exists public.ai_chat_drafts (
  id uuid primary key default gen_random_uuid(),
  turn_id bigint,
  person_id text not null,
  kind text not null check (kind in ('dm1', 'dm2', 'dm3', 'reply')),
  reply_id bigint,
  text text not null check (length(text) between 1 and 1900),
  meta jsonb not null default '{}'::jsonb,
  base text,                                   -- the slot text when the draft was written ('' = empty)
  created_at timestamptz not null default now(),
  saved_at timestamptz,
  save_result jsonb,
  replaced text,                               -- what the save replaced (for undo)
  replaced_ai jsonb,                           -- the slot's ai meta before the save (for undo)
  undone_at timestamptz
);
create index if not exists ai_chat_drafts_created on public.ai_chat_drafts(created_at);
alter table public.ai_chat_drafts enable row level security;
drop policy if exists owner_read on public.ai_chat_drafts;
create policy owner_read on public.ai_chat_drafts for select to authenticated using ((select public.is_owner()));
revoke all on public.ai_chat_drafts from public, anon, authenticated;
grant select on public.ai_chat_drafts to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'ari_worker') then execute 'revoke all on public.ai_chat_drafts from ari_worker'; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then execute 'grant select, insert, update, delete on public.ai_chat_drafts to service_role'; end if;
end $$;

-- the switch -------------------------------------------------------------------------------------------------------------------
create or replace function public.ari_ai_chat_draft_on() returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select lower(btrim(value)) = 'true' from app_config where key = 'ask_draft' order by updated_at desc nulls last limit 1), false)
$$;

-- 2. who and whether ----------------------------------------------------------------------------------------------------------
create or replace function public.ari_ai_chat_draft_target(p_question text, p_person text, p_kind text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
  q text := lower(left(coalesce(p_question, ''), 1500));
  lanes text[]; p people; a accounts; n int; pid text; k text; is_exec boolean; slot text; cur text; edited boolean; rid bigint;
  fn text;
begin
  if not public.ari_ai_chat_draft_on() then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  if p_kind is not null and p_kind not in ('dm1', 'dm2', 'dm3', 'reply') then raise exception 'bad kind'; end if;
  select coalesce(array_agg(lower(m[1])) filter (where lower(m[1]) <> 'shal'), '{}') into lanes
    from pg_constraint c, regexp_matches(pg_get_constraintdef(c.oid), '''([A-Za-z]+)''', 'g') m
   where c.conrelid = 'public.people'::regclass and c.conname = 'people_lane_check';
  if p_person is not null then
    pid := p_person;
  else
    -- a full name in the question (longest first); else a first name that is unique among people named in the question
    select count(*), min(x.id) into n, pid from (
      select p2.id from people p2
       where p2.deleted_at is null and coalesce(p2.workspace_id, ws) = ws and length(btrim(coalesce(p2.name, ''))) >= 4
         and q ~ ('\m' || regexp_replace(lower(btrim(p2.name)), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '\M')) x;
    if n = 0 then
      select count(*), min(x.id) into n, pid from (
        select p2.id from people p2
         where p2.deleted_at is null and coalesce(p2.workspace_id, ws) = ws and length(split_part(btrim(coalesce(p2.name, '')), ' ', 1)) >= 3
           and q ~ ('\m' || regexp_replace(lower(split_part(btrim(p2.name), ' ', 1)), '([.*+?^${}()|\[\]\\])', '\\\1', 'g') || '\M')) x;
    end if;
    if n = 0 then return jsonb_build_object('ok', false, 'reason', 'who'); end if;
    if n > 1 then return jsonb_build_object('ok', false, 'reason', 'ambiguous'); end if;
  end if;
  select * into p from people where id = pid and deleted_at is null and coalesce(workspace_id, ws) = ws;
  if not found then return jsonb_build_object('ok', false, 'reason', 'who'); end if;
  if p.account_id is not null then select * into a from accounts where id = p.account_id and deleted_at is null; end if;
  is_exec := coalesce(p.lane, 'shal') <> 'shal' or coalesce(p.route, '') ~* '\yvia\y' or lower(coalesce(p.stage, '')) = any(lanes)
             or coalesce(p.stage, '') ~* '^(exec|founder)';
  -- refusals that never name the person (exec track, personal) come first
  if is_exec then return jsonb_build_object('ok', false, 'reason', 'exec_track'); end if;
  if p.review = 'personal' then return jsonb_build_object('ok', false, 'reason', 'personal'); end if;
  fn := split_part(btrim(p.name), ' ', 1);
  if coalesce(p.review, 'lead') <> 'lead' then return jsonb_build_object('ok', false, 'reason', 'review_pending', 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn); end if;
  if coalesce(p.stage, '') ~* '^hold$' or coalesce(a.stage, '') ~* '^hold$' then
    return jsonb_build_object('ok', false, 'reason', 'hold', 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn); end if;
  if p.meeting is not null or coalesce(a.meeting_status, '') = 'set' or coalesce(a.stage, '') ~* '^(meeting set|meeting held|opportunity created)$' then
    return jsonb_build_object('ok', false, 'reason', 'meeting_set', 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn); end if;
  if coalesce(a.stage, '') ~* '^(customer|closed lost|not a fit)$' or coalesce(a.flags, '{}') && array['hold', 'do-not', 'dnc', 'do_not_contact', 'customer']
     or coalesce(p.flags, '{}') && array['do-not', 'dnc', 'do_not_contact', 'customer'] then
    return jsonb_build_object('ok', false, 'reason', 'customer', 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn); end if;
  if p.withdrawn is not null or p.skipped is not null then
    return jsonb_build_object('ok', false, 'reason', 'withdrawn', 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn); end if;
  select r.id into rid from replies r where r.person_id = p.id and r.status = 'new' order by r.received_at desc nulls last limit 1;
  k := coalesce(p_kind, case when p.replied is not null then 'reply' when p.dm2_sent is not null then 'dm3'
                             when p.dm1_sent is not null then 'dm2' else 'dm1' end);
  if k = 'reply' then
    if rid is null then return jsonb_build_object('ok', false, 'reason', case when p.replied is null then 'no_reply' else 'reply_done' end,
                                                  'person_id', p.id, 'name', btrim(p.name), 'first_name', fn); end if;
    select coalesce((select d->>'body' from jsonb_array_elements(coalesce(r.drafts, '[]'::jsonb)) d where d->>'key' = 'answer' limit 1), '')
      into cur from replies r where r.id = rid;
    return jsonb_build_object('ok', true, 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn, 'kind', k, 'slot', 'reply:answer',
      'reply_id', rid, 'current', cur, 'edited', false);
  end if;
  if p.replied is not null then return jsonb_build_object('ok', false, 'reason', 'replied', 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn); end if;
  if (k = 'dm1' and p.dm1_sent is not null) or (k = 'dm2' and p.dm2_sent is not null) or (k = 'dm3' and p.dm3_sent is not null) then
    return jsonb_build_object('ok', false, 'reason', 'already_sent', 'kind', k, 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn); end if;
  if (k = 'dm1' and p.accepted is null) or (k = 'dm2' and p.dm1_sent is null) or (k = 'dm3' and p.dm2_sent is null) then
    return jsonb_build_object('ok', false, 'reason', case k when 'dm1' then 'not_accepted' when 'dm2' then 'no_dm1' else 'no_dm2' end,
      'kind', k, 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn); end if;
  slot := case k when 'dm1' then 'dm' when 'dm2' then 'dm2_text' else 'dm3_text' end;
  cur := coalesce(case k when 'dm1' then p.dm when 'dm2' then p.dm2_text else p.dm3_text end, '');
  edited := btrim(cur) <> '' and exists (select 1 from draft_edits e where e.person_id = p.id and e.kind = k and e.sent_at is null
                                           and public.ari_draft_md5(e.edited) = public.ari_draft_md5(cur));
  return jsonb_build_object('ok', true, 'person_id', p.id, 'name', btrim(p.name), 'first_name', fn, 'kind', k, 'slot', slot, 'current', cur,
    'edited', edited, 'sent_before', to_jsonb(array_remove(array[case when k in ('dm2', 'dm3') then p.dm end, case when k = 'dm3' then p.dm2_text end], null)));
end $$;

-- 3. record a generated draft --------------------------------------------------------------------------------------------------
create or replace function public.ari_ai_chat_draft_put(p_turn bigint, p_person text, p_kind text, p_reply bigint, p_text text, p_meta jsonb, p_base text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d uuid; t text := btrim(coalesce(p_text, ''));
begin
  if not public.ari_ai_chat_draft_on() then return jsonb_build_object('ok', false, 'reason', 'disabled'); end if;
  if t = '' or length(t) > 1900 or t ~ '[\u2014\u2013]' then return jsonb_build_object('ok', false, 'reason', 'style'); end if;
  insert into ai_chat_drafts(turn_id, person_id, kind, reply_id, text, meta, base)
  values (p_turn, p_person, p_kind, p_reply, t, coalesce(p_meta, '{}'::jsonb), coalesce(p_base, '')) returning id into d;
  return jsonb_build_object('ok', true, 'draft_id', d);
end $$;

-- 4. the save behind Owner's tap (and its undo) ----------------------------------------------------------------------------------
create or replace function public.ari_ai_chat_draft_save(p_draft uuid, p_confirm_overwrite boolean default false, p_undo boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d ai_chat_drafts; t jsonb; cur text; r jsonb; slot text; prev_ai jsonb; p people; res jsonb;
begin
  if not public.ari_ai_chat_draft_on() then return jsonb_build_object('saved', false, 'reason', 'disabled'); end if;
  select * into d from ai_chat_drafts where id = p_draft for update;
  if not found then return jsonb_build_object('saved', false, 'reason', 'missing'); end if;

  if coalesce(p_undo, false) then
    if d.saved_at is null or coalesce((d.save_result->>'saved')::boolean, false) is not true then
      return jsonb_build_object('undone', false, 'reason', 'not_saved'); end if;
    if d.undone_at is not null then return jsonb_build_object('undone', true, 'repeat', true); end if;
    if d.kind = 'reply' then
      if coalesce(d.replaced, '') = '' then return jsonb_build_object('undone', false, 'reason', 'nothing_to_restore'); end if;
      r := public.ari_ai_save_reply_draft(d.reply_id, 'answer', d.replaced, d.text);
      if coalesce((r->>'saved')::boolean, false) is not true then return jsonb_build_object('undone', false, 'reason', coalesce(r->>'reason', 'changed')); end if;
    else
      slot := case d.kind when 'dm1' then 'dm' when 'dm2' then 'dm2_text' else 'dm3_text' end;
      select * into p from people where id = d.person_id and deleted_at is null for update;
      if not found then return jsonb_build_object('undone', false, 'reason', 'missing'); end if;
      cur := case slot when 'dm' then p.dm when 'dm2_text' then p.dm2_text else p.dm3_text end;
      if (case slot when 'dm' then p.dm1_sent when 'dm2_text' then p.dm2_sent else p.dm3_sent end) is not null then
        return jsonb_build_object('undone', false, 'reason', 'already_sent'); end if;
      if coalesce(cur, '') is distinct from d.text then return jsonb_build_object('undone', false, 'reason', 'changed'); end if;
      update people set
        dm = case when slot = 'dm' then nullif(d.replaced, '') else dm end,
        dm2_text = case when slot = 'dm2_text' then nullif(d.replaced, '') else dm2_text end,
        dm3_text = case when slot = 'dm3_text' then nullif(d.replaced, '') else dm3_text end,
        extra = case when d.replaced_ai is null then coalesce(extra, '{}'::jsonb) #- array['ai', slot]
                     else jsonb_set(coalesce(extra, '{}'::jsonb), array['ai', slot], d.replaced_ai) end,
        field_ts = coalesce(field_ts, '{}'::jsonb) || jsonb_build_object(slot, now()),
        updated_at = now(), updated_by = 'ari-ai'
      where id = d.person_id;
    end if;
    update ai_chat_drafts set undone_at = now() where id = d.id;
    return jsonb_build_object('undone', true);
  end if;

  if d.saved_at is not null then return coalesce(d.save_result, '{}'::jsonb) || jsonb_build_object('repeat', true); end if;
  t := public.ari_ai_chat_draft_target(null, d.person_id, d.kind);
  if coalesce((t->>'ok')::boolean, false) is not true then
    res := jsonb_build_object('saved', false, 'reason', coalesce(t->>'reason', 'not_allowed'));
    return res;                                  -- not recorded: the person may become eligible again, a later tap re-checks
  end if;
  cur := coalesce(t->>'current', '');
  -- never over Owner's own edit, or over anything that changed since this draft was written, without his confirm
  if not coalesce(p_confirm_overwrite, false) and (coalesce((t->>'edited')::boolean, false) or cur is distinct from coalesce(d.base, '')) then
    return jsonb_build_object('saved', false, 'reason', case when coalesce((t->>'edited')::boolean, false) then 'edited' else 'changed' end,
                              'needs_confirm', true);
  end if;
  if d.kind = 'reply' then
    if t->>'reply_id' is distinct from d.reply_id::text then return jsonb_build_object('saved', false, 'reason', 'changed'); end if;
    r := public.ari_ai_save_reply_draft(d.reply_id, 'answer', d.text, cur);
  else
    slot := t->>'slot';
    select extra #> array['ai', slot] into prev_ai from people where id = d.person_id;
    r := public.ari_ai_save_draft(d.person_id, slot, d.text,
           coalesce(d.meta, '{}'::jsonb) || jsonb_build_object('source', 'chat', 'chat_draft_id', d.id, 'confirm_overwrite', coalesce(p_confirm_overwrite, false)),
           nullif(cur, ''), 'rewrite');
  end if;
  res := jsonb_build_object('saved', coalesce((r->>'saved')::boolean, false), 'reason', r->>'reason', 'person_id', d.person_id, 'kind', d.kind,
                            'replaced', nullif(cur, '') is not null);
  if (res->>'saved')::boolean then
    update ai_chat_drafts set saved_at = now(), save_result = res, replaced = cur, replaced_ai = prev_ai where id = d.id;
  end if;
  return res;
end $$;

-- grants: service_role only --------------------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['ari_ai_chat_draft_on()', 'ari_ai_chat_draft_target(text, text, text)',
                           'ari_ai_chat_draft_put(bigint, text, text, bigint, text, jsonb, text)', 'ari_ai_chat_draft_save(uuid, boolean, boolean)'] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    if exists (select 1 from pg_roles where rolname = 'ari_worker') then execute format('revoke all on function public.%s from ari_worker', f); end if;
    if exists (select 1 from pg_roles where rolname = 'service_role') then execute format('grant execute on function public.%s to service_role', f); end if;
  end loop;
end $$;

-- 30-day retention, alongside the chat turns ----------------------------------------------------------------------------------
select cron.unschedule('ari-ai-chat-draft-prune') where exists (select 1 from cron.job where jobname = 'ari-ai-chat-draft-prune');
select cron.schedule('ari-ai-chat-draft-prune', '25 20 * * *', $c$delete from public.ai_chat_drafts where created_at < now() - interval '30 days'$c$);  -- 01:55 IST

insert into supabase_migrations.schema_migrations(version, name) values ('0051', 'ai_chat_draft') on conflict do nothing;
commit;
