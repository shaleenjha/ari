#!/usr/bin/env python3
"""The worker's Chat and App change rules (docs/specs/worker_chat_rule.txt, the code-owned text of those two lines of the
worker task prompt): the decline Kyte writes names no system and is exactly the server's line (Owner Oct 30 2026)."""
import os, re, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.join(os.path.dirname(HERE), 'docs', 'specs', 'worker_chat_rule.txt')
LINE = "I can't help with that here."

class WorkerChatRule(unittest.TestCase):
    def setUp(self):
        self.t = open(SPEC, encoding='utf8').read()
        self.lines = [l for l in self.t.split('\n') if l.strip()]

    def test_two_rules(self):
        self.assertEqual(len(self.lines), 2)
        self.assertTrue(self.lines[0].startswith('- Chat: '))
        self.assertTrue(self.lines[1].startswith('- Redraft DM, '))

    def test_decline_is_the_server_line(self):
        self.assertIn('write only "%s" in result' % LINE, self.lines[0])
        self.assertIn('result "%s", status done' % LINE, self.lines[1])
        self.assertEqual(self.t.count('"%s"' % LINE), 2)

    def test_no_system_in_what_shal_sees(self):
        quoted = re.findall(r'"([^"]*)"', self.t)
        for q in quoted:
            self.assertNotRegex(q, r'(?i)\b(hark|ari|den|kelvarrow|claude|anthropic|supabase|vercel)\b', q)
        self.assertNotIn('handled in Hark', self.t)

if __name__ == '__main__':
    unittest.main()
