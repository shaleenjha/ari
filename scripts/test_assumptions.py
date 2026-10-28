#!/usr/bin/env python3
"""Unit tests for G12 draft assumptions (scripts/assumptions.py + copy_check.py --g12). Synthetic data only, no network:
ari_db is replaced by an in-memory fake. Run: python3 scripts/test_assumptions.py"""
import contextlib, datetime as dt, io, json, os, sys, types, unittest

os.environ["ARI_SELLER_CONFIG"] = "/nonexistent"          # synthetic seller settings (seller_config defaults)
os.environ.pop("ARI_ASSUMPTIONS_STORE", None)
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

PEOPLE = [{"id": "P900001", "account_id": "a1", "company": "Quillfen Health", "name": "Dana Orsk", "title": "VP Engineering",
           "notes": "Trigger: 2026-10-01 Quillfen launched an AI scribe https://quillfen.example/news", "research": "", "context": "",
           "dm": "Thanks for connecting, Dana. Quillfen's scribe puts PHI in transcripts. We keep it out. Worth 15 minutes?",
           "dm2_text": "", "dm3_text": "", "dm1_sent": "2026-10-03", "dm2_sent": None, "dm3_sent": None, "accepted": "2026-10-02"}]
DB = {"people": PEOPLE,
      "accounts": [{"id": "a1", "company": "Quillfen Health", "hook": "Quillfen launched an AI scribe for 120 clinics", "hook_date": "2026-10-01", "ae": "Tamsin Synthwell"}],
      "account_briefs": [{"thesis": "Scribe notes carry PHI into a model. Series B closed Sep 30 2026."}],
      "research": [], "sent_messages": [], "replies": [], "emails": [],
      "queue": []}
WRITES = []


def fake_get(path, actor="hark"):
    table = path.split("?")[0]
    if table == "queue":
        if "id=like.AS" in path:
            return [r for r in DB["queue"] if str(r.get("id", "")).startswith("AS:")]
        return [r for r in DB["queue"] if not str(r.get("id", "")).startswith("AS:")]
    return [dict(r) for r in DB.get(table, [])]


def fake_request(method, path, body=None, actor="hark", extra=None, timeout=60):
    WRITES.append((method, path, body, extra))
    return None


fake = types.ModuleType("ari_db")
fake.get, fake.request, fake.rpc = fake_get, fake_request, lambda *a, **k: None
sys.modules["ari_db"] = fake
import assumptions as A   # noqa: E402
import copy_check as cc   # noqa: E402


def kinds(items):
    return {(i["text"], i["kind"]) for i in items}


class Extract(unittest.TestCase):
    def test_numbers_dates_titles_events_names(self):
        t = ("Lee, quick one. Since Orquadrine raised a $40M Series B on Oct 14, your VP of Platform Jordan Pike is adding 3 new agents "
             "across 200 clinics. Saw you at HLTH 2026. Worth 20 minutes?")
        k = kinds(A.extract(t))
        for want in [("$40M", "number"), ("Oct 14", "date"), ("Jordan Pike", "name"), ("3", "number"), ("200", "number"),
                     ("HLTH 2026", "event"), ("Orquadrine", "name"), ("Lee", "name")]:
            self.assertIn(want, k)
        self.assertTrue(any(kd == "event" and "raised" in tx for tx, kd in k))
        self.assertNotIn(("20", "number"), k)            # the fixed ask is never an assumption
        self.assertNotIn(("Series B", "name"), k)

    def test_title_and_spelled_number(self):
        k = kinds(A.extract("Thanks for connecting, Kim. As Head of Data at Orquadrine you own the claims feed. Two hundred clinics send it. Worth 15 minutes?"))
        self.assertIn(("Head of Data", "title"), k)
        self.assertIn(("Two hundred clinics", "number"), k)
        self.assertNotIn(("15", "number"), k)

    def test_generic_role_is_not_a_title(self):
        k = kinds(A.extract("Kim, your CISO reads every transcript. Worth 15 minutes?"))
        self.assertFalse(any(kd == "title" for _, kd in k))

    def test_customer_context(self):
        k = kinds(A.extract("Dana, last one from me on scribe transcripts. If PHI stalls a review, happy to show how (Ixterlane Health handles it). Worth a quick call?"))
        self.assertIn(("Ixterlane Health", "customer"), k)

    def test_plain_words_and_domain_acronyms_skipped(self):
        k = kinds(A.extract("Thanks for connecting, Dana. Security reviews stall when PHI and PII reach the LLM. We keep them out. Worth 15 minutes?"))
        self.assertEqual({tx for tx, _ in k}, {"Dana"})

    def test_relative_and_iso_dates(self):
        k = kinds(A.extract("Dana, the 2026-10-01 launch last week moved PHI. Worth 15 minutes?"))
        self.assertIn(("2026-10-01", "date"), k)
        self.assertIn(("last week", "date"), k)


