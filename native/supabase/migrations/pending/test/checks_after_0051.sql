-- Checks for 0051 drafting in Ask Kyte. ONE statement, synthetic rows only (people P99999905101.., accounts 7a051000-..., company names
-- starting "Zq Draft"), the ask_draft switch flipped inside the transaction, and it ENDS IN A DELIBERATE RAISE so everything rolls back.
-- Through the Management API the reply "ALL 0051 CHECKS PASSED (deliberate raise ...)" (HTTP 400) is a pass; "FAIL n: ..." is a fail.
\set ON_ERROR_STOP 1
do $$
declare
  acc constant uuid := '7a051000-0000-4000-8000-000000000001';
  hold constant uuid := '7a051000-0000-4000-8000-000000000002';
  cust constant uuid := '7a051000-0000-4000-8000-000000000003';
  meet constant uuid := '7a051000-0000-4000-8000-000000000004';
  t jsonb; r jsonb; d uuid; d2 uuid; k text; v text; rid bigint;
begin
  -- 1. objects, ledger, grants, switch default off
  if to_regclass('public.ai_chat_drafts') is null then raise exception 'FAIL 1: ai_chat_drafts missing'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0051') then raise exception 'FAIL 1: no ledger row 0051'; end if;
  foreach k in array array['public.ari_ai_chat_draft_on()', 'public.ari_ai_chat_draft_target(text,text,text)',
                           'public.ari_ai_chat_draft_put(bigint,text,text,bigint,text,jsonb,text)', 'public.ari_ai_chat_draft_save(uuid,boolean,boolean)'] loop
    if to_regprocedure(k) is null then raise exception 'FAIL 1: % missing', k; end if;
    if has_function_privilege('anon', k, 'execute') or has_function_privilege('authenticated', k, 'execute') then raise exception 'FAIL 1: anon/authenticated can run %', k; end if;
    if exists (select 1 from pg_roles where rolname = 'ari_worker') and has_function_privilege('ari_worker', k, 'execute') then raise exception 'FAIL 1: ari_worker can run %', k; end if;
  end loop;
  if has_table_privilege('anon', 'public.ai_chat_drafts', 'select') or has_table_privilege('authenticated', 'public.ai_chat_drafts', 'insert')
     or has_table_privilege('authenticated', 'public.ai_chat_drafts', 'update') then raise exception 'FAIL 1: table grants'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ai_chat_drafts'::regclass) then raise exception 'FAIL 1: RLS off'; end if;
  if not exists (select 1 from cron.job where jobname = 'ari-ai-chat-draft-prune') then raise exception 'FAIL 1: prune cron missing'; end if;
  delete from app_config where key = 'ask_draft';
  if public.ari_ai_chat_draft_on() then raise exception 'FAIL 1: switch on by default'; end if;
  insert into accounts(id, company, stage) values (acc, 'Zq Draft Co', 'Target'), (hold, 'Zq Draft Hold Co', 'Hold'),
    (cust, 'Zq Draft Cust Co', 'Customer'), (meet, 'Zq Draft Meet Co', 'Target');
  update accounts set meeting_status = 'set' where id = meet;
  insert into people(id, name, company, title, account_id, stage, review, accepted, dm, lane, route) values
    ('P99999905101', 'Zqzara Draftfirst', 'Zq Draft Co', 'VP Eng', acc, 'Accepted', 'lead', now() - interval '3 hours', 'Zqzara, quick one. Worth 15 minutes?', 'shal', 'Direct'),
    ('P99999905102', 'Zqzeno Draftreply', 'Zq Draft Co', 'CTO', acc, 'Replied', 'lead', now() - interval '5 days', null, 'shal', 'Direct'),
    ('P99999905103', 'Zqzora Draftexec', 'Zq Draft Co', 'CEO', acc, 'Accepted', 'lead', now() - interval '2 days', null, 'shal', 'Zedd via Quellivarn'),
    ('P99999905104', 'Zqzack Draftpending', 'Zq Draft Co', 'VP', acc, 'Accepted', 'pending', now() - interval '2 hours', null, 'shal', 'Direct'),
    ('P99999905105', 'Zqzane Drafthold', 'Zq Draft Hold Co', 'CIO', hold, 'Accepted', 'lead', now() - interval '1 hour', null, 'shal', 'Direct'),
    ('P99999905106', 'Zqzola Draftcust', 'Zq Draft Cust Co', 'CIO', cust, 'Accepted', 'lead', now() - interval '1 hour', null, 'shal', 'Direct'),
    ('P99999905107', 'Zqzeke Draftmeet', 'Zq Draft Meet Co', 'CIO', meet, 'Accepted', 'lead', now() - interval '1 hour', null, 'shal', 'Direct'),
    ('P99999905108', 'Zqzuri Draftsent', 'Zq Draft Co', 'Dir', acc, 'DM1 sent', 'lead', now() - interval '6 days', 'Zqzuri, quick one. Worth 15 minutes?', 'shal', 'Direct'),
    ('P99999905109', 'Zqzion Draftinvite', 'Zq Draft Co', 'Dir', acc, 'Connect sent', 'lead', null, null, 'shal', 'Direct');
  update people set dm1_sent = now() - interval '5 days' where id = 'P99999905108';
  update people set replied = now() - interval '2 hours', dm1_sent = now() - interval '4 days' where id = 'P99999905102';
  insert into replies(person_id, account_id, status, snippet, received_at, drafts) values ('P99999905102', acc, 'new', 'Zq synthetic: pricing?', now() - interval '2 hours',
    '[{"key":"book","label":"Book","body":"Zqzeno, happy to. Thursday?"},{"key":"answer","label":"Answer","body":"Zqzeno, it depends on regions."},{"key":"soft","label":"Soft","body":"Thanks Zqzeno."}]')
    returning id into rid;
  t := public.ari_ai_chat_draft_target('write Zqzara Draftfirst a first message', null, null);
  if t->>'reason' <> 'disabled' then raise exception 'FAIL 1: switch off must say disabled: %', t; end if;
  r := public.ari_ai_chat_draft_put(1, 'P99999905101', 'dm1', null, 'Zqzara, quick one. Worth 15 minutes?', '{}', '');
  if (r->>'ok')::boolean then raise exception 'FAIL 1: put works with the switch off'; end if;
  raise notice 'ok 1 objects, grants, switch default off';

  -- 2. eligibility (switch on)
  insert into app_config(key, value) values ('ask_draft', 'true');
  t := public.ari_ai_chat_draft_target('write Zqzara Draftfirst a first message', null, null);
  if not (t->>'ok')::boolean or t->>'kind' <> 'dm1' or t->>'slot' <> 'dm' or t->>'person_id' <> 'P99999905101' or (t->>'edited')::boolean then raise exception 'FAIL 2: eligible dm1 %', t; end if;
  t := public.ari_ai_chat_draft_target('redo the message for zqzara', null, null);
  if t->>'person_id' is distinct from 'P99999905101' then raise exception 'FAIL 2: first-name match %', t; end if;
  t := public.ari_ai_chat_draft_target('draft a reply to Zqzeno Draftreply', null, null);
  if not (t->>'ok')::boolean or t->>'kind' <> 'reply' or (t->>'reply_id')::bigint <> rid or t->>'current' <> 'Zqzeno, it depends on regions.' then raise exception 'FAIL 2: reply %', t; end if;
  t := public.ari_ai_chat_draft_target('write a follow up for Zqzeno Draftreply', null, 'dm2');
  if t->>'reason' <> 'replied' then raise exception 'FAIL 2: DMs stop after a reply %', t; end if;
  foreach k in array array['Zqzora Draftexec:exec_track', 'Zqzack Draftpending:review_pending', 'Zqzane Drafthold:hold', 'Zqzola Draftcust:customer',
                           'Zqzeke Draftmeet:meeting_set', 'Zqzion Draftinvite:not_accepted', 'Nobody Zqnone:who'] loop
    t := public.ari_ai_chat_draft_target('write a message for ' || split_part(k, ':', 1), null, null);
    if (t->>'ok')::boolean or t->>'reason' <> split_part(k, ':', 2) then raise exception 'FAIL 2: % -> %', k, t; end if;
  end loop;
  t := public.ari_ai_chat_draft_target('write a message for Zqzora Draftexec', null, null);
  if t::text ~ 'Zqzora|Zedd|Quellivarn|P99999905103' then raise exception 'FAIL 2: the exec-track refusal leaks a name or id: %', t; end if;
  t := public.ari_ai_chat_draft_target('first message for Zqzuri Draftsent', null, 'dm1');
  if t->>'reason' <> 'already_sent' then raise exception 'FAIL 2: already sent %', t; end if;
  t := public.ari_ai_chat_draft_target('follow up for Zqzuri Draftsent', null, null);
  if not (t->>'ok')::boolean or t->>'kind' <> 'dm2' or t->'sent_before'->>0 <> 'Zqzuri, quick one. Worth 15 minutes?' then raise exception 'FAIL 2: inferred dm2 + sent_before %', t; end if;
  t := public.ari_ai_chat_draft_target('last note for Zqzuri Draftsent', null, 'dm3');
  if t->>'reason' <> 'no_dm2' then raise exception 'FAIL 2: dm3 before dm2 %', t; end if;
  insert into people(id, name, company, account_id, stage, review, accepted, lane, route) values
    ('P99999905110', 'Zqzara Draftsecond', 'Zq Draft Co', acc, 'Accepted', 'lead', now(), 'shal', 'Direct');
  t := public.ari_ai_chat_draft_target('write zqzara a note', null, null);
  if t->>'reason' <> 'ambiguous' then raise exception 'FAIL 2: two Zaras must be ambiguous %', t; end if;
  t := public.ari_ai_chat_draft_target('write Zqzara Draftfirst a note', null, null);
  if t->>'person_id' <> 'P99999905101' then raise exception 'FAIL 2: full name wins over the shared first name %', t; end if;
  t := public.ari_ai_chat_draft_target('write them a note', 'P99999905101', null);
  if t->>'person_id' <> 'P99999905101' then raise exception 'FAIL 2: person from the screen %', t; end if;
  raise notice 'ok 2 eligibility';

  -- 3. save: same write path, idempotent, previous kept, undo
  r := public.ari_ai_chat_draft_put(11, 'P99999905101', 'dm1', null, 'Zqzara, quick one. Zq Draft Co sends patient IDs to analytics, and reviews stall there. We keep them out. Worth 15 minutes?',
         '{"rationale":"zq"}', 'Zqzara, quick one. Worth 15 minutes?');
  d := (r->>'draft_id')::uuid;
  if d is null then raise exception 'FAIL 3: put %', r; end if;
  if (select dm from people where id = 'P99999905101') <> 'Zqzara, quick one. Worth 15 minutes?' then raise exception 'FAIL 3: put wrote to people'; end if;
  r := public.ari_ai_chat_draft_save(d, false, false);
  if not (r->>'saved')::boolean or not (r->>'replaced')::boolean then raise exception 'FAIL 3: save %', r; end if;
  select dm into v from people where id = 'P99999905101';
  if v !~ '^Zqzara, quick one. Zq Draft Co sends' then raise exception 'FAIL 3: dm not written: %', v; end if;
  if (select extra #>> '{ai,dm,prev}' from people where id = 'P99999905101') <> 'Zqzara, quick one. Worth 15 minutes?'
     or (select extra #>> '{ai,dm,source}' from people where id = 'P99999905101') <> 'chat' then raise exception 'FAIL 3: previous / meta not kept'; end if;
  r := public.ari_ai_chat_draft_save(d, false, false);
  if not (r->>'repeat')::boolean or not (r->>'saved')::boolean then raise exception 'FAIL 3: second tap not idempotent %', r; end if;
  r := public.ari_ai_chat_draft_save(d, false, true);
  if not (r->>'undone')::boolean or (select dm from people where id = 'P99999905101') <> 'Zqzara, quick one. Worth 15 minutes?' then raise exception 'FAIL 3: undo %', r; end if;
  if (select extra #> '{ai,dm}' from people where id = 'P99999905101') is not null then raise exception 'FAIL 3: undo left the chat meta'; end if;
  r := public.ari_ai_chat_draft_save(d, false, true);
  if not (r->>'repeat')::boolean then raise exception 'FAIL 3: second undo not idempotent %', r; end if;
  r := public.ari_ai_chat_draft_save(d, false, false);
  if (r->>'saved')::boolean or r->>'reason' <> 'undone' then raise exception 'FAIL 3: a save after undo reports saved (review #76) %', r; end if;
  raise notice 'ok 3 save, idempotent, previous kept, undo';

  -- 4. Owner's own edit is never overwritten without confirm_overwrite; a moved slot needs confirm too
  r := public.ari_ai_chat_draft_put(12, 'P99999905101', 'dm1', null, 'Zqzara, quick one. Zq Draft Co claims data sits in transcripts. We keep it out. Worth 15 minutes?', '{}',
         'Zqzara, quick one. Worth 15 minutes?');
  d2 := (r->>'draft_id')::uuid;
  update people set dm = 'Zqzara, my own words about claims data. Worth 15 minutes?', updated_by = 'app' where id = 'P99999905101';
  if not exists (select 1 from draft_edits where person_id = 'P99999905101' and kind = 'dm1') then raise exception 'FAIL 4: the edit was not recorded as Owner''s'; end if;
  t := public.ari_ai_chat_draft_target(null, 'P99999905101', 'dm1');
  if not (t->>'edited')::boolean then raise exception 'FAIL 4: target does not see the edit %', t; end if;
  r := public.ari_ai_chat_draft_save(d2, false, false);
  if (r->>'saved')::boolean or r->>'reason' <> 'edited' or not (r->>'needs_confirm')::boolean then raise exception 'FAIL 4: wrote over an edit %', r; end if;
  if (select dm from people where id = 'P99999905101') <> 'Zqzara, my own words about claims data. Worth 15 minutes?' then raise exception 'FAIL 4: edit lost'; end if;
  r := public.ari_ai_chat_draft_save(d2, true, false);
  if not (r->>'saved')::boolean then raise exception 'FAIL 4: confirm_overwrite did not save %', r; end if;
  if (select replaced from ai_chat_drafts where id = d2) <> 'Zqzara, my own words about claims data. Worth 15 minutes?' then raise exception 'FAIL 4: edit not kept for undo'; end if;
  r := public.ari_ai_chat_draft_save(d2, false, true);
  if (select dm from people where id = 'P99999905101') <> 'Zqzara, my own words about claims data. Worth 15 minutes?' then raise exception 'FAIL 4: undo did not restore the edit %', r; end if;
  -- a slot that moved (not an edit by Owner) still needs confirm
  r := public.ari_ai_chat_draft_put(13, 'P99999905101', 'dm1', null, 'Zqzara, quick one. Card numbers in support tickets stall reviews. We keep them out. Worth 15 minutes?', '{}', 'old base');
  r := public.ari_ai_chat_draft_save((r->>'draft_id')::uuid, false, false);
  if (r->>'saved')::boolean or not (r->>'needs_confirm')::boolean then raise exception 'FAIL 4: moved slot saved without confirm %', r; end if;
  raise notice 'ok 4 edits protected';

  -- 5. ineligible at save time, sent slot, reply save, switch off refuses
  r := public.ari_ai_chat_draft_put(14, 'P99999905105', 'dm1', null, 'Zqzane, quick one. Worth 15 minutes?', '{}', '');
  r := public.ari_ai_chat_draft_save((r->>'draft_id')::uuid, true, false);
  if (r->>'saved')::boolean or r->>'reason' <> 'hold' then raise exception 'FAIL 5: Hold saved %', r; end if;
  r := public.ari_ai_chat_draft_put(15, 'P99999905103', 'dm1', null, 'Zqzora, quick one. Worth 15 minutes?', '{}', '');
  r := public.ari_ai_chat_draft_save((r->>'draft_id')::uuid, true, false);
  if (r->>'saved')::boolean or r->>'reason' <> 'exec_track' then raise exception 'FAIL 5: exec saved %', r; end if;
  r := public.ari_ai_chat_draft_put(16, 'P99999905108', 'dm1', null, 'Zqzuri, quick one. Worth 15 minutes?', '{}', 'Zqzuri, quick one. Worth 15 minutes?');
  r := public.ari_ai_chat_draft_save((r->>'draft_id')::uuid, true, false);
  if (r->>'saved')::boolean or r->>'reason' <> 'already_sent' then raise exception 'FAIL 5: sent slot saved %', r; end if;
  r := public.ari_ai_chat_draft_put(17, 'P99999905102', 'reply', rid, 'Zqzeno, pricing depends on the 3 regions. Thursday at 10 your time?', '{}', 'Zqzeno, it depends on regions.');
  d := (r->>'draft_id')::uuid;
  r := public.ari_ai_chat_draft_save(d, false, false);
  if not (r->>'saved')::boolean or (select e->>'body' from replies x, jsonb_array_elements(x.drafts) e where x.id = rid and e->>'key' = 'answer') !~ '^Zqzeno, pricing' then
    raise exception 'FAIL 5: reply save %', r; end if;
  r := public.ari_ai_chat_draft_save(d, false, true);
  if not (r->>'undone')::boolean or (select e->>'body' from replies x, jsonb_array_elements(x.drafts) e where x.id = rid and e->>'key' = 'answer') <> 'Zqzeno, it depends on regions.' then
    raise exception 'FAIL 5: reply undo %', r; end if;
  r := public.ari_ai_chat_draft_put(18, 'P99999905101', 'dm1', null, 'Zqzara, quick one. Worth 15 minutes?', '{}', '');
  update app_config set value = 'false' where key = 'ask_draft';
  r := public.ari_ai_chat_draft_save((r->>'draft_id')::uuid, true, false);
  if r->>'reason' <> 'disabled' then raise exception 'FAIL 5: switch off still saves %', r; end if;
  raise notice 'ok 5 save-time rules, reply, switch';

  raise exception 'ALL 0051 CHECKS PASSED (deliberate raise: synthetic rows rolled back)';
end $$;
