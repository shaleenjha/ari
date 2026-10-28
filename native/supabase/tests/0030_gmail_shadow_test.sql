-- 0030 tests: run on STAGING in one transaction; ends in a deliberate raise so nothing persists.
do $$
declare r jsonb := '{}'::jsonb; t text; v text; x jsonb; n int; d date := (now() at time zone 'Asia/Kolkata')::date - 1;
  base timestamptz := ((d::timestamp + interval '12 hours') at time zone 'Asia/Kolkata');
begin
  -- vanity
  if public.ari_li_vanity('https://www.linkedin.com/comm/in/Jane-Doe-123/?trk=x') <> 'jane-doe-123' then raise exception 'FAIL vanity'; end if;
  if public.ari_li_vanity('https://in.linkedin.com/in/abc') <> 'abc' then raise exception 'FAIL vanity2'; end if;
  -- privileges
  foreach t in array array['ari_gmail_hook()','ari_gmail_ticket_take(text)','ari_gmail_state_put(text,text)','ari_gmail_state_take(text)',
     'ari_gmail_connect(text,text)','ari_gmail_ingest_config()','ari_gmail_known_ids(text[])','ari_gmail_ingest_record(jsonb,bigint,integer,integer)',
     'ari_gmail_ingest_fail(text,boolean)','ari_gmail_ingest_kick()','ari_gmail_shadow_diff(date)','ari_gmail_match_person(text,text)'] loop
    if has_function_privilege('anon', 'public.' || t, 'execute') or has_function_privilege('authenticated', 'public.' || t, 'execute') then raise exception 'FAIL grant %', t; end if;
  end loop;
  foreach t in array array['ari_gmail_status()','ari_gmail_connect_ticket()','ari_gmail_disconnect()'] loop
    if has_function_privilege('anon', 'public.' || t, 'execute') then raise exception 'FAIL anon grant %', t; end if;
  end loop;
  foreach t in array array['gmail_connection','gmail_shadow_events','gmail_oauth_states','gmail_connect_tickets','gmail_ingest_runs','gmail_shadow_diffs'] loop
    if has_table_privilege('anon', 'public.' || t, 'select') or has_table_privilege('authenticated', 'public.' || t, 'select') then raise exception 'FAIL table grant %', t; end if;
  end loop;
  -- ticket: one-time
  insert into gmail_connect_tickets(ticket) values ('tk1');
  if not public.ari_gmail_ticket_take('tk1') or public.ari_gmail_ticket_take('tk1') then raise exception 'FAIL ticket one-time'; end if;
  insert into gmail_connect_tickets(ticket, created_at) values ('tk2', now() - interval '11 minutes');
  if public.ari_gmail_ticket_take('tk2') then raise exception 'FAIL ticket expiry'; end if;
  -- state: one-time
  perform public.ari_gmail_state_put('st1', 'ver1');
  if public.ari_gmail_state_take('st1') is distinct from 'ver1' or public.ari_gmail_state_take('st1') is not null then raise exception 'FAIL state'; end if;
  -- allowlist
  begin perform public.ari_gmail_connect('someone@example.com', 'tok'); raise exception 'FAIL allowlist';
  exception when insufficient_privilege then null; end;
  x := public.ari_gmail_connect(upper('owner@example.com'), 'synthetic-refresh-token');
  if (public.ari_gmail_ingest_config()->>'refresh_token') <> 'synthetic-refresh-token' then raise exception 'FAIL vault roundtrip'; end if;
  perform public.ari_gmail_connect('owner@example.com', 'synthetic-refresh-token-2');
  if (public.ari_gmail_ingest_config()->>'refresh_token') <> 'synthetic-refresh-token-2' then raise exception 'FAIL vault update'; end if;
  if (select count(*) from vault.secrets where name like 'ari_gmail_refresh_%') <> 1 then raise exception 'FAIL one secret'; end if;
  -- synthetic people
  insert into people(id, name, company, linkedin_url, accepted) values
    ('PTEST1', 'Zz Synthetic One', 'Ixterlane', 'https://www.linkedin.com/in/zz-synth-one', base),
    ('PTEST2', 'Zz Synthetic Two', 'Beta', 'https://www.linkedin.com/in/zz-synth-two', base + interval '3 hours'),
    ('PTEST3', 'Zz Synthetic Three', 'Gamma', 'https://www.linkedin.com/in/zz-synth-three', null);
  insert into replies(person_id, gmail_id, source, received_at) values ('PTEST3', 'gm-r1', 'gmail', base + interval '1 hour');
  -- ingest
  x := public.ari_gmail_ingest_record(jsonb_build_array(
     jsonb_build_object('msg_id','gm-a1','kind','accept','profile_url','https://www.linkedin.com/in/zz-synth-one','name','Zz Synthetic One','event_at', base + interval '4 minutes'),
     jsonb_build_object('msg_id','gm-a2','kind','accept','profile_url','https://www.linkedin.com/in/zz-synth-two','name','Zz Synthetic Two','event_at', base + interval '1 hour'),
     jsonb_build_object('msg_id','gm-r1','kind','reply','profile_url','https://www.linkedin.com/in/zz-synth-three','name','Zz Synthetic Three','event_at', base + interval '1 hour'),
     jsonb_build_object('msg_id','gm-u1','kind','accept','profile_url',null,'name','Nobody Known Here','event_at', base),
     jsonb_build_object('msg_id','gm-x1','kind','invite_sent','name','x','event_at', base)), 1000, 5, 5);
  if (x->>'stored')::int <> 4 then raise exception 'FAIL stored %', x; end if;
  x := public.ari_gmail_ingest_record(jsonb_build_array(jsonb_build_object('msg_id','gm-a1','kind','accept','event_at', base)), 500, 1, 1);
  if (x->>'stored')::int <> 0 then raise exception 'FAIL idempotent'; end if;
  if (select cursor_ms from gmail_connection) <> 1000 then raise exception 'FAIL cursor forward-only'; end if;
  if public.ari_gmail_known_ids(array['gm-a1','nope']) <> array['gm-a1'] then raise exception 'FAIL known ids'; end if;
  -- diff
  x := public.ari_gmail_shadow_diff(d);
  r := r || jsonb_build_object('diff', x);
  if (x->'counts'->>'match')::int < 2 or (x->'counts'->>'time_mismatch')::int < 1 or (x->'counts'->>'unmatched')::int < 1 then raise exception 'FAIL diff %', x; end if;
  if (x->>'agree')::boolean then raise exception 'FAIL agree should be false (time mismatch)'; end if;
  if (select report::text from gmail_shadow_diffs where night = d) ~ 'Zz Synthetic' then raise exception 'FAIL names in report'; end if;
  -- failure streak -> one alert
  perform public.ari_gmail_ingest_fail('e1'); perform public.ari_gmail_ingest_fail('e2');
  if exists (select 1 from notifications where dedupe_key like 'ops:gmail:%') then raise exception 'FAIL early alert'; end if;
  perform public.ari_gmail_ingest_fail('e3'); perform public.ari_gmail_ingest_fail('e4');
  if (select count(*) from notifications where dedupe_key like 'ops:gmail:%') <> 1 then raise exception 'FAIL alert count'; end if;
  perform public.ari_gmail_ingest_fail('invalid_grant', true);
  if (select status from gmail_connection) <> 'needs_reconnect' then raise exception 'FAIL reconnect'; end if;
  if public.ari_gmail_ingest_kick() is not null then raise exception 'FAIL kick while not connected'; end if;
  -- worker data untouched by shadow
  if (select accepted from people where id = 'PTEST2') <> base + interval '3 hours' then raise exception 'FAIL people touched'; end if;
  raise exception 'ALL 0030 TESTS PASSED %', r::text;
end $$;
