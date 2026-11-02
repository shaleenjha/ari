"""Egress fix (Nov 2026): delta reads + base cache in sync_sheet_supabase.py, with a fake PostgREST."""
import os, sys, json, tempfile, unittest, datetime as dt
from unittest import mock
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sync_sheet_supabase as S

def ts(m): return (dt.datetime(2026, 11, 2, tzinfo=dt.timezone.utc) + dt.timedelta(minutes=m)).isoformat()

class Fake:
    def __init__(self): self.rows = {}; self.calls = []
    def all(self, table, select="*", where=""):
        self.calls.append(("all", table, where))
        rows = list(self.rows.values())
        if where.startswith("&updated_at=gt."):
            import urllib.parse
            since = S._ts(urllib.parse.unquote(where.split("gt.", 1)[1]))
            rows = [r for r in rows if S._ts(r["updated_at"]) > since]
        return [dict(r) for r in rows]
    def count(self, table): self.calls.append(("count", table)); return len(self.rows)

class T(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(); self.f = Fake()
        self.p = [mock.patch.object(S, "CACHE_DIR", self.d), mock.patch.object(S, "sb_all", self.f.all),
                  mock.patch.object(S, "sb_count", self.f.count), mock.patch.dict(os.environ, {"ARI_SB_FULL": ""})]
        for x in self.p: x.start()
        for i in range(3): self.f.rows["P%d" % i] = {"id": "P%d" % i, "v": i, "updated_at": ts(i)}
    def tearDown(self):
        for x in self.p: x.stop()
    def test_first_full_then_delta(self):
        st = {}; S.sb_rows("people", st); self.assertEqual(st["people"], "full")
        self.f.rows["P1"] = {"id": "P1", "v": 9, "updated_at": ts(60)}
        st = {}; got = S.sb_rows("people", st)
        self.assertTrue(st["people"].startswith("delta"))
        self.assertEqual({r["id"]: r["v"] for r in got}, {"P0": 0, "P1": 9, "P2": 2})
    def test_hard_delete_forces_full(self):
        S.sb_rows("people"); del self.f.rows["P2"]
        st = {}; got = S.sb_rows("people", st)
        self.assertEqual(st["people"], "full"); self.assertEqual(len(got), 2)
    def test_stale_cache_forces_full(self):
        S.sb_rows("people"); c = S._cache_load("people"); c["full_at"] = ts(-60 * 24); S._cache_save("people", c)
        st = {}; S.sb_rows("people", st); self.assertEqual(st["people"], "full")
    def test_corrupt_cache_forces_full(self):
        os.makedirs(self.d, exist_ok=True); open(os.path.join(self.d, "people.json"), "w").write("{")
        st = {}; got = S.sb_rows("people", st); self.assertEqual(st["people"], "full"); self.assertEqual(len(got), 3)
    def test_env_full(self):
        S.sb_rows("people")
        with mock.patch.dict(os.environ, {"ARI_SB_FULL": "1"}):
            st = {}; S.sb_rows("people", st); self.assertEqual(st["people"], "full")

if __name__ == "__main__": unittest.main()
