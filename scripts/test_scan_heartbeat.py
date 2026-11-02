import sys, os, json, unittest, tempfile, datetime as dt
sys.path.insert(0, os.path.dirname(__file__))
import scan_heartbeat as S
B1, B2, B3 = list(S.BOOKS)[:3]   # the three AE books from scripts/seller_config.py
IST = S.IST
def t(y, m, d, H, M): return dt.datetime(y, m, d, H, M, tzinfo=IST)
TUE = t(2026, 10, 20, 4, 30)                      # Tue 20 Oct 2026 04:30 slot
ARMED = t(2026, 10, 19, 15, 0)
def hb(start=None, fin=None, n=None, err=None):
    return {'started_at': start.isoformat() if start else None, 'finished_at': fin.isoformat() if fin else None,
            'accounts_processed': n, 'errors': err}
OK = {b: hb(t(2026, 10, 20, 4, 30), t(2026, 10, 20, 5, 10), 35) for b in S.BOOKS}

class Due(unittest.TestCase):
    def test_not_due_inside_grace(self):
        self.assertEqual(S.latest_due_slot(t(2026, 10, 20, 5, 14)), t(2026, 10, 17, 4, 30))  # Sat 17
        self.assertEqual(S.evaluate(t(2026, 10, 20, 5, 14), {}, ARMED), [])   # Sat slot is before arming
    def test_due_after_grace(self):
        self.assertEqual(S.latest_due_slot(t(2026, 10, 20, 5, 15)), TUE)
    def test_no_slot_sun_mon(self):
        self.assertEqual(S.latest_due_slot(t(2026, 10, 19, 23, 0)), t(2026, 10, 17, 4, 30))   # Mon night -> Sat
    def test_disarmed_never_alerts(self):
        self.assertEqual(S.evaluate(t(2026, 10, 20, 7, 0), {}, None), [])

class Kinds(unittest.TestCase):
    now = t(2026, 10, 20, 7, 5)
    def kinds(self, hbs): return {(b, k) for b, _, k, _ in S.evaluate(self.now, hbs, ARMED)}
    def test_all_ok(self): self.assertEqual(self.kinds(OK), set())
    def test_missing_start(self):
        h = dict(OK, **{B3: None}); self.assertEqual(self.kinds(h), {(B3, 'missed')})
    def test_old_heartbeat_is_missing(self):
        h = dict(OK, **{B2: hb(t(2026, 10, 17, 4, 29), t(2026, 10, 17, 5, 0), 30)})
        self.assertEqual(self.kinds(h), {(B2, 'missed')})
    def test_early_start_counts(self):
        h = dict(OK, **{B2: hb(t(2026, 10, 20, 4, 29), t(2026, 10, 20, 5, 0), 30)}); self.assertEqual(self.kinds(h), set())
    def test_zero_processed(self):
        h = dict(OK, **{B1: hb(TUE, t(2026, 10, 20, 5, 0), 0, 'sheet 403')})
        f = S.evaluate(self.now, h, ARMED); self.assertEqual([(x[0], x[2]) for x in f], [(B1, 'zero')])
        self.assertIn('0 accounts', S.message(*f[0])); self.assertIn('sheet 403', S.message(*f[0]))
    def test_running_not_stuck_yet(self):
        h = dict(OK, **{B3: hb(t(2026, 10, 20, 5, 30))}); self.assertEqual(self.kinds(h), set())
    def test_stuck(self):
        h = dict(OK, **{B3: hb(t(2026, 10, 20, 4, 31))}); self.assertEqual(self.kinds(h), {(B3, 'stuck')})

class Dedupe(unittest.TestCase):
    def test_once_per_book_slot(self):
        st = {}
        f = S.evaluate(t(2026, 10, 20, 7, 5), dict(OK, **{B3: None}), ARMED)
        self.assertEqual(len(S.dedupe(f, st)), 1)
        self.assertEqual(S.dedupe(S.evaluate(t(2026, 10, 20, 7, 15), dict(OK, **{B3: None}), ARMED), st), [])
        # same slot, kind changes (missed -> stuck): still one alert for that run
        self.assertEqual(S.dedupe(S.evaluate(t(2026, 10, 20, 9, 5), dict(OK, **{B3: hb(t(2026, 10, 20, 6, 0))}), ARMED), st), [])
        # next day's slot alerts again
        nxt = S.evaluate(t(2026, 10, 21, 7, 5), dict(OK, **{B3: None}), ARMED)
        self.assertEqual(len(S.dedupe(nxt, st)), 3)   # all three books: their heartbeats are a day old
    def test_check_live_state_file(self):
        S.read_all = lambda: ({b: None for b in S.BOOKS}, ARMED, {})
        p = os.path.join(tempfile.mkdtemp(), 's.json')
        a = S.check_live(t(2026, 10, 20, 7, 5), p); b = S.check_live(t(2026, 10, 20, 7, 15), p)
        self.assertEqual(len(a), 3); self.assertEqual(b, [])
        self.assertTrue(json.load(open(p))['alerted'])

class Count(unittest.TestCase):
    def test_coverage_count(self):
        p = os.path.join(tempfile.mkdtemp(), 'c.csv')
        open(p, 'w').write('company,owner,tier,website,flag,last_checked,last_signal\n'
                           'A,%s,Target A,,,2026-10-20,\nB,%s,Target C,,,2026-10-17,\nC,%s,Target A,,,2026-10-20,\n' % (S.BOOKS[B3], S.BOOKS[B3], S.BOOKS[B1]))
        self.assertEqual(S.coverage_count(B3, '2026-10-20', p), 1)
        self.assertEqual(S.coverage_count(B2, '2026-10-20', p), 0)

if __name__ == '__main__': unittest.main()
