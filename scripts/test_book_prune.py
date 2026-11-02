# S1 R4 tests: the Book prune guard in sync_sheet_supabase.sync_book (audit D8). Stubbed database, synthetic rows only.
import os, sys, types, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync_sheet_supabase as s

HEADER = ["company", "owner", "tier", "flag", "cluster", "fit", "last_checked", "last_signal", "website"]


def book(n):
    return ["Ostrevanthe Co %04d" % i for i in range(n)]


class T(unittest.TestCase):
    def run_sync(self, db_names, sheet_names, dry=False):
        db = {}
        for i, c in enumerate(db_names):
            k = "%s#1" % c.lower()
            db[k] = {"key": k, "company": c, "owner": None, "tier": None, "flag": None, "cluster": None, "fit": None,
                     "last_checked": None, "last_signal": None, "website": None, "sheet_row": i + 2}
        calls = []
        s.sb_all = lambda table, select: list(db.values())
        s.sb = lambda method, path, body=None, **kw: calls.append((method, path))
        s.log = lambda *a: None
        s.ALERTS.clear()
        rows = [(i + 2, [c] + [""] * (len(HEADER) - 1)) for i, c in enumerate(sheet_names)]
        s.sync_book({"Book": (HEADER, rows)}, types.SimpleNamespace(dry_run=dry), "sheet")
        return [c for c in calls if c[0] == "DELETE"], list(s.ALERTS)

    def test_limit(self):
        self.assertEqual(s.book_prune_limit(1100), 20)
        self.assertEqual(s.book_prune_limit(200), 10)
        self.assertEqual(s.book_prune_limit(10), 1)

    def test_cleared_tab_deletes_nothing_and_alerts(self):
        dels, alerts = self.run_sync(book(1100), [])
        self.assertEqual(dels, []); self.assertEqual(len(alerts), 1)

    def test_half_read_tab_deletes_nothing(self):
        names = book(1100)
        dels, alerts = self.run_sync(names, names[:550])
        self.assertEqual(dels, []); self.assertTrue(alerts)

    def test_normal_small_prune_still_deletes(self):
        names = book(1100)
        dels, alerts = self.run_sync(names, names[3:])
        self.assertEqual(len(dels), 1); self.assertEqual(alerts, [])

    def test_exactly_at_limit_allowed_one_over_refused(self):
        names = book(1100)
        self.assertEqual(len(self.run_sync(names, names[20:])[0]), 1)
        self.assertEqual(self.run_sync(names, names[21:])[0], [])

    def test_small_book_share_cap(self):
        names = book(100)  # 5% of 100 = 5
        self.assertEqual(len(self.run_sync(names, names[5:])[0]), 1)
        self.assertEqual(self.run_sync(names, names[6:])[0], [])


if __name__ == "__main__":
    unittest.main()
