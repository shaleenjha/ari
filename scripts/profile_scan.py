#!/usr/bin/env python3
# Profile-informed DM1 (Owner, Tue 27 Oct 2026 19:51 IST): before DM1 goes out, view the person's LinkedIn
# profile once (read-only) and redraft DM1 from what they own. Pacing rule from Owner: one profile at a time,
# at most 5 in a batch, then rest, then 5 more.
# usage (project folder; shell credentials google owner@example.com):
#   python3 scripts/profile_scan.py next          -> "IDLE ..." | "REST until HH:MM" | JSON of ONE person to scan
#   python3 scripts/profile_scan.py done <pid> <notes_file>   -> records the scan (counts toward the batch)
#   python3 scripts/profile_scan.py skip <pid> <reason>       -> never pick again (e.g. profile unavailable)
#   python3 scripts/profile_scan.py status
import sys, os, json, datetime as dt, subprocess

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
SHEET = "SHEET_ID_PLACEHOLDER"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
STATE = os.path.join(ROOT, "work", "profile_scan", "state.json")
BATCH = 5            # scans per batch
REST_MIN = 120       # rest after a batch
GAP_MIN = 15         # minimum gap between two scans inside a batch
BATCH_WINDOW_MIN = 180  # scans older than this no longer count toward the current batch


def now(): return dt.datetime.now(IST)


def load():
    try: return json.load(open(STATE))
    except Exception: return {"scans": [], "done": {}, "skip": {}, "rest_until": None}


def save(s):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    json.dump(s, open(STATE, "w"), indent=1)


def people():
    r = subprocess.run(["gws", "sheets", "spreadsheets", "values", "get", "--params",
                        json.dumps({"spreadsheetId": SHEET, "range": "People!A1:AZ2000"})],
                       capture_output=True, text=True, timeout=90)
    v = json.loads(r.stdout)["values"]; h = [x.strip() for x in v[0]]
    return [dict(zip(h, [str(x) for x in row] + [""] * (len(h) - len(row)))) for row in v[1:]]


def pacing(s):
    t = now()
    if s.get("rest_until") and dt.datetime.fromisoformat(s["rest_until"]) > t:
        return "REST until " + dt.datetime.fromisoformat(s["rest_until"]).strftime("%H:%M IST")
    recent = [dt.datetime.fromisoformat(x) for x in s["scans"]
              if dt.datetime.fromisoformat(x) > t - dt.timedelta(minutes=BATCH_WINDOW_MIN)]
    if recent and max(recent) > t - dt.timedelta(minutes=GAP_MIN):
        return "WAIT gap until " + (max(recent) + dt.timedelta(minutes=GAP_MIN)).strftime("%H:%M IST")
    return None


def eligible(p, s):
    pid = p.get("id", "")
    if not pid or pid in s["done"] or pid in s["skip"]: return False
    if not p.get("accepted") or p.get("dm1_sent") or p.get("replied") or p.get("withdrawn"): return False
    if p.get("stage") in ("Hold", "Personal", "Founder") or "Founder" in p.get("route", ""): return False
    if p.get("review") in ("personal", "pending"): return False
    if p.get("research") in ("Flagged, no draft",): return False
    if "linkedin.com/in/" not in p.get("linkedin_url", ""): return False
    if "Profile test" in p.get("notes", "") or "Profile scan:" in p.get("notes", ""): return False
    return True


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "next"
    s = load()
    if cmd == "next":
        w = pacing(s)
        if w: print(w); return
        q = [p for p in people() if eligible(p, s)]
        if not q: print("IDLE no accepted person waiting for a profile scan"); return
        q.sort(key=lambda p: p.get("accepted", ""))
        p = q[0]
        print(json.dumps({k: p.get(k, "") for k in ("id", "name", "title", "company", "owner", "linkedin_url", "accepted")}))
    elif cmd == "done":
        pid, nf = sys.argv[2], sys.argv[3]
        t = now(); s["scans"].append(t.isoformat()); s["done"][pid] = {"at": t.isoformat(), "notes": nf}
        recent = [x for x in s["scans"] if dt.datetime.fromisoformat(x) > t - dt.timedelta(minutes=BATCH_WINDOW_MIN)]
        if len(recent) >= BATCH:
            s["rest_until"] = (t + dt.timedelta(minutes=REST_MIN)).isoformat(); s["scans"] = []
            print("recorded; batch of %d done, resting until %s" % (BATCH, (t + dt.timedelta(minutes=REST_MIN)).strftime("%H:%M IST")))
        else:
            print("recorded; %d of %d in this batch" % (len(recent), BATCH))
        save(s)
    elif cmd == "skip":
        s["skip"][sys.argv[2]] = " ".join(sys.argv[3:]) or "skipped"; save(s); print("skipped")
    elif cmd == "status":
        print(json.dumps({"rest_until": s.get("rest_until"), "batch_scans": len(s["scans"]),
                          "done": len(s["done"]), "skipped": len(s["skip"])}))


if __name__ == "__main__":
    main()
