-- 0031 tests: run on STAGING in one transaction; ends in a deliberate raise so nothing persists. Synthetic rows only.
do $$
declare r jsonb := '{}'::jsonb; t text; x jsonb; n int; acc uuid; orig text := 'Hi Zed, saw the Zz launch last week. Worth a chat?';
  ed1 text := 'Hi Zed, saw your Zz launch. Worth a short chat?'; ed2 text := 'Hi Zed, saw your Zz launch. Open to a short chat?';
  de public.draft_edits; sm public.sent_messages; ok boolean;
begin
  -- privileges
  foreach t in array array['ari_worker_draft_tag(text,text,text,jsonb)','ari_worker_untagged_drafts(integer)','ari_worker_copy_stats(date,date)'] loop
    if has_function_privilege('anon', 'public.' || t, 'execute') or has_function_privilege('authenticated', 'public.' || t, 'execute') then raise exception 'FAIL grant %', t; end if;
    if not has_function_privilege('ari_worker', 'public.' || t, 'execute') then raise exception 'FAIL worker grant %', t; end if;
  end loop;
  foreach t in array array['ari_tags_for(text,text,text)','ari_sent_enrich(bigint)','people_copy_guidance()','queue_rescan_notify()'] loop
    if has_function_privilege('anon', 'public.' || t, 'execute') or has_function_privilege('authenticated', 'public.' || t, 'execute')
       or has_function_privilege('ari_worker', 'public.' || t, 'execute') then raise exception 'FAIL internal grant %', t; end if;
  end loop;
  foreach t in array array['draft_tags','draft_edits'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('ari_worker', 'public.' || t, 'select')
       or has_table_privilege('authenticated', 'public.' || t, 'insert') or has_table_privilege('authenticated', 'public.' || t, 'update') then raise exception 'FAIL table grant %', t; end if;
    if not has_table_privilege('authenticated', 'public.' || t, 'select') then raise exception 'FAIL owner read %', t; end if;
  end loop;

  -- word diff
  x := public.ari_word_diff('Hi Ann, saw the launch.', 'Hi Ann, saw your launch today.');
  if (x->>'kept')::int <> 3 or (x->>'added')::int <> 3 or (x->>'removed')::int <> 2 then raise exception 'FAIL diff counts %', x; end if;
  if (select string_agg(o->>'t', ' ' order by i) from jsonb_array_elements(x->'ops') with ordinality e(o, i) where o->>'op' <> '-') <> 'Hi Ann, saw your launch today.'
    then raise exception 'FAIL diff rebuild new %', x; end if;
  if (select string_agg(o->>'t', ' ' order by i) from jsonb_array_elements(x->'ops') with ordinality e(o, i) where o->>'op' <> '+') <> 'Hi Ann, saw the launch.'
    then raise exception 'FAIL diff rebuild old %', x; end if;
  if (public.ari_word_diff('same words', 'same   words')->>'added')::int <> 0 then raise exception 'FAIL diff whitespace'; end if;
  r := r || jsonb_build_object('diff', 'ok');

  -- synthetic rows
  insert into accounts(company, owner) values ('Zz Ixterlane Test', 'Idris Mockwright') returning id into acc;
  insert into people(id, name, company, account_id, linkedin_url, accepted, dm, review) values
    ('PTEST31', 'Zz Synthetic Thirtyone', 'Zz Ixterlane Test', acc, 'https://www.linkedin.com/in/zz-31', now() - interval '1 day', orig, 'lead'),
    ('PTEST32', 'Zz Synthetic Thirtytwo', 'Zz Ixterlane Test', acc, 'https://www.linkedin.com/in/zz-32', now() - interval '1 day', 'Hi Yan, untagged draft here.', 'lead'),
    ('PTEST33', 'Zz Synthetic Thirtythree', 'Zz Ixterlane Test', acc, 'https://www.linkedin.com/in/zz-33', now() - interval '1 day', 'Hi Xu, revert me.', 'lead');

  -- tagging: validation
  ok := false; begin perform public.ari_worker_draft_tag('PTEST31', 'dm1', orig, '{"angle":"a","structure":"s","hook_kind":"nope"}'); exception when others then ok := sqlerrm like '%hook_kind%'; end;
  if not ok then raise exception 'FAIL bad hook_kind accepted'; end if;
  ok := false; begin perform public.ari_worker_draft_tag('PTEST31', 'dm1', orig, '{"angle":"a","structure":"s","hook_kind":"launch"}'); exception when others then ok := sqlerrm like '%primary hook_url%'; end;
  if not ok then raise exception 'FAIL trigger hook without url accepted'; end if;
  ok := false; begin perform public.ari_worker_draft_tag('PTEST31', 'dm1', orig, '{"angle":"a","structure":"s","hook_kind":"launch","hook_url":"https://www.crunchbase.com/x"}'); exception when others then ok := sqlerrm like '%primary source%'; end;
  if not ok then raise exception 'FAIL aggregator url accepted'; end if;
  ok := false; begin perform public.ari_worker_draft_tag('PTEST31', 'dm1', orig, '{"angle":"a","structure":"s","hook_kind":"none","mood":"x"}'); exception when others then ok := sqlerrm like '%unknown tag%'; end;
  if not ok then raise exception 'FAIL unknown key accepted'; end if;
  x := public.ari_worker_draft_tag('PTEST31', 'dm1', orig, '{"angle":"Launch exposes customer data in agent flows","hook":"Zz launch","hook_kind":"launch","hook_url":"https://zz.example.com/news","hook_date":"2026-10-01","structure":"Trigger + question","persona":"Product","play":"Play A"}');
  if x->>'journey_step' <> 'dm1' then raise exception 'FAIL journey default %', x; end if;
  -- idempotent on the same text
  perform public.ari_worker_draft_tag('PTEST31', 'dm1', '  ' || orig || ' ', '{"angle":"Launch exposes customer data in agent flows","hook":"Zz launch","hook_kind":"launch","hook_url":"https://zz.example.com/news","hook_date":"2026-10-01","structure":"trigger + question"}');
  if (select count(*) from draft_tags where person_id = 'PTEST31') <> 1 then raise exception 'FAIL tag upsert'; end if;
  x := public.ari_worker_untagged_drafts(200);
  if not exists (select 1 from jsonb_array_elements(x) e where e->>'person_id' = 'PTEST32') then raise exception 'FAIL untagged missing PTEST32'; end if;
  if exists (select 1 from jsonb_array_elements(x) e where e->>'person_id' = 'PTEST31') then raise exception 'FAIL tagged listed as untagged'; end if;
  r := r || jsonb_build_object('tags', 'ok');

  -- edit capture: only app edits; chain of saves -> one row; copy_guidance kept in step
  perform set_config('ari.actor', 'sheet', true);
  update people set dm = 'Hi Yan, untagged draft here, resynced.' where id = 'PTEST32';
  if exists (select 1 from draft_edits where person_id = 'PTEST32') then raise exception 'FAIL non-app edit captured'; end if;
  perform set_config('ari.actor', 'app', true);
  update people set dm = ed1 where id = 'PTEST31';
  select * into de from draft_edits where person_id = 'PTEST31';
  if de.id is null or de.original <> orig or de.edited <> ed1 or de.saves <> 1 or de.words_kept < 3 or de.ae <> 'Idris' then raise exception 'FAIL first edit %', to_jsonb(de); end if;
  update people set dm = ed2 where id = 'PTEST31';
  if (select count(*) from draft_edits where person_id = 'PTEST31') <> 1 then raise exception 'FAIL chain made a second row'; end if;
  select * into de from draft_edits where person_id = 'PTEST31';
  if de.original <> orig or de.edited <> ed2 or de.saves <> 2 then raise exception 'FAIL chain %', to_jsonb(de); end if;
  if (select count(*) from copy_guidance where person_id = 'PTEST31') <> 1 or (select after from copy_guidance where person_id = 'PTEST31') <> ed2
     or (select before from copy_guidance where person_id = 'PTEST31') <> orig then raise exception 'FAIL guidance in step'; end if;
  -- edited text still finds Ari's tags (through the edit chain); not listed as untagged
  if (public.ari_tags_for('PTEST31', 'dm1', ed2)).angle is null then raise exception 'FAIL tags through edit chain'; end if;
  if exists (select 1 from jsonb_array_elements(public.ari_worker_untagged_drafts(200)) e where e->>'person_id' = 'PTEST31') then raise exception 'FAIL edited draft listed untagged'; end if;
  -- revert to Ari's text removes the edit
  update people set dm = 'Hi Xu, revert me, edited.' where id = 'PTEST33';
  if (select count(*) from draft_edits where person_id = 'PTEST33') <> 1 then raise exception 'FAIL edit 33'; end if;
  update people set dm = 'Hi Xu, revert me.' where id = 'PTEST33';
  if exists (select 1 from draft_edits where person_id = 'PTEST33') or exists (select 1 from copy_guidance where person_id = 'PTEST33') then raise exception 'FAIL revert kept rows'; end if;
  r := r || jsonb_build_object('edits', 'ok');

  -- send tick: snapshot carries the edited body, Ari's original, the diff and the tags; undo clears the link
  update people set dm1_sent = now() where id = 'PTEST31';
  select * into sm from sent_messages where person_id = 'PTEST31' and kind = 'dm1';
  if sm.body <> ed2 or sm.ari_original <> orig or sm.edit_diff is null or sm.tags->>'angle' is null or sm.tags->>'journey_step' <> 'dm1'
     or (sm.tags->>'hook_age_days')::int < 0 then raise exception 'FAIL snapshot %', to_jsonb(sm); end if;
  if (select sent_message_id from draft_edits where person_id = 'PTEST31') <> sm.id then raise exception 'FAIL edit marked sent'; end if;
  x := public.ari_worker_copy_stats(null, null);
  if (x->>'sent')::int < 1 or (x->>'tagged')::int < 1 or (x->>'edited')::int < 1 then raise exception 'FAIL copy stats %', x - 'messages'; end if;
  update people set dm1_sent = null where id = 'PTEST31';
  if exists (select 1 from sent_messages where person_id = 'PTEST31' and kind = 'dm1') then raise exception 'FAIL undo kept snapshot'; end if;
  if (select sent_at from draft_edits where person_id = 'PTEST31') is not null then raise exception 'FAIL undo kept edit sent'; end if;
  -- a tick with no tag and no edit still snapshots (never blocks)
  update people set dm1_sent = now() where id = 'PTEST33';
  if not exists (select 1 from sent_messages where person_id = 'PTEST33' and kind = 'dm1' and tags is null and ari_original is null) then raise exception 'FAIL plain snapshot'; end if;
  r := r || jsonb_build_object('sent', 'ok');

  -- Re-scan done push: one per row, private wording, opens the Brief
  insert into queue(id, action, target, status) values ('QTEST31', 'Rescan account', 'Zz Ixterlane Test', 'working');
  update queue set status = 'done', result = 'New trigger Oct 1: Zz launch.' || E'\n' || 'Brief refreshed.' where id = 'QTEST31';
  update queue set result = 'again' where id = 'QTEST31';
  update queue set status = 'done' where id = 'QTEST31';
  select count(*) into n from notifications where dedupe_key = 'rescan:QTEST31';
  if n <> 1 then raise exception 'FAIL rescan push count %', n; end if;
  if (select url from notifications where dedupe_key = 'rescan:QTEST31') <> '/ops?open=account:' || acc || ':brief' then raise exception 'FAIL rescan url'; end if;
  if coalesce((public.ari_pref('push_show_names', 'false'::jsonb) #>> '{}')::boolean, false) then
    if (select title from notifications where dedupe_key = 'rescan:QTEST31') <> 'Re-scan done: Zz Ixterlane Test' then raise exception 'FAIL rescan title (names on)'; end if;
  elsif (select title from notifications where dedupe_key = 'rescan:QTEST31') <> 'Re-scan done' then raise exception 'FAIL rescan privacy title'; end if;
  insert into queue(id, action, target, status) values ('QTEST32', 'Draft DM1', 'PTEST31', 'working');
  update queue set status = 'done' where id = 'QTEST32';
  if exists (select 1 from notifications where dedupe_key = 'rescan:QTEST32') then raise exception 'FAIL push for non-rescan row'; end if;
  r := r || jsonb_build_object('rescan', 'ok');

  raise exception 'ALL 0031 TESTS PASSED %', r::text;
end $$;
