#!/usr/bin/env python3
# Ari worker step 0, Gmail (spec docs/specs/04 fault #1; Owner approved Oct 21 2026 10:59 IST from Claude relay R-20261021-06).
# The ONLY writer of Brief.gmail_last_scan. Before this, the worker prompt set the cursor by hand.
#
#   1. reply_ingest.py scan    LinkedIn message emails -> replies (keeps its own cursor in the database)
#   2. accept_ingest scan      accept emails -> people.accepted through ari_worker_accept_record (0032)
#   3. cursor                  Brief.gmail_last_scan = new_cursor(...) only when 1 AND 2 both succeeded.
#                              It never moves backwards and stays frozen on any Gmail failure.
#   Per message id failure counter (work/state/gmail_failures.json): an id whose metadata read fails on 3 runs
#   is skipped from then on (so one broken message cannot freeze the cursor forever), and one ALERT line is
#   printed for it, once.
#
# usage (project folder, shell credentials [{"provider":"google","email":"owner@example.com"}]):
#   python3 scripts/gmail_step.py          run it (prints one JSON line, plus any ALERT: line)
#   python3 scripts/gmail_step.py --dry    plan only, writes nothing (no replies, accepts, cursor or state)
# Legacy Python path: app2 gmail-ingest (app2/jobs/src/gmail) replaces this at promote.
import sys, os, json, subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
STATE = os.path.join(ROOT, "work", "state", "gmail_failures.json")
SKIP_AFTER = 3
DEFAULT_TS = 1792131600  # 2026-10-16 11:50 IST, the worker's old default


def load_state(path=STATE):
    try:
        d = json.load(open(path))
        return {"counts": dict(d.get("counts") or {}), "alerted": list(d.get("alerted") or [])}
    except (OSError, ValueError):
        return {"counts": {}, "alerted": []}


def save_state(st, path=STATE):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    json.dump(st, open(tmp, "w"), indent=1, sort_keys=True)
    os.replace(tmp, path)


def skip_ids(st):
    return {i for i, n in st["counts"].items() if n >= SKIP_AFTER}


def update_state(st, failed_ids, skipped):
    """Count this run's failures; ids that failed before but read fine now are forgiven. -> list of new alerts."""
    failed = set(failed_ids)
    for i in list(st["counts"]):
        if i not in failed and i not in skipped:
            del st["counts"][i]
    alerts = []
    for i in failed:
        st["counts"][i] = st["counts"].get(i, 0) + 1
        if st["counts"][i] >= SKIP_AFTER and i not in st["alerted"]:
            st["alerted"].append(i)
            alerts.append(i)
    return alerts


def next_cursor(old, accept_rep, reply_ok):
    """The cursor moves only when both ingests succeeded, and only forwards."""
    if not reply_ok or accept_rep is None:
        return old, "frozen: %s" % ("reply ingest failed" if not reply_ok else "accept ingest failed")
    if accept_rep.get("gmail_failed"):
        return old, "frozen: a Gmail read failed"
    if not isinstance(accept_rep.get("writes"), dict):
        return old, "frozen: accepts not recorded (%s)" % str(accept_rep.get("writes"))[:80]
    want = int((accept_rep.get("cursor") or {}).get("would_set") or old)
    return max(old, want), "advanced" if want > old else "unchanged"


def read_cursor(A):
    sh = A.read_sheet(["Brief"])
    hdr, rows = sh["Brief"]
    for n, r in enumerate(rows):
        if r and r[0].strip() == "gmail_last_scan":
            try:
                return int(float(r[1] or 0)), n + 2
            except ValueError:
                return 0, n + 2
    return 0, None


def write_cursor(A, row, value):
    if row is None:
        A.gws(["sheets", "spreadsheets", "values", "append", "--params", json.dumps(
            {"spreadsheetId": A.SHEET_ID, "range": "Brief!A:B", "valueInputOption": "RAW"}),
            "--json", json.dumps({"values": [["gmail_last_scan", str(value)]]})])
    else:
        A.gws(["sheets", "spreadsheets", "values", "update", "--params", json.dumps(
            {"spreadsheetId": A.SHEET_ID, "range": "Brief!B%d" % row, "valueInputOption": "RAW"}),
            "--json", json.dumps({"values": [[str(value)]]})])


def run_reply(dry):
    cmd = [sys.executable, os.path.join(HERE, "reply_ingest.py"), "scan"] + (["--dry"] if dry else [])
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600, cwd=ROOT)
    except Exception as e:
        return False, str(e)[:200]
    out = (r.stdout or "").strip().splitlines()
    return r.returncode == 0, (out[-1] if out else (r.stderr or "")[-200:])


def main(argv, A=None, reply=run_reply, state_path=STATE):
    dry = "--dry" in argv
    if A is None:
        import accept_ingest as A
    st = load_state(state_path)
    skipped = skip_ids(st)
    old, row = read_cursor(A)
    base = old or DEFAULT_TS
    reply_ok, reply_out = reply(dry)
    try:
        rep = A.cmd_scan(max(0, base - A.OVERLAP), False, dry, show=False, skip=skipped)
    except BaseException as e:  # a Gmail list failure or a db error: freeze, count nothing per id
        rep, err = None, str(e)[:200]
    else:
        err = None
    alerts = [] if dry or rep is None else update_state(st, rep.get("failed_ids") or [], skipped)
    new, why = next_cursor(base, rep, reply_ok)
    if dry:
        why = "dry: " + why
    elif new != base or row is None:
        if new > base or row is None:
            write_cursor(A, row, new)
    if not dry:
        save_state(st, state_path)
    out = {"cursor_old": old, "cursor_new": new if not dry else old, "cursor": why, "reply_ok": reply_ok,
           "reply": reply_out[:300], "accept_error": err,
           "new_accepts": (rep or {}).get("new_accepts", []), "unmatched": (rep or {}).get("unmatched"),
           "ambiguous": (rep or {}).get("ambiguous"), "skipped_ids": len(skipped)}
    print(json.dumps(out, default=str))
    for i in alerts:
        print("ALERT: Ari skipped a LinkedIn email it could not read on %d runs (Gmail id %s). Accepts in it may need "
              "a manual tap in the app." % (SKIP_AFTER, i))
    return 0 if reply_ok and rep is not None else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
