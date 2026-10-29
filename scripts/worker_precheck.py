#!/usr/bin/env python3
# Ari budget v1 (Council, Oct 17 2026): the worker's cheap check in ONE shell call, so an idle 10-minute run
# ends after a single tool call instead of 6 to 8 (Gmail, Queue, People, Brief, briefs, replies, exec notes).
# Read-only. Fail-open: any error prints WORK, so the worker never misses work because this script broke.
# usage (project folder; shell credentials [{"provider":"google","email":"owner@example.com"}]; the Supabase
# ari_worker binding is injected by the proxy in the same command):
#   python3 scripts/worker_precheck.py          -> "IDLE" or "WORK: reason; reason; ..."
#   python3 scripts/worker_precheck.py --why    -> same, plus every matching row (for tuning)
#   python3 scripts/worker_precheck.py --legacy-gmail  -> step 0 counts any LinkedIn email (pre spec-04 behaviour)
import sys, os, json, re, csv, subprocess, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SHEET_ID = "SHEET_ID_PLACEHOLDER"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
DEFAULT_GMAIL_TS = 1792131600  # 2026-10-16 11:50 IST, same default as the worker prompt
CSUITE = re.compile(r"\b(ceo|cto|ciso|cdo|cio|caio|chief\b(?! of staff))", re.I)
WHY = "--why" in sys.argv
LEGACY_GMAIL = "--legacy-gmail" in sys.argv


def gws(args):
    r = subprocess.run(["gws"] + args, capture_output=True, text=True, timeout=90)
    if r.returncode != 0:
        raise RuntimeError("gws failed: " + (r.stderr or r.stdout)[-300:])
    out = r.stdout.strip()
    return json.loads(out) if out else {}


def sheet(tabs):
    d = gws(["sheets", "spreadsheets", "values", "batchGet", "--params", json.dumps(
        {"spreadsheetId": SHEET_ID, "ranges": tabs, "valueRenderOption": "FORMATTED_VALUE"})])
    out = {}
    for tab, vr in zip(tabs, d.get("valueRanges", [])):
        vals = vr.get("values", [])
        hdr = [str(h).strip() for h in vals[0]] if vals else []
        out[tab] = [dict(zip(hdr, [str(x) for x in r] + [""] * (len(hdr) - len(r)))) for r in vals[1:]]
    return out


def script(*args):
    r = subprocess.run([sys.executable, os.path.join(HERE, args[0])] + list(args[1:]),
                       capture_output=True, text=True, timeout=90, cwd=ROOT)
    if r.returncode != 0:
        raise RuntimeError("%s failed: %s" % (args[0], (r.stderr or r.stdout)[-300:]))
    return r.stdout.strip()


def g(row, *names):
    for n in names:
        for k, v in row.items():
            if k.strip().lower() == n:
                return (v or "").strip()
    return ""


HISTORY = os.path.join(ROOT, "work", "state", "precheck_history.json")


def record(line):
    """Keep the last 12 precheck lines so health_check.py can spot a stalled worker (same WORK, 3+ runs)."""
    try:
        try:
            h = json.load(open(HISTORY))
        except Exception:
            h = []
        h = (h + [{"at": dt.datetime.now(dt.timezone.utc).isoformat(), "line": line}])[-12:]
        os.makedirs(os.path.dirname(HISTORY), exist_ok=True)
        tmp = HISTORY + ".tmp"
        json.dump(h, open(tmp, "w"))
        os.replace(tmp, HISTORY)
    except Exception:
        pass


