-- LOCAL / CI ONLY (throwaway prod-shape database; never staging or prod): put the database in the state prod is in before
-- 0038, with synthetic rows only. Committed, so 0038 has something to act on.
--   * 0036's worker Log functions exist (prod has ari_worker_log_repair, applied by hand).
--   * notifications written before 0016 carry names: inserted with triggers off, the way they were written on Oct 16.
\set ON_ERROR_STOP on
\ir ../0036_log_repair_rpc.sql
begin;
set local session_replication_role = replica;   -- skip the BEFORE INSERT privacy trigger and the push kick
create table if not exists public.chk38_notif (dedupe_key text primary key, kind text, sent_at timestamptz);
insert into public.notifications(kind, dedupe_key, title, body, url, person_id, created_at, sent_at, attempts) values
  ('accepted',      'chk38:accepted:PA9038',       'Check Person 0038 accepted', 'Synthetic Check Co. DM1 draft is ready.', '/ops?open=person:PA9038', 'PA9038', '2026-10-16 03:00+00', '2026-10-16 03:01+00', 1),
  ('replied',       'chk38:replied:PA9038',        'Check Person 0038 replied',  'Synthetic Check Co. Paste it in.',        '/ops?open=person:PA9038', 'PA9038', '2026-10-16 04:00+00', '2026-10-16 04:01+00', 1),
  ('meeting',       'chk38:meeting:PA9038',        'Meeting set with Check Person 0038', 'Synthetic Check Co. Log it in SFDC.', '/ops?open=person:PA9038', 'PA9038', '2026-10-16 05:00+00', null, 0),
  ('research_done', 'rescan:chk38',                'Re-scan: Synthetic Check Co', 'Check Person 0038 moved teams',          '/ops', null, '2026-10-16 06:00+00', '2026-10-16 06:01+00', 1),
  ('research_done', 'brief:chk38',                 'Brief ready: Synthetic Check Co', 'Thesis naming Check Person 0038',   '/ops', null, '2026-10-16 07:00+00', '2026-10-16 07:01+00', 1),
  ('draft_due',     'draft:dm1:chk38',             'DM1 for Check Person 0038', 'Synthetic Check Co',                      '/ops', 'PA9038', '2026-10-16 08:00+00', '2026-10-16 08:01+00', 1),
  ('draft_due',     'draft:dm2:chk38',             'DM2 for Check Person 0038', 'Synthetic Check Co',                      '/ops', 'PA9038', '2026-10-16 09:00+00', '2026-10-16 09:01+00', 1),
  ('draft_due',     'draft:dm3:chk38',             'DM3 for Check Person 0038', 'Synthetic Check Co',                      '/ops', 'PA9038', '2026-10-16 10:00+00', '2026-10-16 10:01+00', 1),
  ('draft_due',     'draft:other:chk38',           'Draft for Check Person 0038', 'Synthetic Check Co',                    '/ops', 'PA9038', '2026-10-16 11:00+00', '2026-10-16 11:01+00', 1),
  ('test',          'chk38:test',                  'Test ping', 'Owner note kept as written',                              '/ops', null, '2026-10-16 12:00+00', '2026-10-16 12:01+00', 1)
on conflict (dedupe_key) do nothing;
insert into public.chk38_notif select dedupe_key, kind, sent_at from public.notifications where dedupe_key like '%chk38%' on conflict do nothing;
commit;
