#!/usr/bin/env python3
# Unit tests for scripts/scan_gate.py (scan controls, 0052). No network: ari_db.rpc is replaced by a fake.
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ari_db, scan_gate


class Fake:
    def __init__(self, replies):
        self.replies, self.calls = replies, []

    def __call__(self, fn, args=None, actor='hark'):
        self.calls.append((fn, args, actor))
        r = self.replies[fn]
        if isinstance(r, BaseException): raise r
        return r


class T(unittest.TestCase):
    def setUp(self): self.orig = ari_db.rpc
    def tearDown(self): ari_db.rpc = self.orig

    def use(self, **replies):
        f = Fake(replies); ari_db.rpc = f; return f

    def test_missing_function_fails_open(self):
        err = SystemExit('ERR 404 rpc/kyte_worker_scan_start {"code":"PGRST202","message":"Could not find the function"}')
        self.use(kyte_worker_scan_start=err, kyte_worker_scan_check=err, kyte_worker_scan_finish=err)
        self.assertEqual(scan_gate.start('connections'), 'RUN none no_settings')
        self.assertEqual(scan_gate.check('profile'), 'RUN no_settings')
        self.assertEqual(scan_gate.finish('none', 'ok'), 'OK not recorded')
        self.assertEqual(scan_gate.finish('12', 'ok'), 'OK not recorded')

    def test_unreachable_fails_open(self):
        self.use(kyte_worker_scan_start=OSError('timed out'), kyte_worker_scan_finish=SystemExit('ERR 503 rpc/x down'))
        self.assertEqual(scan_gate.start('sent'), 'RUN none gate_unreachable')
        self.assertTrue(scan_gate.finish('7', 'ok').startswith('WARN not recorded'))

    def test_permission_error_is_not_missing(self):
        self.use(kyte_worker_scan_check=SystemExit('ERR 403 rpc/kyte_worker_scan_check {"code":"42501"}'))
        self.assertEqual(scan_gate.check('sent'), 'RUN gate_unreachable')

    def test_run_and_claim(self):
        f = self.use(kyte_worker_scan_start={'run': True, 'reason': 'requested', 'run_id': 41, 'trigger': 'requested'})
        self.assertEqual(scan_gate.start('profile', 'task-1'), 'RUN 41 requested')
        self.assertEqual(f.calls[0], ('kyte_worker_scan_start', {'p_scan': 'profile', 'p_task': 'task-1'}, 'scan_gate'))

    def test_skip_with_next_due_in_ist(self):
        self.use(kyte_worker_scan_check={'run': False, 'reason': 'done_today', 'next_due': '2030-01-08T09:15:00+00:00'})
        self.assertEqual(scan_gate.check('connections'), 'SKIP done_today next 14:45 IST, Tue 08 Jan')
        self.use(kyte_worker_scan_start={'run': False, 'reason': 'blocked', 'next_due': None})
        self.assertEqual(scan_gate.start('connections'), 'SKIP blocked')

    def test_no_settings_row_runs(self):
        self.use(kyte_worker_scan_start={'run': False, 'reason': 'no_settings', 'next_due': None})
        self.assertEqual(scan_gate.start('sent'), 'RUN none no_settings')

    def test_finish(self):
        f = self.use(kyte_worker_scan_finish={'ok': True})
        self.assertEqual(scan_gate.finish('9', 'blocked', 0, ' security check ' + 'x' * 300), 'OK recorded')
        args = f.calls[0][1]
        self.assertEqual((args['p_run'], args['p_result'], args['p_items']), (9, 'blocked', 0))
        self.assertLessEqual(len(args['p_note']), 200)
        self.use(kyte_worker_scan_finish={'ok': False, 'reason': 'not_running'})
        self.assertEqual(scan_gate.finish('9', 'ok'), 'OK already finished')
        self.assertTrue(scan_gate.finish('9', 'sent').startswith('ERR'))
        self.assertTrue(scan_gate.finish('x', 'ok').startswith('ERR'))

    def test_cli(self):
        self.use(kyte_worker_scan_check={'run': True, 'reason': 'due'})
        self.assertEqual(scan_gate.main(['scan_gate.py', 'check', 'connections']), 0)
        self.assertEqual(scan_gate.main(['scan_gate.py', 'check', 'feed']), 2)
        self.assertEqual(scan_gate.main(['scan_gate.py', 'finish', '3', 'ok', '--items', 'two']), 2)


if __name__ == '__main__':
    unittest.main()
