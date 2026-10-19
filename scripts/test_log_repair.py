#!/usr/bin/env python3
"""accept_ingest.py repair-log is retired (v18.17.7, Oct 19 2026). The spec-05 Log repair finished Oct 18 (395 rows) and
migration 0038 drops ari_worker_log_repair, so the mode must refuse without reading or writing anything. No network.
Run: python3 scripts/test_log_repair.py
"""
import os, sys, io, re, unittest, contextlib, subprocess
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import accept_ingest as A

SRC = open(os.path.join(HERE, "accept_ingest.py")).read()


class Tripwire:
    """Any attribute access means the retired mode tried to reach the Sheet or the database."""
    def __getattr__(self, name):
        raise AssertionError("repair-log touched io." + name)


class RepairLogRetired(unittest.TestCase):
    def run_main(self, *args):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = A.main(list(args))
        return rc, out.getvalue()

    def test_every_old_mode_refuses_with_exit_2(self):
        for args in (["repair-log"], ["repair-log", "--dry-run"], ["repair-log", "--execute"],
                     ["repair-log", "--rollback", "work/backups/log_repair_x"]):
            rc, out = self.run_main(*args)
            self.assertEqual(rc, 2, args)
            self.assertIn("retired", out)

    def test_no_io_is_touched(self):
        self.assertEqual(A.cmd_repair_log(["--execute"], io=Tripwire()), 2)

    def test_no_reads_or_writes_on_the_way(self):
        def boom(*a, **k):
            raise AssertionError("retired mode reached the Sheet or Gmail")
        saved = (A.read_sheet, subprocess.run)
        A.read_sheet, subprocess.run = boom, boom
        try:
            rc, _ = self.run_main("repair-log", "--execute")
        finally:
            A.read_sheet, subprocess.run = saved
        self.assertEqual(rc, 2)

    def test_dropped_rpcs_are_not_called_anywhere(self):
        # 0038 part 4 drops these; a call left behind would fail as "rpc missing" after the release.
        self.assertIsNone(re.search(r"rpc\(\s*[\"']ari_worker_log_(repair|unappend)", SRC))
        self.assertFalse(hasattr(A, "LiveRepairIO"))
        self.assertFalse(hasattr(A, "repair_plan"))

    def test_other_commands_still_dispatch(self):
        rc, out = self.run_main("nope")
        self.assertEqual(rc, 2)
        self.assertIn("unknown command", out)
        rc, _ = self.run_main("backfill", "--days", "1")      # without --dry-run: refuses before any read
        self.assertEqual(rc, 2)


if __name__ == "__main__":
    unittest.main(verbosity=1)
