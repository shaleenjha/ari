-- Synthetic rows only (fake companies on example.* domains, fake people). Inserted as postgres with triggers on.
insert into auth.users(id, email) values
  ('b14d1605-c766-4684-9a5b-71ffcab6967b', 'owner@example.com'),
  ('c0000000-0000-4000-8000-00000000000c', 'stranger@example.com'),
  ('d0000000-0000-4000-8000-00000000000d', 'member@example.com') on conflict do nothing;
insert into public.plays(name) values ('Residency play'), ('Tokenisation play');
insert into public.accounts(id, company) values
  ('00000000-0000-4000-8000-0000000000a1', 'Ostrevanthe Co'),
  ('00000000-0000-4000-8000-0000000000a2', 'Brennuvia Labs'),
  ('00000000-0000-4000-8000-0000000000a3', 'Dravequin Systems');
insert into public.people(id, name, company, account_id, stage) values
  ('PA9001', 'Alex Doe', 'Ostrevanthe Co', '00000000-0000-4000-8000-0000000000a1', 'Accepted'),
  ('PA9002', 'Sam Roe', 'Ostrevanthe Co', '00000000-0000-4000-8000-0000000000a1', 'DM1 sent'),
  ('PA9003', 'Jamie Poe', 'Brennuvia Labs', '00000000-0000-4000-8000-0000000000a2', 'Replied'),
  ('PA9004', 'Riley Coe', 'Dravequin Systems', '00000000-0000-4000-8000-0000000000a3', 'Connect queued'),
  ('PA9005', 'Casey Loe', 'Brennuvia Labs Inc', null, 'Connect sent');
insert into public.queue(id, action) values ('Q9001', 'Research Ostrevanthe Co'), ('Q9002', 'Map Dravequin Systems');
insert into public.account_briefs(account_id) values ('00000000-0000-4000-8000-0000000000a1');
insert into public.replies(person_id) values ('PA9003');
insert into public.log_entries(event, person_id) values ('Connect sent', 'PA9004'), ('Accepted', 'PA9001');
insert into public.events(actor, verb, person_id, payload) values ('you', 'marked_sent', 'PA9002', '{"k":"dm1"}'), ('system', 'brief_ready', null, '{}');
insert into public.notifications(title, kind) values ('Synthetic note', 'test');
insert into public.book(key, company) values ('example.com', 'Ostrevanthe Co');
insert into public.brief(key) values ('today');
insert into public.app_config(key, value) values ('synthetic_flag', 'on') on conflict do nothing;
insert into public.ari_prefs(key, value) values ('synthetic_pref', '1'::jsonb) on conflict do nothing;
insert into public.research(summary, source_url, account_id) values ('Synthetic research note', 'https://example.com/post', '00000000-0000-4000-8000-0000000000a1');
insert into public.tasks(title) values ('Synthetic job progress');
insert into public.threads(kind, title, entity_type) values ('item', 'Synthetic thread', 'account');
insert into public.decisions(question) values ('Synthetic decision?');
insert into public.ari_notes(body) values ('Synthetic note body');
insert into public.targets(week, metric) values ('2026-10-12', 'meetings');
insert into public.hygiene_findings(check_key, entity_type, entity_id) values ('no_account_link', 'person', 'PA9005');
insert into public.sent_messages(person_id, kind, body, sent_at, source) values ('PA9002', 'dm1', 'Hi Sam, synthetic DM.', now() - interval '2 days', 'tick')
  on conflict do nothing;
insert into public.scan_heartbeat(id) values (1) on conflict do nothing;
insert into public.sync_state(key, value) values ('base:People', '{}') on conflict do nothing;