class Sources(unittest.TestCase):
    def setUp(self):
        self.blob, _ = A.gather_sources("P900001", None)

    def test_people_and_account_facts_are_sourced(self):
        t = "Thanks for connecting, Dana. As VP Engineering, Quillfen's scribe across 120 clinics carries PHI. Worth 15 minutes?"
        self.assertEqual(A.g12("P900001", t, blob=self.blob), [])

    def test_unsourced_items_are_listed(self):
        t = "Dana, following up on scribe PHI. Since Oct 14 Jordan Pike moved 300 clinics to (Ixterlane Health handles it). Worth 15 minutes?"
        got = kinds(A.g12("P900001", t, blob=self.blob))
        self.assertIn(("Oct 14", "date"), got)
        self.assertIn(("Jordan Pike", "name"), got)
        self.assertIn(("300", "number"), got)
        self.assertIn(("Ixterlane Health", "customer"), got)

    def test_brief_dates_source_a_date(self):
        self.assertEqual(A.g12("P900001", "Dana, after Sep 30 your PHI moved. Worth 15 minutes?", blob=self.blob), [])

    def test_approved_customer_is_sourced_and_never_name_left_to_g2(self):
        t = "Dana, following up on scribe PHI. Bravossine cut review time once PHI stayed out. Tolvessine too. Worth 15 minutes?"
        texts = {i["text"] for i in A.g12("P900001", t, blob=self.blob)}
        self.assertNotIn("Bravossine", texts)
        self.assertFalse(any("Tolvessine" in x for x in texts))
        fl, _ = cc.check("P900001", "dm2", t)
        self.assertTrue(any(f.startswith("G2") for f in fl))      # still a hard fail, unchanged

    def test_relative_date_needs_a_recent_dated_source(self):
        it = {"text": "last week", "kind": "date"}
        self.assertTrue(A.is_sourced(it, self.blob, today=dt.date(2026, 10, 6)))
        self.assertFalse(A.is_sourced(it, self.blob, today=dt.date(2026, 12, 1)))

    def test_confirmed_item_becomes_a_source(self):
        DB["queue"].append({"id": "AS:P900001:dm1", "assumptions": [{"id": A.item_id("Jordan Pike"), "text": "Jordan Pike", "kind": "name",
                                                                        "source": "checker", "status": "confirmed"}]})
        try:
            blob, _ = A.gather_sources("P900001", None)
            self.assertEqual(A.g12("P900001", "Dana, Jordan Pike owns the PHI flow. Worth 15 minutes?", blob=blob), [])
        finally:
            DB["queue"].clear()


