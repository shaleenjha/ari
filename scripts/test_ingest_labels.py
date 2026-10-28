"""Tests for scripts/ingest_labels.py (spec docs/specs/09-ingest-labels.md, step 1). Synthetic data only."""
import os, re, sys, json, copy, unittest
sys.path.insert(0, os.path.dirname(__file__))
import ingest_labels as il

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SQL = os.path.join(ROOT, 'native', 'supabase', 'migrations', 'pending', '0044_event_labels.sql')
ACC = 'a0000000-0000-4000-8000-000000000001'


def ctx():
    people = [
        {'id': 'P901', 'account_id': ACC, 'company': 'Examplecorp', 'owner': 'Alex Rivera', 'name': 'Jordan Quill',
         'title': 'VP Platform Engineering', 'review': 'lead', 'why_this_person': 'Play A: owns the data platform',
         'ts_approx': [], 'accepted_source': 'gmail', 'connect_sent': '2026-10-20T10:15:00+05:30',
         'accepted': '2026-10-21T09:00:30+05:30', 'dm1_sent': '2026-10-21T18:05:00+05:30', 'dm2_due': '2026-10-24',
         'dm2_sent': '2026-10-26T11:00:00+05:30', 'dm3_sent': None, 'replied': '2026-10-27T08:00:00+05:30', 'withdrawn': None},
        {'id': 'P902', 'account_id': ACC, 'company': 'Examplecorp', 'owner': 'Alex Rivera', 'name': 'Casey Thornbury',
         'title': 'Chief Privacy Officer', 'review': 'lead', 'why_this_person': '', 'ts_approx': ['connect_sent'],
         'accepted_source': None, 'connect_sent': '2026-10-14T12:00:00+05:30', 'accepted': None, 'dm1_sent': None,
         'withdrawn': '2026-10-27T09:30:00+05:30'},
        {'id': 'P903', 'account_id': None, 'company': 'Personal Co', 'owner': None, 'name': 'Sam Friend', 'title': 'Engineer',
         'review': 'personal', 'ts_approx': [], 'connect_sent': '2026-10-20T10:00:00+05:30'},
    ]
    accounts = [{'id': ACC, 'company': 'Examplecorp', 'owner': 'Alex Rivera', 'ae': 'Alex', 'meeting_status': None}]
    logs = [{'id': 1, 'ts': '2026-10-20T10:16:00+05:30', 'person_id': 'P901', 'event': 'Connect sent', 'detail': 'Examplecorp', 'source': 'app'},
            {'id': 2, 'ts': '2026-10-20T10:17:00+05:30', 'person_id': 'P901', 'event': 'Connect sent', 'detail': 'Examplecorp', 'source': 'app'},
            {'id': 3, 'ts': '2026-10-21T09:00:30+05:30', 'person_id': 'P901', 'event': 'Accepted', 'detail': 'gmail', 'source': 'hark'},
            {'id': 4, 'ts': '2026-10-26T10:59:00+05:30', 'person_id': 'P901', 'event': 'Ari edit switch', 'detail': 'dm2 · F1 > F2', 'source': 'app'},
            {'id': 5, 'ts': '2026-10-20T10:00:00+05:30', 'person_id': 'P903', 'event': 'Connect sent', 'detail': '', 'source': 'app'},
            {'id': 6, 'ts': '2026-10-15T16:10:00+05:30', 'person_id': None, 'event': 'Meeting set', 'detail': 'Examplecorp (from AE)', 'source': 'backfill'}]
    messages = [{'id': 41, 'kind': 'dm1', 'sent_at': '2026-10-21T18:05:00+05:30', 'company': 'Examplecorp', 'edit_diff': None,
                 'tags': {'structure': 'ae1 alex style', 'hook_kind': 'launch'}},
                {'id': 42, 'kind': 'dm2', 'sent_at': '2026-10-26T11:00:00+05:30', 'company': 'Examplecorp',
                 'edit_diff': {'ops': [{'op': '=', 't': 'a b'}, {'op': '+', 't': 'c d e'}, {'op': '-', 't': 'f'}]}, 'tags': None}]
    signals = [{'date': '2026-10-14', 'company': 'Examplecorp', 'signal': 'Raised $20M to launch agents',
                'source_url': 'https://news.example.com/x', 'signal_date': '2026-10-10'},
               {'date': '2026-10-14', 'company': 'Nowhere Inc', 'signal': 'x', 'source_url': 'https://a.example.org', 'signal_date': ''}]
    return {'people': people, 'accounts': accounts, 'book': [{'company': 'Examplecorp', 'tier': 'Target A'}],
            'logs': logs, 'messages': messages, 'signals': signals, 'scan': None}


