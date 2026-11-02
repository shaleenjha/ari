#!/usr/bin/env python3
"""Unit tests for scripts/repo_scan.py (the repo leak-scan gate). Synthetic inputs only."""
import os, sys, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import repo_scan as R


def kinds(text, path='x/file.ts'):
    return sorted({k for _, k, _ in R.scan_text(path, text)})


class Emails(unittest.TestCase):
    def test_allowed(self):
        for e in ('me@example.com', 'a@b.example', 'ops@example.org', '1+bot@users.noreply.github.com',
                  'invitations@linkedin.com', 'x@e.linkedin.com', 'a@notlinkedin.com', 'u@host.test'):
            self.assertEqual(kinds('mail ' + e), [], e)

    def test_flagged(self):
        self.assertEqual(kinds('mail someone' + '@' + 'gmail.com'), ['email'])
        self.assertEqual(kinds('mail a' + '@' + 'corp-mail.io'), ['email'])


class Phones(unittest.TestCase):
    def test_flagged(self):
        self.assertIn('phone', kinds('call +' + '91 98765 43210 now'))
        self.assertIn('phone', kinds('call +' + '1 415-555-0134'))
        self.assertIn('phone', kinds('mobile ' + '98765' + '43210'))

    def test_not_phones(self):
        self.assertEqual(kinds('ts 1729771234567 id 0014x00 v18.17.2 2026-10-24'), [])


class LinkedIn(unittest.TestCase):
    def test_synthetic_ok(self):
        for s in ('mira-fakerton-example', 'zz-synth-one', 'sample-ana-fauxwell', 'new-person-synthetic', 'jamie-poe-77'):
            self.assertEqual(kinds('https://www.linkedin.com/' + 'in/' + s + '/'), [], s)

    def test_real_looking_flagged(self):
        self.assertEqual(kinds('https://www.linkedin.com/' + 'in/' + 'janedoe1985'), ['linkedin'])


class Secrets(unittest.TestCase):
    def test_flagged(self):
        self.assertIn('github_token', kinds('t = "ghp_' + 'A' * 30 + '"'))
        self.assertIn('private_key', kinds('-----BEGIN RSA ' + 'PRIVATE KEY-----'))
        self.assertIn('sheet_url', kinds('docs.google.com/' + 'spreadsheets/d/' + 'a1B2' * 6))

    def test_public_allowed(self):
        self.assertEqual(kinds('sb_publishable_abc123 abcdefghijklmnopqrst.supabase.co'), [])


class Names(unittest.TestCase):
    def test_hash_only(self):
        # The blocked list holds salted hashes, never the words themselves.
        self.assertTrue(all(len(h) == 20 and int(h, 16) >= 0 for h in R.BLOCKED))
        R.BLOCKED.add(R._h('quorvelline'))
        try:
            self.assertEqual(kinds('const x = "Quorvelline Pay";'), ['name'])
            self.assertEqual(kinds('whyQuorvelline = 1'), ['name'])
            self.assertEqual(kinds('Quorvelline', path='LICENSE'), [])
        finally:
            R.BLOCKED.discard(R._h('quorvelline'))

    def test_data_uri_skipped(self):
        self.assertEqual(kinds('src="data:font/woff2;base64,QUJDZ2htYWlsLmNvbSs5MTk4NzY1NDMyMTA="'), [])


class Generated(unittest.TestCase):
    def test_lockfile_secrets_only(self):
        self.assertEqual(kinds('"author": "x' + '@' + 'gmail.com"', path='app/web/package-lock.json'), [])


if __name__ == '__main__':
    unittest.main()
