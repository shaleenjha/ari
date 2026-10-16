import sys, os, unittest
sys.path.insert(0, os.path.dirname(__file__))
import hygiene_scan, ari_db
class T(unittest.TestCase):
    def test_line(self):
        self.assertEqual(hygiene_scan.summary_line({'open': {}, 'last_scan': None}), 'hygiene: clean (last scan never)')
        l = hygiene_scan.summary_line({'open': {'dm1_past_due': 3, 'duplicate_account': 1}, 'last_scan': 'x'})
        self.assertIn('3 DM1s past due', l); self.assertIn('1 possible duplicate accounts', l)
    def test_not_applied(self):
        def boom(*a, **k): raise SystemExit('ERR 404 rpc/ari_hygiene_scan {"code":"PGRST202"}')
        ari_db.rpc = boom
        self.assertEqual(hygiene_scan.main(), 0)
    def test_flags_only(self):
        calls = []
        ari_db.rpc = lambda fn, args=None, actor='hark': calls.append(fn) or {'open': {}}
        hygiene_scan.main()
        self.assertEqual(calls, ['ari_hygiene_scan', 'ari_worker_hygiene'])  # never hygiene_resolve
if __name__ == '__main__': unittest.main()
