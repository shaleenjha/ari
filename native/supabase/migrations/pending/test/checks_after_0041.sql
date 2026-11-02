-- LOCAL/CI ONLY (throwaway prod-shape DB from run_local.sh). Checks for 0041 (Live AI layer). Synthetic data only; never run
-- on staging or prod (it flips ai_budget and writes synthetic people, replies and research).
\set ON_ERROR_STOP 1
do $$
declare r jsonb; n int; c1 bigint; pid text := 'PAI0041'; j1 jsonb; j2 jsonb; rid bigint;
begin
  -- 1. objects, RLS, grants, cron, ledger
  select count(*) into n from pg_class where relname in ('ai_budget', 'ai_calls', 'ai_jobs', 'ai_triggers', 'gmail_watch') and relrowsecurity;
  if n <> 5 then raise exception 'FAIL 1: RLS not on all 5 tables (%)', n; end if;
  if has_table_privilege('anon', 'public.ai_calls', 'select') or has_table_privilege('authenticated', 'public.ai_calls', 'insert')
     or has_table_privilege('authenticated', 'public.ai_budget', 'update') or has_table_privilege('authenticated', 'public.ai_triggers', 'select')
     then raise exception 'FAIL 1: table grants too wide'; end if;
  if not has_table_privilege('authenticated', 'public.ai_jobs', 'select') then raise exception 'FAIL 1: owner cannot read ai_jobs'; end if;
  if not has_table_privilege('service_role', 'public.ai_calls', 'insert') then raise exception 'FAIL 1: service_role grant missing'; end if;
  if has_function_privilege('authenticated', 'public.ari_ai_budget_reserve(text, text, text, numeric, text, uuid, uuid, text)', 'execute')
     or has_function_privilege('anon', 'public.ari_ai_caller()', 'execute')
     or has_function_privilege('authenticated', 'public.ari_ai_save_draft(text, text, text, jsonb, text, text)', 'execute')
     or has_function_privilege('authenticated', 'public.ari_ai_hook()', 'execute')
     then raise exception 'FAIL 1: function grants too wide'; end if;
  if not has_function_privilege('authenticated', 'public.ari_ai_caller()', 'execute')
     or not has_function_privilege('service_role', 'public.ari_ai_save_draft(text, text, text, jsonb, text, text)', 'execute')
     then raise exception 'FAIL 1: function grants missing'; end if;
  if exists (select 1 from pg_roles where rolname = 'ari_worker') and (has_table_privilege('ari_worker', 'public.ai_calls', 'select')
     or has_function_privilege('ari_worker', 'public.ari_ai_context(text, uuid)', 'execute')) then raise exception 'FAIL 1: ari_worker has access'; end if;
  select count(*) into n from cron.job where jobname in ('ari-ai-events', 'ari-gmail-watch-renew', 'ari-ai-prune');
  if n <> 3 then raise exception 'FAIL 1: cron jobs (%)', n; end if;
  if not exists (select 1 from supabase_migrations.schema_migrations where version = '0041') then raise exception 'FAIL 1: ledger'; end if;
  if public.ari_ai_hook() is null or length(public.ari_ai_hook()) < 32 then raise exception 'FAIL 1: hook secret'; end if;
  raise notice 'ok 1 objects, RLS, grants, cron, ledger';

  -- 2. budget: off by default, caps, bad estimates, one alert per cap per period, finish books real cost
  if (select enabled from ai_budget) then raise exception 'FAIL 2: budget enabled by default'; end if;
  if (select monthly_cap_usd from ai_budget) <> 50 then raise exception 'FAIL 2: default monthly cap is not 50'; end if;
  if public.ari_ai_kick() is not null then raise exception 'FAIL 2: kick ran while disabled'; end if;
  r := public.ari_ai_budget_reserve('draft', 'anthropic', 'm', 0.01);
  if (r->>'ok')::boolean or r->>'reason' <> 'disabled' then raise exception 'FAIL 2: disabled reserve %', r; end if;
  update ai_budget set enabled = true, monthly_cap_usd = 30, daily_cap_usd = 100;   -- test the cap at 30
  delete from ai_calls;
  r := public.ari_ai_budget_reserve('draft', 'anthropic', 'm', 0);
  if r->>'reason' <> 'bad_estimate' then raise exception 'FAIL 2: zero estimate %', r; end if;
  r := public.ari_ai_budget_reserve('draft', 'anthropic', 'm', 4.5, pid);
  if not (r->>'ok')::boolean then raise exception 'FAIL 2: first reserve %', r; end if;
  c1 := (r->>'call_id')::bigint;
  perform public.ari_ai_call_finish(c1, 'ok', 1000, 200, 0.02);
  if (select est_cost_usd from ai_calls where id = c1) <> 0.02 then raise exception 'FAIL 2: finish not booked'; end if;
  perform public.ari_ai_call_finish(c1, 'error', 1, 1, 9);   -- second finish is ignored
  if (select est_cost_usd from ai_calls where id = c1) <> 0.02 then raise exception 'FAIL 2: finish not idempotent'; end if;
  for n in 1..6 loop perform public.ari_ai_budget_reserve('deep_research', 'xai', 'g', 4.9); end loop;   -- 6 x 4.9 = 29.4 reserved
  r := public.ari_ai_budget_reserve('rewrite', 'anthropic', 'm', 0.7);
  if (r->>'ok')::boolean or r->>'reason' <> 'monthly_cap' then raise exception 'FAIL 2: monthly cap %', r; end if;
  perform public.ari_ai_budget_reserve('rewrite', 'anthropic', 'm', 0.7);
  select count(*) into n from notifications where dedupe_key like 'ops:aicap:monthly_cap:%';
  if n <> 1 then raise exception 'FAIL 2: cap alert count %', n; end if;
  delete from ai_calls; update ai_budget set daily_cap_usd = 5;
  perform public.ari_ai_budget_reserve('draft', 'anthropic', 'm', 4);
  r := public.ari_ai_budget_reserve('draft', 'anthropic', 'm', 2);
  if r->>'reason' <> 'daily_cap' then raise exception 'FAIL 2: daily cap %', r; end if;
  if (select count(*) from ai_calls where status = 'refused') <> 1 then raise exception 'FAIL 2: refused not logged'; end if;
  delete from ai_calls; update ai_budget set daily_cap_usd = 5;
  raise notice 'ok 2 budget: off by default, monthly and daily caps, bad estimate, one alert, finish once';

  -- 3. drafts: empty slot, own unedited text, Owner's edit kept, expect check, dash, sent, personal
  insert into people(id, name, company, stage, accepted) values (pid, 'Synthetic Person', 'Ostrevanthe Co', 'Accepted', now() - interval '1 hour')
    on conflict (id) do update set dm = null, dm1_sent = null, review = null, deleted_at = null, extra = '{}'::jsonb;
  r := public.ari_ai_save_draft(pid, 'dm', 'Hi Synthetic, saw Ostrevanthe Co shipped its new vault.', '{"confidence":0.8}', null, 'dm1_auto');
  if not (r->>'saved')::boolean then raise exception 'FAIL 3: empty slot %', r; end if;
  r := public.ari_ai_save_draft(pid, 'dm', 'Hi Synthetic, second take.', '{}', null, 'dm1_auto');
  if not (r->>'saved')::boolean then raise exception 'FAIL 3: over own text %', r; end if;
  update people set dm = 'Owner edited this.' where id = pid;
  r := public.ari_ai_save_draft(pid, 'dm', 'Ari again.', '{}', null, 'dm1_auto');
  if r->>'reason' <> 'kept_existing' or (select dm from people where id = pid) <> 'Owner edited this.' then raise exception 'FAIL 3: edit overwritten %', r; end if;
  r := public.ari_ai_save_draft(pid, 'dm', 'Rewrite.', '{}', 'stale text', 'rewrite');
  if r->>'reason' <> 'changed' then raise exception 'FAIL 3: stale expect %', r; end if;
  r := public.ari_ai_save_draft(pid, 'dm', 'Rewrite, shorter.', '{"chip":"shorter"}', 'Owner edited this.', 'rewrite');
  if not (r->>'saved')::boolean or (select extra #>> '{ai,dm,prev}' from people where id = pid) <> 'Owner edited this.' then raise exception 'FAIL 3: rewrite %', r; end if;
  r := public.ari_ai_save_draft(pid, 'dm', 'A dash ' || chr(8212) || ' here.', '{}', 'Rewrite, shorter.', 'rewrite');
  if r->>'reason' <> 'dash' then raise exception 'FAIL 3: dash %', r; end if;
  update people set dm1_sent = now() where id = pid;
  r := public.ari_ai_save_draft(pid, 'dm', 'After send.', '{}', 'Rewrite, shorter.', 'rewrite');
  if r->>'reason' <> 'already_sent' then raise exception 'FAIL 3: sent %', r; end if;
  update people set dm1_sent = null, review = 'personal' where id = pid;
  r := public.ari_ai_save_draft(pid, 'dm', 'Personal.', '{}', 'Rewrite, shorter.', 'rewrite');
  if r->>'reason' <> 'personal' then raise exception 'FAIL 3: personal %', r; end if;
  begin perform public.ari_ai_context(pid, null); raise exception 'FAIL 3: context for personal'; exception when insufficient_privilege then null; end;
  update people set review = null where id = pid;
  if (public.ari_ai_context(pid, null) #>> '{person,first_name}') <> 'Synthetic' then raise exception 'FAIL 3: context'; end if;
  raise notice 'ok 3 drafts: empty, own text, edit kept, expect, dash, sent, personal';

  -- 4. replies: triage through the worker validator, one-draft rewrite with expect
  insert into replies(person_id, status, snippet) values (pid, 'new', 'Sounds interesting, what does it cost?') returning id into rid;
  perform public.ari_ai_save_triage(rid, '[{"key":"book","label":"Book","body":"Happy to walk you through it on a short call this week?"},
    {"key":"answer","label":"Answer","body":"Pricing depends on volume; I can share ranges."},{"key":"soft","label":"Soft","body":"Glad it caught your eye."}]',
    '{"intent":"question","urgency":"high","summary":"Asked about price","needs_review":false}');
  if (select ai_triage->>'intent' from replies where id = rid) <> 'question' then raise exception 'FAIL 4: triage'; end if;
  r := public.ari_ai_save_reply_draft(rid, 'answer', 'Pricing scales with volume; ranges are easy to share.', 'Pricing depends on volume; I can share ranges.');
  if not (r->>'saved')::boolean then raise exception 'FAIL 4: reply rewrite %', r; end if;
  r := public.ari_ai_save_reply_draft(rid, 'answer', 'Again.', 'old');
  if r->>'reason' <> 'changed' then raise exception 'FAIL 4: reply expect %', r; end if;
  raise notice 'ok 4 replies: triage drafts and one-draft rewrite';

  -- 5. research: rows deduped, brief on the person, bad urls dropped
  delete from research where person_id = pid;   -- re-runnable: the rollback keeps research rows on purpose
  r := public.ari_ai_save_research(pid, null, '[{"fact":"Ostrevanthe Co raised a round","source_url":"https://example.com/a","dated":"2026-10-01"},
    {"fact":"bad","source_url":"javascript:alert(1)"}]', '{"summary":"s","kind":"quick"}');
  if (r->>'inserted')::int <> 1 then raise exception 'FAIL 5: insert %', r; end if;
  r := public.ari_ai_save_research(pid, null, '[{"fact":"Ostrevanthe Co raised a round","source_url":"https://example.com/a"}]', null);
  if (r->>'inserted')::int <> 0 then raise exception 'FAIL 5: dedupe %', r; end if;
  raise notice 'ok 5 research rows deduped';

  -- 6. jobs: dedupe while open, claim, done -> one generic brief push
  j1 := public.ari_ai_job_enqueue(pid, null, 'focus', '[{"seq":1,"type":"status","text":"Queued"}]');
  j2 := public.ari_ai_job_enqueue(pid, null, 'focus', '[]');
  if j1->>'id' <> j2->>'id' or not (j2->>'existing')::boolean then raise exception 'FAIL 6: job dedupe'; end if;
  if (public.ari_ai_job_claim((j1->>'id')::uuid))->>'status' <> 'running' then raise exception 'FAIL 6: claim'; end if;
  if public.ari_ai_job_claim((j1->>'id')::uuid) is not null then raise exception 'FAIL 6: double claim'; end if;
  -- live feed: seq assigned in order, read after a seq, capped at 300
  if public.ari_ai_job_event((j1->>'id')::uuid, '[{"type":"query","source":"x","query":"q1"},{"type":"read","url":"https://example.com/p","title":"T","domain":"example.com"}]') <> 3
    then raise exception 'FAIL 6: event seq'; end if;
  r := public.ari_ai_job_events((j1->>'id')::uuid, 1);
  if jsonb_array_length(r->'events') <> 2 or r #>> '{events,0,type}' <> 'query' or (r #>> '{events,1,seq}')::int <> 3 then raise exception 'FAIL 6: events after seq %', r; end if;
  for n in 1..7 loop perform public.ari_ai_job_event((j1->>'id')::uuid, (select jsonb_agg(jsonb_build_object('type','finding','fact','f'||g)) from generate_series(1,50) g)); end loop;
  if jsonb_array_length((select steps from ai_jobs where id = (j1->>'id')::uuid)) <> 300 then raise exception 'FAIL 6: feed cap'; end if;
  perform public.ari_ai_job_update((j1->>'id')::uuid, null, 'done', '{"summary":"x"}', null);
  if public.ari_ai_job_events((j1->>'id')::uuid, 99999)->>'status' <> 'done' then raise exception 'FAIL 6: status in events'; end if;
  if not exists (select 1 from notifications where dedupe_key = 'brief:ai:' || (j1->>'id')) then raise exception 'FAIL 6: brief push'; end if;
  raise notice 'ok 6 jobs: dedupe, claim lease, live event feed (seq, since, cap), done push';

  -- 7. event path: accept email pending until claimed; claim is once; dm1 owed for the accepted person
  delete from ai_triggers;
  update people set dm = null, linkedin_url = 'https://www.linkedin.com/in/synthetic-person' where id = pid;
  insert into gmail_shadow_events(msg_id, kind, profile_url, name, event_at)
    values ('msg-0041-a', 'accept', 'https://www.linkedin.com/in/synthetic-person', 'Synthetic Person', now()) on conflict do nothing;
  r := public.ari_ai_pending_events(20);
  if not (r->'accepts' @> '[{"msg_id":"msg-0041-a","match":"PAI0041"}]') then raise exception 'FAIL 7: pending accept %', r; end if;
  if not (r->'dm1_needed' @> to_jsonb(array[pid])) then raise exception 'FAIL 7: dm1 owed %', r; end if;
  if not public.ari_ai_trigger_claim('accept', 'msg-0041-a') then raise exception 'FAIL 7: first claim'; end if;
  if public.ari_ai_trigger_claim('accept', 'msg-0041-a') then raise exception 'FAIL 7: second claim'; end if;
  if (public.ari_ai_pending_events(20)->'accepts') @> '[{"msg_id":"msg-0041-a"}]' then raise exception 'FAIL 7: claimed still pending'; end if;
  perform public.ari_ai_notify_dm_ready(pid); perform public.ari_ai_notify_dm_ready(pid);
  select count(*) into n from notifications where dedupe_key = 'draft:dm1:ai:' || pid;
  if n <> 1 then raise exception 'FAIL 7: dm ready push count %', n; end if;
  if (select title from notifications where dedupe_key = 'draft:dm1:ai:' || pid) <> 'DM1 ready' then raise exception 'FAIL 7: push title not generic'; end if;
  raise notice 'ok 7 event path: pending, claim once, one generic DM1 push';

  -- 8. watch kick is a no-op until a topic is configured
  if public.ari_gmail_watch_kick() is not null then raise exception 'FAIL 8: watch kick without topic'; end if;
  raise notice 'ok 8 watch renew off until configured';
  update ai_budget set enabled = false, monthly_cap_usd = 50, daily_cap_usd = 5;
  raise notice 'ALL 0041 TESTS PASSED';
end $$;