class Merge(unittest.TestCase):
    def test_union_dedupes_and_keeps_hard_kind(self):
        d = [{"id": A.item_id("cut review time 40%"), "text": "cut review time 40%", "kind": "claim", "source": "drafter", "status": "open"}]
        c = [{"id": A.item_id("40%"), "text": "40%", "kind": "number", "source": "checker", "status": "open"},
             {"id": A.item_id("Jordan Pike"), "text": "Jordan Pike", "kind": "name", "source": "checker", "status": "open"}]
        m = A.merge(d, c)
        self.assertEqual(len(m), 2)
        self.assertEqual(m[0]["source"], "drafter")
        self.assertEqual(m[0]["kind"], "number")                   # merged with a hard item: stays hard

    def test_previous_decisions_carry_and_struck_text_back_reopens(self):
        c = [{"id": A.item_id("300"), "text": "300", "kind": "number", "source": "checker", "status": "open"}]
        prev = [{"id": A.item_id("300"), "text": "300", "status": "confirmed"},
                {"id": A.item_id("Ixterlane"), "text": "Ixterlane", "kind": "customer", "status": "confirmed"}]
        m = A.merge([], c, prev, "300 clinics")
        self.assertEqual([i["status"] for i in m], ["confirmed", "confirmed"])
        prev2 = [{"id": A.item_id("300"), "text": "300", "status": "struck"}]
        self.assertEqual(A.merge([], c, prev2, "Dana, 300 clinics")[0]["status"], "open")

    def test_cap(self):
        c = [{"id": str(i), "text": "x%d" % i, "kind": "name", "source": "checker", "status": "open"} for i in range(100)]
        self.assertLessEqual(len(A.merge([], c)), A.MAX_ITEMS)

    def test_drafter_file_validation(self):
        p = "/tmp/_g12_drafter.json"
        with open(p, "w") as f:
            json.dump([{"text": "Jordan Pike", "kind": "name"}, {"text": "  "}, "a bare claim", {"text": "x", "kind": "weird"}], f)
        got = A.load_drafter(p)
        self.assertEqual([(i["text"], i["kind"], i["source"]) for i in got],
                         [("Jordan Pike", "name", "drafter"), ("a bare claim", "claim", "drafter"), ("x", "claim", "drafter")])


class Store(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("ARI_ASSUMPTIONS_STORE", None)
        WRITES.clear()

    def test_off_by_default(self):
        ok, msg = A.store("P900001", "dm1", [])
        self.assertFalse(ok)
        self.assertIn("off", msg)
        self.assertEqual(WRITES, [])

    def test_upsert_shape_when_on(self):
        os.environ["ARI_ASSUMPTIONS_STORE"] = "1"
        items = [{"id": "a", "text": "300", "kind": "number", "source": "checker", "status": "open"}]
        ok, _ = A.store("P900001", "dm2", items)
        self.assertTrue(ok)
        method, path, body, extra = WRITES[0]
        self.assertEqual((method, path), ("POST", "queue?on_conflict=id"))
        self.assertEqual(body[0]["id"], "AS:P900001:dm2")
        self.assertEqual(body[0]["action"], "Draft assumptions")
        self.assertEqual(body[0]["result"], "1 to confirm")
        self.assertIn("merge-duplicates", extra["Prefer"])

    def test_store_never_raises(self):
        os.environ["ARI_ASSUMPTIONS_STORE"] = "1"
        def boom(*a, **k):
            raise SystemExit("ERR 400 queue column assumptions does not exist")
        old, fake.request = fake.request, boom
        try:
            ok, msg = A.store("P900001", "dm1", [])
        finally:
            fake.request = old
        self.assertFalse(ok)
        self.assertIn("not stored", msg)


class CopyCheckCli(unittest.TestCase):
    def cli(self, args, text):
        p = "/tmp/_g12_draft.txt"
        with open(p, "w") as f:
            f.write(text)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = cc.main(["check", "P900001", "dm1", p] + args)
        return code, buf.getvalue().strip().splitlines()

    GOOD = "Thanks for connecting, Dana. Quillfen's scribe puts PHI in 300 clinics' transcripts. We keep it out. Worth 15 minutes?"

    def test_default_output_unchanged(self):
        code, lines = self.cli([], self.GOOD)
        self.assertFalse(any(l.startswith("ASSUMPTIONS") for l in lines))
        self.assertIn(lines[-1].split(":")[0], ("PASS", "FLAG"))

    def test_g12_prints_before_verdict_and_keeps_exit_code(self):
        code0, base = self.cli([], self.GOOD)
        code, lines = self.cli(["--g12"], self.GOOD)
        self.assertEqual(code, code0)
        self.assertEqual(lines[-1], base[-1])
        line = next(l for l in lines if l.startswith("ASSUMPTIONS"))
        items = json.loads(line.split(": ", 1)[1])
        self.assertIn({"text": "300", "kind": "number", "source": "checker"}, items)

    def test_bad_drafter_file_is_a_note_not_a_crash(self):
        code0, base = self.cli([], self.GOOD)
        code, lines = self.cli(["--assumptions", "/nonexistent.json"], self.GOOD)
        self.assertEqual(code, code0)
        self.assertTrue(any(l.startswith("NOTE G12 skipped") for l in lines))


if __name__ == "__main__":
    unittest.main(verbosity=1)
