#!/usr/bin/env python3
"""gmail_step.py: the code-owned Gmail cursor (spec 04 fault #1, Oct 21 2026). Offline, no Gmail, Sheet or database."""
import sys, os, json, re, tempfile, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import gmail_step as G
import accept_ingest as AI


class FakeA:
    """Stands in for accept_ingest: a Brief cursor plus a scripted cmd_scan."""
    SHEET_ID, OVERLAP = "x", 3600

    def __init__(self, cursor, rep=None, raise_scan=None):
        self.cursor, self.rep, self.raise_scan, self.writes, self.skips = cursor, rep, raise_scan, [], []

    def read_sheet(self, tabs):
        return {"Brief": (["key", "value"], [["date", "2026-10-21"], ["gmail_last_scan", str(self.cursor)]])}

    def gws(self, args):
        body = json.loads(args[args.index("--json") + 1])
        self.writes.append(int(body["values"][0][-1]))
        self.cursor = self.writes[-1]

    def cmd_scan(self, since, backfill, dry, show=True, skip=()):
        self.skips.append(set(skip))
        if self.raise_scan:
            raise self.raise_scan
        r = dict(self.rep)
        r["failed_ids"] = [i for i in r.get("failed_ids", []) if i not in skip]
        r["gmail_failed"] = bool(r["failed_ids"])  # like accept_ingest: skipped ids are never fetched
        if not r["failed_ids"] and not isinstance(r["writes"], dict) and r["writes"].startswith("none: a Gmail"):
            r["writes"] = {"recorded": 0}
        return r


def rep(would, failed_ids=(), writes=None):
    return {"cursor": {"would_set": would}, "gmail_failed": bool(failed_ids), "failed_ids": list(failed_ids),
            "writes": writes if writes is not None else ({"recorded": 0} if not failed_ids else "none: a Gmail read failed"),
            "new_accepts": [], "unmatched": 0, "ambiguous": 0}


OK = lambda dry: (True, '{"emails": 0}')
BAD = lambda dry: (False, "gws failed")


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.state = os.path.join(self.d, "s.json")

    def run_step(self, A, reply=OK, argv=()):
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = G.main(list(argv), A=A, reply=reply, state_path=self.state)
        return code, buf.getvalue()


class Cursor(Base):
    def test_advances_after_both_succeed(self):
        A = FakeA(1000, rep(2000))
        self.run_step(A)
        self.assertEqual(A.writes, [2000])

    def test_monotonic_never_backwards(self):
        A = FakeA(5000, rep(3000))
        self.run_step(A)
        self.assertEqual(A.writes, [])
        self.assertEqual(A.cursor, 5000)

    def test_frozen_when_reply_ingest_fails(self):
        A = FakeA(1000, rep(2000))
        code, _ = self.run_step(A, reply=BAD)
        self.assertEqual(A.writes, [])
        self.assertEqual(code, 1)

    def test_frozen_on_gmail_read_failure(self):
        A = FakeA(1000, rep(2000, failed_ids=["m1"]))
        self.run_step(A)
        self.assertEqual(A.writes, [])

    def test_frozen_when_accept_scan_raises(self):
        A = FakeA(1000, raise_scan=RuntimeError("gws failed: list"))
        code, _ = self.run_step(A)
        self.assertEqual(A.writes, [])
        self.assertEqual(code, 1)

    def test_frozen_when_accepts_not_recorded(self):
        A = FakeA(1000, rep(2000, writes="none: migration 0032 not applied"))
        self.run_step(A)
        self.assertEqual(A.writes, [])

    def test_dry_writes_nothing(self):
        A = FakeA(1000, rep(2000))
        self.run_step(A, argv=["--dry"])
        self.assertEqual(A.writes, [])
        self.assertFalse(os.path.exists(self.state))

    def test_new_cursor_ignores_non_accept_mail(self):
        msgs = [{"ts": 10, "kind": "accept"}, {"ts": 99, "kind": "other"}, {"ts": 20, "kind": "message"}]
        self.assertEqual(AI.new_cursor(5, msgs, False), 20)
        self.assertEqual(AI.new_cursor(5, msgs, True), 5)


class SkipAfterThree(Base):
    def test_skip_after_three_and_alert_once(self):
        outs = []
        for _ in range(3):
            A = FakeA(1000, rep(2000, failed_ids=["bad1"]))
            outs.append(self.run_step(A)[1])
            self.assertEqual(A.writes, [], "cursor stays frozen while the id is still being retried")
        self.assertEqual(sum(o.count("ALERT:") for o in outs), 1)
        self.assertIn("ALERT:", outs[2])
        A = FakeA(1000, rep(2000, failed_ids=["bad1"]))
        _, out4 = self.run_step(A)
        self.assertIn("bad1", A.skips[-1])
        self.assertEqual(A.writes, [2000], "the skipped id no longer freezes the cursor")
        self.assertNotIn("ALERT:", out4, "alert is deduped")

    def test_recovered_id_is_forgiven(self):
        self.run_step(FakeA(1000, rep(2000, failed_ids=["m2"])))
        self.run_step(FakeA(1000, rep(2000)))
        self.assertEqual(G.load_state(self.state)["counts"], {})


class Prompt(unittest.TestCase):
    def test_worker_step0_no_longer_sets_cursor(self):
        p = open(os.path.join(os.path.dirname(HERE), "docs", "specs", "worker_step0.txt")).read()
        self.assertIn("scripts/gmail_step.py", p)
        self.assertNotRegex(p, re.compile(r"set\s+Brief\s+gmail_last_scan\s*=", re.I))
        self.assertRegex(p, re.compile(r"never (set|write|change)[^.]*gmail_last_scan", re.I))

    def test_accept_ingest_does_not_write_cursor(self):
        src = open(os.path.join(HERE, "accept_ingest.py")).read()
        self.assertNotRegex(src, r"gmail_last_scan[\"']?\s*[,\]]\s*.*(update|append)")


if __name__ == "__main__":
    unittest.main(verbosity=1)