def rows_of(c):
    rows, unl = il.build(c)
    return {(r['event_type'], r['dedupe_key']): r for r in rows}, unl


class Idempotency(unittest.TestCase):
    def test_same_input_same_rows(self):
        a, _ = il.build(ctx()); b, _ = il.build(ctx())
        self.assertEqual(json.dumps(a, sort_keys=True), json.dumps(b, sort_keys=True))

    def test_keys_unique_and_stable(self):
        rows, _ = il.build(ctx())
        keys = [(r['event_type'], r['dedupe_key']) for r in rows]
        self.assertEqual(len(keys), len(set(keys)))
        self.assertIn(('connect_sent', 'P901:connect_sent'), keys)
        self.assertIn(('dm_sent', 'P901:dm_sent:2'), keys)
        self.assertIn(('reply', 'P901:reply:first'), keys)
        self.assertIn(('meeting_booked', 'acct-%s:meeting_booked' % ACC), keys)

    def test_duplicate_or_reordered_log_rows_add_nothing(self):
        c = ctx(); c['logs'] = list(reversed(c['logs'])) + [dict(c['logs'][0], id=99)]
        self.assertEqual(set(rows_of(c)[0]), set(rows_of(ctx())[0]))

    def test_natural_key_wins(self):
        self.assertEqual(il.dedupe_key('reply', 'P1', 'first', natural='18c2f'), 'reply:18c2f')
        with self.assertRaises(ValueError): il.dedupe_key('withdraw')

    def test_personal_never_labeled(self):
        rows, unl = il.build(ctx())
        self.assertFalse([r for r in rows if r['person_id'] == 'P903'])
        self.assertIn('P903', unl['personal or deleted person (never labeled)'])


class NoPII(unittest.TestCase):
    NAMES = {'jordan quill', 'jordan', 'quill', 'examplecorp', 'alex', 'rivera'}

    def test_every_built_row_is_clean(self):
        c = ctx(); rows, _ = il.build(c)
        names = il.known_names(c)
        self.assertTrue({'jordan', 'quill', 'alex', 'examplecorp'} <= names)
        for r in rows:
            self.assertEqual(il.check_row(r, names), [], r)
            blob = json.dumps(r['labels']).lower()
            for n in ('jordan', 'quill', 'examplecorp', 'alex', 'http', '@'):
                self.assertNotIn(n, blob)

    def test_structure_keeps_code_only(self):
        self.assertEqual(il.structure_code('ae2 Alex style'), 'ae2')
        self.assertEqual(il.structure_code('f1 the reason i asked'), 'f1')

    def test_rejects_text_names_links(self):
        bad = [({'structure': 'hi jordan quill'}, 'known name'), ({'structure': 'mail me x@example.com'}, 'slug'),
               ({'structure': 'see linkedin in jq'}, 'contact data or a link'), ({'source_domain': 'https://x.com/a'}, None),
               ({'nope': 1}, 'unknown key'), ({'structure': 'x' * 41}, 'over 40'), ({'hook_kind': 'gossip'}, 'vocabulary'),
               ({'edited': 'yes'}, 'not bool'), ({'play': 'Enterprise AI, Alex (Examplecorp)'}, None)]
        for labels, why in bad:
            t = 'signal_found' if 'source_domain' in labels else 'dm_sent'
            f = il.check_labels(t, labels, self.NAMES)
            self.assertTrue(f, labels)
            if why: self.assertTrue(any(why in x for x in f), (labels, f))

    def test_message_text_never_kept(self):
        rows, _ = il.build(ctx())
        for r in rows: self.assertTrue(set(r['labels']) <= set(il.vocab_json()[r['event_type']]))

    def test_code_cannot_set_judged_labels(self):
        rows, _ = il.build(ctx()); r = copy.deepcopy(next(x for x in rows if x['event_type'] == 'reply'))
        r['labels']['intent'] = 'interested'
        self.assertTrue(any('judged' in f for f in il.check_row(r)))


