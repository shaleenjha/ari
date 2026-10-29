-- Checks for 0049 (live Ask Kyte chat). ONE statement, synthetic rows only (people P999999049xx, companies starting "Zq Chat",
-- route "Zedd via Quellivarn" for the exec track), and it ENDS IN A DELIBERATE RAISE so the whole transaction rolls back (nothing
-- kept). Staging and CI safe. Through the Management API "ALL 0049 CHECKS PASSED (deliberate raise ...)" (HTTP 400) is a pass.
\set ON_ERROR_STOP 1
do $$
declare
  ws constant uuid := 'f5a1e000-0000-4000-8000-000000000001';
  other constant uuid := 'f5a1e000-0000-4000-8000-0000000049ff';
  acc uuid := gen_random_uuid(); hold uuid := gen_random_uuid(); r jsonb; c jsonb; s text; t1 bigint; n int; k text; i int;
begin
  -- 1. objects, RLS, grants, cron, ledger, task 'chat'
  if to_regclass('public.ai_chat') is null then raise exception 'FAIL 1: ai_chat missing'; end if;
  if not (select relrowsecurity from pg_class where oid = 'public.ai_chat'::regclass) then raise exception 'FAIL 1: RLS off'; end if;
  if has_table_privilege('anon', 'public.ai_chat', 'select') or has_table_privilege('authenticated', 'public.ai_chat', 'insert')
     or has_table_privilege('authenticated', 'public.ai_chat', 'update') or has_table_privilege('authenticated', 'public.ai_chat', 'delete') then
    raise exception 'FAIL 1: ai_chat grants too wide'; end if;
  if not has_table_privilege('authenticated', 'public.ai_chat', 'select') then raise exception 'FAIL 1: owner cannot read ai_chat'; end if;
  foreach k in array array['public.ari_ai_chat_begin(text)', 'public.ari_ai_chat_finish(bigint, text, text, bigint, int, int)',
                           'public.ari_ai_chat_context(text, text, uuid)'] loop
    if has_function_privilege('anon', k, 'execute') or has_function_privilege('authenticated', k, 'execute') then
      raise exception 'FAIL 1: anon or authenticated can run %', k; end if;
    if not has_function_privilege('service_role', k, 'execute') then raise exception 'FAIL 1: service_role cannot run %', k; end if;
    if exists (select 1 from pg_roles where rolname = 'ari_worker') and has_function_privilege('ari_worker', k, 'execute') then
      raise exception 'FAIL 1: ari_worker can run %', k; end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'ari_worker') and has_table_privilege('ari_worker', 'public.ai_chat', 'select') then
    raise exception 'FAIL 1: ari_worker can read ai_chat'; end if;
  if not exists (select 1 from cron.job where jobname = 'ari-ai-chat-prune') then raise exception 'FAIL 1: prune cron missing'; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0049') then raise exception 'FAIL 1: no ledger row 0049'; end if;
  s := (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.ai_calls'::regclass and conname = 'ai_calls_task_check');
  if s !~ '''chat''' or s !~ '''draft''' or s !~ '''quick_research''' then raise exception 'FAIL 1: task check %', s; end if;
  update ai_budget set enabled = true, monthly_cap_usd = 500, daily_cap_usd = 100;
  r := public.ari_ai_budget_reserve('chat', 'anthropic', 'zq-model', 0.01);
  if not (r->>'ok')::boolean then raise exception 'FAIL 1: chat reserve %', r; end if;
  update ai_budget set enabled = false;
  r := public.ari_ai_budget_reserve('chat', 'anthropic', 'zq-model', 0.01);
  if (r->>'ok')::boolean or r->>'reason' <> 'disabled' then raise exception 'FAIL 1: budget off must refuse chat %', r; end if;
  raise notice 'ok 1 objects, RLS, grants, cron, ledger, chat task';

  -- 2. turns: empty refused, 20 a minute, the 21st refused, finish writes the answer, history comes back
  delete from ai_chat;
  r := public.ari_ai_chat_begin('   ');
  if (r->>'ok')::boolean or r->>'reason' <> 'empty' then raise exception 'FAIL 2: empty %', r; end if;
  for i in 1..20 loop
    r := public.ari_ai_chat_begin('zq question ' || i);
    if not (r->>'ok')::boolean then raise exception 'FAIL 2: turn % refused %', i, r; end if;
    if i = 1 then t1 := (r->>'turn_id')::bigint; end if;
  end loop;
  r := public.ari_ai_chat_begin('zq question 21');
  if (r->>'ok')::boolean or r->>'reason' <> 'rate_minute' then raise exception 'FAIL 2: 21st in a minute not refused %', r; end if;
  if (select count(*) from ai_chat) <> 20 then raise exception 'FAIL 2: a refused turn was stored'; end if;
  perform public.ari_ai_chat_finish(t1, 'zq answer one', 'ok', null, 400, 1200);
  if (select status from ai_chat where id = t1) <> 'ok' or (select count(*) from ai_chat where role = 'assistant' and turn_id = t1) <> 1 then
    raise exception 'FAIL 2: finish did not record the answer'; end if;
  begin perform public.ari_ai_chat_finish(t1, 'again', 'ok'); raise exception 'FAIL 2: finished twice';
  exception when no_data_found then null; end;
  begin perform public.ari_ai_chat_finish(t1 + 1, 'x', 'bogus'); raise exception 'FAIL 2: bad status accepted';
  exception when invalid_parameter_value then null; end;
  perform public.ari_ai_chat_finish(t1 + 1, '', 'refused');
  if exists (select 1 from ai_chat where turn_id = t1 + 1) then raise exception 'FAIL 2: refused turn got an answer row'; end if;
  update ai_chat set at = now() - interval '2 minutes' where role = 'user';            -- the minute window moves on
  r := public.ari_ai_chat_begin('zq follow-up');
  if not (r->>'ok')::boolean then raise exception 'FAIL 2: after a minute %', r; end if;
  if jsonb_array_length(r->'history') <> 1 or r->'history'->0->>'a' <> 'zq answer one' then raise exception 'FAIL 2: history %', r->'history'; end if;
  if length((select text from ai_chat where id = (r->>'turn_id')::bigint)) > 1500 then raise exception 'FAIL 2: length'; end if;
  r := public.ari_ai_chat_begin(repeat('z', 3000));
  if length((select text from ai_chat where id = (r->>'turn_id')::bigint)) <> 1500 then raise exception 'FAIL 2: long question not cut at 1500'; end if;
  raise notice 'ok 2 rate limit per minute, finish, history, 1500 cut';

  -- 3. day cap and 30-day prune
  delete from ai_chat;
  insert into ai_chat(at, role, text, status) select now() - interval '61 seconds', 'user', 'zq day ' || g, 'ok' from generate_series(1, 300) g;
  update ai_chat set at = greatest(date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata', now() - interval '61 seconds');
  r := public.ari_ai_chat_begin('zq 301');
  if now() - (date_trunc('day', now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata') > interval '2 minutes'
     and ((r->>'ok')::boolean or r->>'reason' <> 'rate_day') then raise exception 'FAIL 3: day cap %', r; end if;
  delete from ai_chat;
  insert into ai_chat(at, role, text, status) values (now() - interval '31 days', 'user', 'zq old', 'ok'), (now() - interval '29 days', 'user', 'zq keep', 'ok');
  r := public.ari_ai_chat_begin('zq prune');
  if exists (select 1 from ai_chat where text = 'zq old') or not exists (select 1 from ai_chat where text = 'zq keep') then raise exception 'FAIL 3: prune'; end if;
  raise notice 'ok 3 day cap, 30-day prune';

  -- 4. snapshot: Owner's own data only, no personal / pending / deleted / other workspace, exec track as counts, deny names
  insert into app.workspaces(id, name) values (other, 'zq other') on conflict do nothing;
  insert into accounts(id, company, stage, hook, one_liner) values (acc, 'Zq Chat Co', 'Target', 'Zq launched a synthetic product', 'Zq makes synthetic widgets'),
    (hold, 'Zq Chat Hold Co', 'Hold', null, null);
  insert into people(id, name, company, title, account_id, stage, review, accepted, dm, lane, route) values
    ('P99999904901', 'Zara Chatfirst', 'Zq Chat Co', 'CISO', acc, 'Accepted', 'lead', now() - interval '3 hours', 'Zara, quick one. Worth 15 minutes?', 'shal', 'Direct'),
    ('P99999904902', 'Zeno Chatreply', 'Zq Chat Co', 'CTO', acc, 'Replied', 'lead', now() - interval '5 days', null, 'shal', 'Direct'),
    ('P99999904903', 'Zelda Chatpersonal', 'Zq Chat Co', 'Friend', acc, 'Accepted', 'personal', now() - interval '2 hours', null, 'shal', 'Direct'),
    ('P99999904904', 'Zack Chatpending', 'Zq Chat Co', 'VP', acc, 'Accepted', 'pending', now() - interval '2 hours', null, 'shal', 'Direct'),
    ('P99999904905', 'Zora Chatexec', 'Zq Chat Co', 'CEO', acc, 'Connect queued', 'lead', null, null, 'shal', 'Zedd via Quellivarn'),
    ('P99999904906', 'Zane Chathold', 'Zq Chat Hold Co', 'CIO', hold, 'Accepted', 'lead', now() - interval '1 hour', null, 'shal', 'Direct'),
    ('P99999904907', 'Zed Chatdeleted', 'Zq Chat Co', 'CFO', acc, 'Accepted', 'lead', now() - interval '1 hour', null, 'shal', 'Direct');
  insert into people(id, name, company, account_id, stage, review, accepted, workspace_id) values
    ('P99999904908', 'Zoe Chatother', 'Zq Chat Co', acc, 'Accepted', 'lead', now() - interval '1 hour', other);
  update people set deleted_at = now() where id = 'P99999904907';
  update people set replied = now() - interval '2 hours', dm1_sent = now() - interval '4 days' where id = 'P99999904902';
  insert into replies(person_id, account_id, status, snippet, received_at) values ('P99999904902', acc, 'new', 'Zq synthetic reply: what does it cost?', now() - interval '2 hours');
  c := public.ari_ai_chat_context('what is the angle for Zara Chatfirst at Zq Chat Co?', null, null);
  s := (c->'snapshot')::text;
  if s ~ 'Chatpersonal|Chatpending|Chatdeleted|Chatother' then raise exception 'FAIL 4: personal / pending / deleted / other workspace leaked'; end if;
  if s ~ 'Zora|Zedd|Quellivarn' then raise exception 'FAIL 4: exec track person or exec names in the snapshot'; end if;
  if not (c->'guard'->'deny_names') ? 'Zedd' or not (c->'guard'->'deny_names') ? 'Quellivarn' then raise exception 'FAIL 4: deny names %', c->'guard'->'deny_names'; end if;
  if (c->'guard'->'deny_names') ? 'Via' then raise exception 'FAIL 4: "via" in deny names'; end if;
  if (c->'snapshot'->'exec_track'->>'people')::int < 1 then raise exception 'FAIL 4: exec track count'; end if;
  r := to_jsonb((select array_agg(x->>'name' order by (x->>'rank')::int) from jsonb_array_elements(c->'snapshot'->'today'->'first_15') x where x->>'name' ~ '^Z[a-z]+ Chat'));
  if r is null or r->>0 <> 'Zeno Chatreply' or r->>1 <> 'Zara Chatfirst' then raise exception 'FAIL 4: Today order (reply first, then first message) %', r; end if;
  if r ? 'Zane Chathold' then raise exception 'FAIL 4: a Hold account person is on Today'; end if;
  if (select (x->>'draft_ready')::boolean from jsonb_array_elements(c->'snapshot'->'today'->'first_15') x where x->>'name' = 'Zara Chatfirst') is not true then
    raise exception 'FAIL 4: draft_ready'; end if;
  if (select count(*) from jsonb_array_elements(c->'snapshot'->'focus_people') x where x->>'name' = 'Zara Chatfirst') <> 1 then raise exception 'FAIL 4: focus person by name'; end if;
  if (select count(*) from jsonb_array_elements(c->'snapshot'->'focus_accounts') x where x->>'company' = 'Zq Chat Co') <> 1 then raise exception 'FAIL 4: focus account by name'; end if;
  if (select (x->>'exec_track_people')::int from jsonb_array_elements(c->'snapshot'->'focus_accounts') x where x->>'company' = 'Zq Chat Co') <> 1 then
    raise exception 'FAIL 4: account exec-track count'; end if;
  if (select (x->>'do_not_contact')::boolean from jsonb_array_elements(c->'snapshot'->'accounts') x where x->>'company' = 'Zq Chat Hold Co') is not true then
    raise exception 'FAIL 4: Hold account not marked do_not_contact'; end if;
  if not exists (select 1 from jsonb_array_elements(c->'guard'->'entities') e where e->>'name' = 'Zara Chatfirst' and e->>'kind' = 'person')
     or not exists (select 1 from jsonb_array_elements(c->'guard'->'entities') e where e->>'name' = 'Zq Chat Co' and e->>'kind' = 'account')
     or exists (select 1 from jsonb_array_elements(c->'guard'->'entities') e where e->>'name' ~ 'Chatpersonal|Chatexec|Chatother|Chatdeleted') then
    raise exception 'FAIL 4: entities'; end if;
  c := public.ari_ai_chat_context(null, 'P99999904902', null);
  if (c->'snapshot'->'focus_people'->0->'latest_reply'->>'status') <> 'new' then raise exception 'FAIL 4: focus by id / latest reply'; end if;
  if (c->'snapshot'->'last_24h'->'replied')::text !~ 'Zeno Chatreply' then raise exception 'FAIL 4: last_24h replies'; end if;
  raise notice 'ok 4 snapshot scope, exec track, deny names, Today order, focus, entities';

  raise exception 'ALL 0049 CHECKS PASSED (deliberate raise: nothing kept)';
end $$;
