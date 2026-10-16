-- Synthetic seed shared by tests (two workspaces, no real names). Idempotent per fresh test database.
insert into app.workspaces(id, name) values ('aaaaaaaa-0000-0000-0000-000000000001', 'Workspace A'), ('bbbbbbbb-0000-0000-0000-000000000001', 'Workspace B')
  on conflict do nothing;
insert into auth.users(id, email) values
  ('a0000000-0000-0000-0000-00000000005d', 'sdr-a@example.com'), ('a0000000-0000-0000-0000-0000000000ae', 'ae-a@example.com'),
  ('a0000000-0000-0000-0000-000000000a2e', 'ae2-a@example.com'),
  ('a0000000-0000-0000-0000-00000000003a', 'mgr-a@example.com'), ('a0000000-0000-0000-0000-0000000000a9', 'agent-a@example.com'),
  ('b0000000-0000-0000-0000-00000000005d', 'sdr-b@example.com'), ('c0000000-0000-0000-0000-000000000000', 'stranger@example.com')
  on conflict do nothing;
insert into app.memberships(workspace_id, user_id, role, display_name) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000005d', 'sdr', 'Sam SDR'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000ae', 'ae', 'Alex AE'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000a2e', 'ae', 'Avery AE'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-00000000003a', 'manager', 'Morgan Manager'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-0000000000a9', 'agent', 'Ari'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'b0000000-0000-0000-0000-00000000005d', 'sdr', 'Blake SDR')
  on conflict do nothing;
insert into app.accounts(workspace_id, id, name, domain) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'Exquorra', 'exquorra.test'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c2', 'Brennuvia Co', 'sample.test'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'CANARY-B-ACCOUNT', 'canary-b.test')
  on conflict do nothing;
insert into app.account_team(workspace_id, account_id, user_id, role) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-00000000005d', 'sdr'),
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'a0000000-0000-0000-0000-0000000000ae', 'ae')
  on conflict do nothing;
insert into app.people(workspace_id, id, account_id, full_name, linkedin_url) values
  ('aaaaaaaa-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-0000000000d1', 'aaaaaaaa-0000-0000-0000-0000000000c1', 'Jordan Example', 'https://www.linkedin.com/in/jordan-example-123/'),
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000d1', 'bbbbbbbb-0000-0000-0000-0000000000c1', 'CANARY-B-PERSON', null)
  on conflict do nothing;
insert into app.tasks(workspace_id, id, kind, title, assignee_role, created_by, created_by_kind) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-0000000000e1', 'custom', 'CANARY-B-TASK', 'sdr', 'b0000000-0000-0000-0000-00000000005d', 'sdr')
  on conflict do nothing;
insert into app.activity(workspace_id, actor_kind, verb, subject_type) values ('bbbbbbbb-0000-0000-0000-000000000001', 'sdr', 'canary', 'workspace');
select 'ok seed';