class Approx(unittest.TestCase):
    def test_rules(self):
        T = il.ts
        self.assertTrue(il.approx_of(T('2026-10-15T18:30:00+05:30')))          # before Oct 16 IST
        self.assertFalse(il.approx_of(T('2026-10-16T00:00:01+05:30')))
        self.assertTrue(il.approx_of(T('2026-10-20T12:00:00+05:30')))          # bare date (0028 rule)
        self.assertTrue(il.approx_of(T('2026-10-20T00:00:00+05:30')))
        self.assertTrue(il.approx_of(T('2026-10-20T10:00:00+05:30'), flagged=True))
        self.assertFalse(il.approx_of(T('2026-10-20T10:00:00+05:30')))
        self.assertTrue(il.approx_of(T('2026-10-15T20:00:00+00:00')) is False)  # = Oct 16 01:30 IST

    def test_merge_earlier_exact_wins_and_disagreement_marks(self):
        T = il.ts
        at, ap, ref = il.merge_times([(T('2026-10-20T12:00:00+05:30'), True, 'a'), (T('2026-10-20T10:15:00+05:30'), False, 'b')])
        self.assertEqual((at.hour, at.minute, ref), (10, 15, 'b')); self.assertTrue(ap)   # 1h45 apart -> approx
        at, ap, _ = il.merge_times([(T('2026-10-20T10:15:00+05:30'), False, 'a'), (T('2026-10-20T10:17:00+05:30'), False, 'b')])
        self.assertFalse(ap)

    def test_built_rows(self):
        r, _ = rows_of(ctx())
        self.assertFalse(r[('connect_sent', 'P901:connect_sent')]['approx'])
        self.assertEqual(r[('connect_sent', 'P901:connect_sent')]['labels']['hour_local'], 10)
        p2 = r[('connect_sent', 'P902:connect_sent')]
        self.assertTrue(p2['approx']); self.assertIsNone(p2['labels']['hour_local'])
        self.assertTrue(r[('meeting_booked', 'acct-%s:meeting_booked' % ACC)]['approx'])
        self.assertTrue(all(x['approx'] for k, x in r.items() if k[0] == 'signal_found'))


class Labels(unittest.TestCase):
    def test_values(self):
        r, unl = rows_of(ctx())
        a = r[('accept', 'P901:accept')]['labels']
        self.assertEqual((a['accept_via'], a['days_to_accept']), ('gmail', 0.9))
        d1, d2 = r[('dm_sent', 'P901:dm_sent:1')], r[('dm_sent', 'P901:dm_sent:2')]
        self.assertEqual(d1['source_ref'], 'sent_messages.41')
        self.assertEqual((d1['labels']['structure'], d1['labels']['hook_kind'], d1['labels']['edited']), ('ae1', 'launch', False))
        self.assertEqual((d2['labels']['words_changed'], d2['labels']['switched'], d2['labels']['late_days']), (4, True, 2))
        rp = r[('reply', 'P901:reply:first')]
        self.assertTrue(rp['needs_review']); self.assertIsNone(rp['labels']['intent']); self.assertEqual(rp['labels']['reply_to_step'], '2')
        self.assertEqual(r[('withdraw', 'P902:withdraw')]['labels']['reason'], 'manual')
        sig = [x for k, x in r.items() if k[0] == 'signal_found'][0]['labels']
        self.assertEqual((sig['hook_kind'], sig['signal_age_days'], sig['source_domain']), ('funding', 4, 'news.example.com'))
        self.assertEqual(len(unl['signal for a company with no account']), 1)

    def test_dry_run_only(self):
        self.assertEqual(il.main(['backfill']), 2)


class SqlParity(unittest.TestCase):
    def test_0044_embeds_the_same_vocabulary(self):
        with open(SQL) as fh: sql = fh.read()
        m = re.search(r"-- VOCAB-BEGIN.*?\$vocab\$(.*?)\$vocab\$.*?-- VOCAB-END", sql, re.S)
        self.assertIsNotNone(m, 'VOCAB block missing in 0044')
        self.assertEqual(json.loads(m.group(1)), il.vocab_json())

    def test_0044_grants(self):
        with open(SQL) as fh: sql = fh.read()
        self.assertIn('to service_role', sql)
        self.assertRegex(sql, r'grant execute on function public\.ari_worker_event_record\([^)]*\) to ari_worker, service_role')
        self.assertIn('enable row level security', sql)


if __name__ == '__main__':
    unittest.main()