def main():
    reasons, detail = [], []
    now = dt.datetime.now(IST)
    today = now.strftime("%Y-%m-%d")
    soon = (now + dt.timedelta(days=1)).strftime("%Y-%m-%d")
    s = sheet(["Queue", "People", "Brief"])
    brief = {g(r, "key"): g(r, "value") for r in s["Brief"]}

    # 0. Gmail: any LinkedIn email newer than the last processed one
    try:
        last = int(float(brief.get("gmail_last_scan") or DEFAULT_GMAIL_TS))
    except ValueError:
        last = DEFAULT_GMAIL_TS
    # Spec 04 (Otto, Oct 17 2026): count only UNHANDLED accept emails (all pages, every observed subject variant, deduped
    # against gmail_events when migration 0032 is live, else against People.accepted) plus LinkedIn message emails newer
    # than the cursor (worker step 0 runs reply_ingest.py for those). Job alerts / newsletters / PYMK no longer wake it.
    # Kill switch: ARI_PRECHECK_LEGACY_GMAIL=1 (or --legacy-gmail) restores the old count, with paging.
    newer = None
    if not (LEGACY_GMAIL or os.environ.get("ARI_PRECHECK_LEGACY_GMAIL") == "1"):
        try:
            import accept_ingest
            r = accept_ingest.pending(last, [{k.strip().lower(): v for k, v in p.items()} for p in s["People"]])
            if r["accepts"]:
                reasons.append("gmail %d new accept email(s)" % r["accepts"])
            if r["messages"]:
                reasons.append("gmail %d new LinkedIn message email(s)" % r["messages"])
            if r["gmail_failed"]:
                reasons.append("gmail read error (fail-open)")
            if WHY:
                detail.append("gmail accept_ingest db_0032=%s" % r["db_0032"])
            newer = 0
        except BaseException as e:  # any problem in the new path (incl. SystemExit from ari_db): legacy count below
            detail.append("gmail accept_ingest fallback: %s" % str(e)[:120])
            newer = None
    if newer is None:
        newer, tok = 0, None
        while True:  # legacy: any LinkedIn email newer than the cursor, now with paging (was maxResults 20, one page)
            prm = {"userId": "me", "q": "from:linkedin.com in:anywhere after:%d" % last, "maxResults": 100}
            if tok:
                prm["pageToken"] = tok
            lst = gws(["gmail", "users", "messages", "list", "--params", json.dumps(prm)])
            for m in lst.get("messages", []) or []:
                md = gws(["gmail", "users", "messages", "get", "--params", json.dumps(
                    {"userId": "me", "id": m["id"], "format": "minimal"})])
                if int(md.get("internalDate", "0")) // 1000 > last:
                    newer += 1
            tok = lst.get("nextPageToken")
            if not tok:
                break
        if newer:
            reasons.append("gmail %d new LinkedIn email(s)" % newer)

    # 1. Queue
    q = [r for r in s["Queue"] if g(r, "status").lower() == "queued"]
    if q:
        reasons.append("queue %d queued" % len(q)); detail += ["queue " + g(r, "id") + " " + g(r, "action") for r in q]

    # People checks (same rules as the worker's cheap check)
    tiers = {}
    try:
        for r in csv.DictReader(open(os.path.join(ROOT, "target_accounts_full.csv"))):
            tiers[(r.get("company") or "").strip().lower()] = ((r.get("tier") or "").strip(), (r.get("flag") or "").strip())
    except Exception:
        pass
    # Follow-up drafts that live in Queue rows: People has a dm3_text column since 27 Oct 2026 (new DM3s go there and
    # this loop reads it as txt), but older drafts only exist as a done "Draft DM 2" / "Draft DM 3" row with a result,
    # which still counts as the draft (27 Oct 2026, the "sticky DM3 flag").
    queued_drafts = set()
    for r in s["Queue"]:
        act = re.sub(r"\s+", "", g(r, "action").lower())
        if act in ("draftdm2", "draftdm3") and g(r, "status").lower() == "done" and g(r, "result"):
            queued_drafts.add((g(r, "target").strip().upper(), "dm" + act[-1]))
    hits = {"research": [], "accepted_no_dm": [], "no_why": [], "followup_due": [], "exec_suggest": []}
    for p in s["People"]:
        pid = g(p, "id")
        if not pid:
            continue
        review = g(p, "review").lower()
        research = g(p, "research")
        stage = g(p, "stage")
        route = g(p, "route")
        notes = g(p, "notes")
        why = g(p, "why")
        # rows the worker already settled: excluded as not a buyer, or on hold (it explains these in AC why)
        settled = stage == "Hold" or why.lower().startswith(("excluded", "on hold"))
        lead = review in ("lead", "") and not settled
        if lead and research in ("Researching", "Likely personal, review"):
            hits["research"].append(pid)
        if lead and stage == "Accepted" and not g(p, "dm") and research not in ("Draft ready", "No signal yet", "Flagged, no draft"):
            hits["accepted_no_dm"].append(pid)
        if not g(p, "why"):
            hits["no_why"].append(pid)
        for kind, due, sent, txt in (("dm2", "dm2_due", "dm2_sent", "dm2_text"), ("dm3", "dm3_due", "dm3_sent", "dm3_text")):
            if kind == "dm3" and not g(p, "dm2_sent"):
                continue   # worker step 4: DM3 is drafted only once DM2 went out
            if kind == "dm2" and not g(p, "dm1_sent"):
                continue
            if (g(p, due)[:10] and g(p, due)[:10] <= soon and not g(p, sent) and not g(p, txt) and not g(p, "replied")
                    and not settled and review != "personal" and not g(p, "withdrawn")
                    and (pid.upper(), kind) not in queued_drafts):   # due by tomorrow (Oct 22: DM3 drafted ahead)
                if pid not in hits["followup_due"]:
                    hits["followup_due"].append(pid)
        tier, flag = tiers.get(g(p, "company").lower(), ("", ""))
        if (lead and review == "lead" and CSUITE.search(g(p, "title")) and "founder" not in route.lower()
                and not g(p, "connect_sent") and stage != "Hold" and not flag
                and tier in ("Target A", "Target B", "Target C")
                and "exec track" not in notes.lower() and "exec track" not in g(p, "next_action").lower()):
            hits["exec_suggest"].append(pid)
    for k, v in hits.items():
        if v:
            reasons.append("%s %d" % (k, len(v))); detail.append(k + " " + ",".join(v))

    # Brief date
    if brief.get("date", "") != today and now.hour >= 5:
        reasons.append("brief date %s" % (brief.get("date") or "empty"))

    # Supabase-side queues (worker role, read-only commands)
    nb = script("brief_upsert.py", "next")
    if nb and nb not in ("null", "none", "{}", "[]") and not nb.lower().startswith("none"):
        reasons.append("account brief queued")
    pend = script("reply_ingest.py", "pending")
    if pend and pend not in ("[]", "null", "none"):
        reasons.append("reply drafts pending")
    nn = script("exec_track_handoff.py", "--needs-notes")
    if nn and nn.strip() != "none":
        reasons.append("exec notes needed")
    # Copy Lab v1 (Quill, 17 Oct 2026, Hark decision 5): queued DM2s written before Copy Lab get regenerated as
    # F1 / F2 / F5. The list empties itself as the worker rewrites and tags them, so this stops waking the worker.
    rg = script("copy_check.py", "regen", "--count")
    if rg.strip().isdigit() and int(rg) > 0:
        reasons.append("style regen %s" % rg.strip())  # AE style guide, 21 Oct 2026: unsent DM1s + DM2s

    line = ("WORK: " + "; ".join(reasons)) if reasons else "IDLE"
    if not WHY:
        record(line)
    if reasons:
        if not WHY and hits["followup_due"]:
            # Oct 30 2026: a worker run skipped real DM2 drafts on a stale note; name them so the work is unmistakable.
            print("followup_due = DM2/DM3 due by tomorrow with NO draft yet, draft now (step 4): " + ",".join(hits["followup_due"]))
        print(line)
        if WHY:
            print("\n".join(detail))
    else:
        print("IDLE")


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # fail-open: never let a broken check hide work
        print("WORK: precheck error (%s), run the full cheap check" % str(e)[:200])
