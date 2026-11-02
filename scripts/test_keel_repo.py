#!/usr/bin/env python3
"""keel_repo.default_repo(): env wins, then the one-line conf, then the fallback (python3 scripts/test_keel_repo.py)."""
import os, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import keel_repo


class T(unittest.TestCase):
    def setUp(self):
        self.env = os.environ.pop('KEEL_REPO', None); self.conf = keel_repo.CONF

    def tearDown(self):
        keel_repo.CONF = self.conf
        os.environ.pop('KEEL_REPO', None)
        if self.env is not None: os.environ['KEEL_REPO'] = self.env

    def test_conf_in_repo_is_one_line(self):
        lines = [l for l in open(self.conf).read().splitlines() if l.split('#', 1)[0].strip()]
        self.assertEqual(len(lines), 1); self.assertRegex(lines[0].strip(), r'^[\w.-]+/[\w.-]+$')

    def test_order(self):
        with tempfile.NamedTemporaryFile('w', suffix='.conf', delete=False) as f:
            f.write('# after the rename\nowner/kyte\n')
        keel_repo.CONF = f.name
        self.assertEqual(keel_repo.default_repo(), 'owner/kyte')
        os.environ['KEEL_REPO'] = 'owner/other'
        self.assertEqual(keel_repo.default_repo(), 'owner/other')
        os.environ.pop('KEEL_REPO'); keel_repo.CONF = f.name + '.missing'
        self.assertEqual(keel_repo.default_repo(), keel_repo.FALLBACK)
        os.unlink(f.name)

    def test_scripts_use_it(self):
        here = os.path.dirname(os.path.abspath(__file__))
        for s in ('git_push_api.py', 'git_pull_remote.py', 'deploy_provenance.py'):
            src = open(os.path.join(here, s)).read()
            self.assertIn('default_repo()', src, s)
            self.assertNotIn("os.environ.get('KEEL_REPO', 'shaleenjha/ari')", src, s)


if __name__ == '__main__':
    unittest.main()
