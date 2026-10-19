#!/usr/bin/env python3
# Ari accept ingest (spec docs/specs/04_engine_watchdog_and_ingest.md, Oct 17 2026; Otto). Gmail parser = SUPPLEMENT:
# Owner's decision (Oct 17 23:21) is that the manual Accepted tap in the Today queue is the primary path.
# Regexes mirror app2/jobs/src/gmail/parse.ts (ACCEPT_SUBJ / NOT_ACCEPT / FULLNAME / LINKEDIN_FROM): change both together.
#
# usage (project folder; shell credentials [{"provider":"google","email":"owner@example.com"}]; Supabase as ari_worker
# through scripts/ari_db.py):
#   python3 scripts/accept_ingest.py pending --since <unix>     count of unhandled LinkedIn accept + message emails (read-only)
#   python3 scripts/accept_ingest.py scan [--since <unix>] [--backfill] [--dry]
#       match accept emails to People (vanity when present, then unique full name) and record them with
#       ari_worker_accept_record (needs migration 0032). --dry or no 0032: prints the plan, writes nothing.
#   python3 scripts/accept_ingest.py backfill --days 14 --dry-run
#       scan --backfill --dry over the last N days, plus the Log repair plan and the accepted-date corrections. Counts and
#       P-ids only (no names in output).
#   python3 scripts/accept_ingest.py repair-log      RETIRED Oct 19 2026 (spec-05 repair finished Oct 18, 395 rows): exit 2.
# Gmail: metadata only (From, Subject, Date + snippet); never bodies, never modifies mail. Sheet: read only.
# Backward compatible: if 0032 is missing (ari_worker_gmail_known 404s), dedupe falls back to People.accepted in the Sheet.
import sys, os, re, json, html, subprocess, unicodedata, datetime as dt
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SHEET_ID = "SHEET_ID_PLACEHOLDER"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
OVERLAP = 3600            # re-read the hour before the cursor (late-indexed mail)
EVENTS = ("Connect sent", "Accepted", "DM1 sent", "DM2 sent", "DM3 sent", "Replied", "Meeting set")  # fixed Log vocabulary

# --- mirrors parse.ts -----------------------------------------------------------------------------------------------------
LINKEDIN_FROM = re.compile(r"<?\s*[^<>\s@]+@(?:[a-z0-9-]+\.)*linkedin\.com\s*>?\s*$", re.I)
ACCEPT_SUBJ = [
    re.compile(r"^(.+?),? (?:has )?accepted your (?:LinkedIn )?(?:connection )?invitation\b", re.I),
    re.compile(r"^You and (.+?) are now connected\b", re.I), re.compile(r"^(.+?) is now a connection\b", re.I),
    re.compile(r"^(.+?) (?:a accepté votre invitation|hat Ihre Einladung angenommen|aceptó tu invitación)", re.I),
]
NOT_ACCEPT = re.compile(r"other people.s connections|I.d like to connect|role - \d+ connection", re.I)
FULLNAME = re.compile(r"See (.+?)(?:'|’|&#39;)s connections, experience", re.I)
# the senders scripts/reply_ingest.py scans (worker step 0 runs it); these still wake the worker
MESSAGE_FROM = re.compile(r"(messaging-digest-noreply|messages-noreply|hit-reply|inmail-hit-reply)@linkedin\.com", re.I)


def core_name(n):
    return n.split(",")[0].strip()


def classify(frm, subject, snippet=""):
    """-> ('accept', name) | ('message', None) | ('other', None). Same rules as parseLinkedInEmail for accepts."""
    if not LINKEDIN_FROM.search(frm or ""):
        return "other", None
    subj = (subject or "").strip()
    if not NOT_ACCEPT.search(subj):
        for r in ACCEPT_SUBJ:
            m = r.search(subj)
            if m and m.group(1):
                name = m.group(1).strip()
                full = FULLNAME.search(html.unescape(snippet or ""))
                if full and core_name(full.group(1)).lower().startswith(core_name(name).lower()):
                    name = full.group(1).strip()
                return "accept", core_name(name)
    if MESSAGE_FROM.search(frm or ""):
        return "message", None
    return "other", None


# --- names / dates --------------------------------------------------------------------------------------------------------
def norm(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    s = re.sub(r"\([^)]*\)", " ", s)                     # nicknames / pronouns in brackets
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def vanity_of(url):
    m = re.search(r"linkedin\.com/(?:comm/)?in/([^/?#\s]+)", url or "", re.I)
    return m.group(1).lower() if m else None


def ist(ts):
    return dt.datetime.fromtimestamp(ts, IST)


def parse_sheet_dt(v):
    """Sheet cell 'yyyy-MM-dd' or 'yyyy-MM-dd HH:mm' (IST) -> (aware datetime, has_time) or (None, False)."""
    v = (v or "").strip()
    for fmt, has_t in (("%Y-%m-%d %H:%M", True), ("%Y-%m-%d %H:%M:%S", True), ("%Y-%m-%d", False)):
        try:
            d = dt.datetime.strptime(v, fmt).replace(tzinfo=IST)
            return (d if has_t else d.replace(hour=12)), has_t
        except ValueError:
            pass
    return None, False


# --- I/O ------------------------------------------------------------------------------------------------------------------
def gws(args, timeout=90):
    r = subprocess.run(["gws"] + args, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError("gws failed: " + (r.stderr or r.stdout)[-300:])
    out = r.stdout.strip()
    return json.loads(out) if out else {}


class Gmail:
    """Paged, metadata-only reader. self.failed is set when any call failed (the cursor must then stay frozen)."""

    def __init__(self, call=gws):
        self.call, self.failed = call, False

    def list_ids(self, after):
        ids, tok = [], None
        while True:
            p = {"userId": "me", "q": "from:linkedin.com in:anywhere after:%d" % after, "maxResults": 500}
            if tok:
                p["pageToken"] = tok
            d = self.call(["gmail", "users", "messages", "list", "--params", json.dumps(p)])
            ids += [m["id"] for m in d.get("messages", []) or []]
            tok = d.get("nextPageToken")
            if not tok:
                return ids

    def meta(self, mid):
        try:
            d = self.call(["gmail", "users", "messages", "get", "--params", json.dumps(
                {"userId": "me", "id": mid, "format": "metadata", "metadataHeaders": ["From", "Subject", "Date"]})])
        except Exception:
            self.failed = True
            return None
        h = {x["name"].lower(): x["value"] for x in (d.get("payload") or {}).get("headers", [])}
        return {"id": mid, "ts": int(d.get("internalDate", "0")) // 1000, "from": h.get("from", ""),
                "subject": h.get("subject", ""), "snippet": d.get("snippet", "")}

    def messages(self, after, skip=()):
        ids = [i for i in self.list_ids(after) if i not in skip]
        with ThreadPoolExecutor(6) as ex:
            out = [m for m in ex.map(self.meta, ids) if m]
        for m in out:
            m["kind"], m["name"] = classify(m["from"], m["subject"], m["snippet"])
        return sorted(out, key=lambda m: m["ts"])


def read_sheet(tabs):
    d = gws(["sheets", "spreadsheets", "values", "batchGet", "--params", json.dumps(
        {"spreadsheetId": SHEET_ID, "ranges": tabs, "valueRenderOption": "FORMATTED_VALUE"})])
    out = {}
    for tab, vr in zip(tabs, d.get("valueRanges", [])):
        vals = vr.get("values", [])
        hdr = [str(h).strip() for h in vals[0]] if vals else []
        out[tab] = (hdr, [[str(x) for x in r] + [""] * (len(hdr) - len(r)) for r in vals[1:]])
    return out


def rows_as_dicts(hdr, rows):
    return [dict(zip([h.lower() for h in hdr], r)) for r in rows]


class DB:
    """ari_worker reads/RPCs through ari_db. has_0032 is probed ONCE; any error = not available (old behaviour)."""

    def __init__(self):
        self.has_0032, self.err = False, None
        try:
            sys.path.insert(0, HERE)
            import ari_db
            self.db = ari_db
            r = ari_db.rpc("ari_worker_gmail_known", {"p_ids": []})
            self.has_0032 = isinstance(r, list)
        except BaseException as e:  # ari_db raises SystemExit on HTTP errors (404 = 0032 not applied)
            self.err = str(e)[:160]

    def known(self, ids):
        if not self.has_0032 or not ids:
            return set()
        try:
            return set(self.db.rpc("ari_worker_gmail_known", {"p_ids": list(ids)}) or [])
        except BaseException:  # fail-open: nothing known = more counted, never fewer
            return set()

    def people(self):
        try:
            return {r["id"]: r for r in self.db.get("people?select=id,accepted,ts_approx,stage,deleted_at")}
        except BaseException:
            return None

    def record(self, mid, pid, at_iso, how):
        return self.db.rpc("ari_worker_accept_record", {"p_msg_id": mid, "p_person_id": pid, "p_at": at_iso, "p_how": how})


# --- matching -------------------------------------------------------------------------------------------------------------
class People:
    def __init__(self, rows):
        """rows: dicts keyed by lower-case Sheet header (id, name, linkedin_url, accepted, connect_sent, stage, review)."""
        self.rows = [r for r in rows if (r.get("id") or "").strip()]
        self.by_id = {r["id"].strip(): r for r in self.rows}

    def match(self, name, vanity=None):
        if vanity:
            hits = [r for r in self.rows if vanity_of(r.get("linkedin_url")) == vanity]
            if len(hits) == 1:
                return hits[0]["id"].strip(), "vanity"
        if not name:
            return None, "none"
        key = norm(core_name(name))
        hits = [r for r in self.rows if norm(core_name(r.get("name", ""))) == key]
        if len(hits) > 1:  # prefer people we actually sent a connect to
            sent = [r for r in hits if (r.get("connect_sent") or "").strip()]
            hits = sent if len(sent) == 1 else hits
        if len(hits) == 1:
            return hits[0]["id"].strip(), "full_name"
        return None, ("ambiguous" if hits else "none")


# --- commands -------------------------------------------------------------------------------------------------------------
def pending(since, people_rows, gmail=None, db=None):
    """Unhandled accept emails + LinkedIn message emails. An accept counts when it is not in gmail_events (0032) and its
    person has no accepted value; one at or before the cursor counts only when it matched a person (a missed accept).
    Message emails count only when newer than the cursor (reply_ingest.py keeps its own dedupe)."""
    gmail = gmail or Gmail()
    db = db if db is not None else DB()
    msgs = gmail.messages(since - OVERLAP)
    known = db.known([m["id"] for m in msgs if m["kind"] == "accept"])
    ppl = People(people_rows)
    acc = msg = 0
    for m in msgs:
        if m["kind"] == "message" and m["ts"] > since:
            msg += 1
        elif m["kind"] == "accept" and m["id"] not in known:
            pid, _ = ppl.match(m["name"])
            if pid and (ppl.by_id[pid].get("accepted") or "").strip():
                continue                                   # already recorded
            if pid or m["ts"] > since:
                acc += 1
    return {"accepts": acc, "messages": msg, "db_0032": db.has_0032, "gmail_failed": gmail.failed}


def plan(msgs, ppl, dbpeople, known):
    """What ari_worker_accept_record would do for each accept email. Returns list of dicts (no names)."""
    out = []
    for m in msgs:
        if m["kind"] != "accept":
            continue
        at = ist(m["ts"])
        pid, how = ppl.match(m["name"])
        row = {"msg": m["id"], "ts": m["ts"], "at_ist": at.strftime("%Y-%m-%d %H:%M"), "pid": pid, "how": how,
               "known": m["id"] in known, "action": None, "fault": None}
        if not pid:
            row["action"] = "unmatched" if how == "none" else "ambiguous"
            out.append(row); continue
        sheet_v = (ppl.by_id[pid].get("accepted") or "").strip()
        db_r = (dbpeople or {}).get(pid)
        if db_r is not None and db_r.get("accepted"):
            cur = dt.datetime.fromisoformat(db_r["accepted"].replace("Z", "+00:00")).astimezone(IST)
            approx = "accepted" in (db_r.get("ts_approx") or [])
        elif db_r is None and sheet_v:
            cur, has_t = parse_sheet_dt(sheet_v)
            approx = not has_t
        else:
            cur, approx = None, False
        row["sheet_accepted"], row["db_accepted"] = sheet_v, (cur.strftime("%Y-%m-%d %H:%M") if cur else "")
        if cur is None:
            row["action"] = "new_accept"
        else:
            new = at if approx else min(cur, at)
            if abs((new - cur).total_seconds()) < 60:
                row["action"] = "already_exact"
            else:
                row["action"] = "correct_date"
                utc_d = dt.datetime.fromtimestamp(m["ts"], dt.timezone.utc).date()
                if cur.date() != at.date() and cur.date() == utc_d:
                    row["fault"] = "utc_dated"
                elif cur.date() == at.date():
                    row["fault"] = "approximate_same_day"
                elif cur > at:
                    row["fault"] = "later_than_email"
                else:
                    row["fault"] = "other"
        out.append(row)
    return out


def log_repairs(log_hdr, log_rows, accepts):
    """Faults in the Sheet Log for accept events. accepts: plan rows with a pid. Returns {fault: [row numbers or P-ids]}."""
    ix = {h.lower(): i for i, h in enumerate(log_hdr)}
    ts_i, pid_i, ev_i = ix.get("ts", 0), ix.get("person_id", 1), ix.get("event", 2)
    pid_re = re.compile(r"^P[A]?\d+$")
    f = {"swapped_columns": [], "nonstandard_event": [], "missing_row": [], "utc_dated_accepted": [],
         "approximate_time_accepted": []}
    accepted_rows = {}
    for n, r in enumerate(log_rows, start=2):
        ts, pid, ev = r[ts_i].strip(), r[pid_i].strip(), r[ev_i].strip()
        swapped = not pid_re.match(pid) and bool(pid_re.match(ev))
        if swapped:
            f["swapped_columns"].append(n)
            pid, ev = ev, pid
        if re.match(r"(?i)^accept", ev) and ev != "Accepted":
            f["nonstandard_event"].append(n)
        if re.match(r"(?i)^accept", ev) and pid_re.match(pid):
            accepted_rows.setdefault(pid, []).append((n, ts))
    by_pid = {}
    for a in accepts:
        if a.get("pid"):
            by_pid.setdefault(a["pid"], a)   # earliest email per person (accepts are time-sorted)
    for pid, a in sorted(by_pid.items()):
        rows = accepted_rows.get(pid)
        if not rows:
            f["missing_row"].append(pid); continue
        n, ts = rows[0]
        d, has_t = parse_sheet_dt(ts)
        at = ist(a["ts"])
        if d is None:
            continue
        utc = dt.datetime.fromtimestamp(a["ts"], dt.timezone.utc)
        if d.date() != at.date() and d.date() == utc.date():
            f["utc_dated_accepted"].append(n)
        elif abs((d - at).total_seconds()) > 3600 and (not has_t or d.strftime("%H:%M") in ("12:00", "00:00")):
            f["approximate_time_accepted"].append(n)
    return f


def new_cursor(old, msgs, failed):
    """max internalDate of handled accept/message mail; frozen when any Gmail call failed."""
    if failed:
        return old
    hs = [m["ts"] for m in msgs if m["kind"] in ("accept", "message")]
    return max([old] + hs)


def cmd_scan(since, backfill, dry, show=True):
    gmail, db = Gmail(), DB()
    sh = read_sheet(["People", "Log", "Brief"])
    ppl = People(rows_as_dicts(*sh["People"]))
    msgs = gmail.messages(since)
    known = db.known([m["id"] for m in msgs if m["kind"] == "accept"])
    dbp = db.people()
    rows = plan(msgs, ppl, dbp, known)
    rep = {
        "window_ist": [ist(since).strftime("%Y-%m-%d %H:%M"), dt.datetime.now(IST).strftime("%Y-%m-%d %H:%M")],
        "linkedin_emails": len(msgs), "accept_emails": sum(1 for m in msgs if m["kind"] == "accept"),
        "message_emails": sum(1 for m in msgs if m["kind"] == "message"), "gmail_failed": gmail.failed,
        "db_0032": db.has_0032, "db_people_read": dbp is not None,
        "already_in_gmail_events": sum(1 for r in rows if r["known"]),
        "matched": sum(1 for r in rows if r["pid"]), "by_method": {},
        "unmatched": sum(1 for r in rows if r["action"] == "unmatched"),
        "ambiguous": sum(1 for r in rows if r["action"] == "ambiguous"),
        "already_recorded": sum(1 for r in rows if r["action"] in ("already_exact", "correct_date")),
        "already_recorded_exact": sum(1 for r in rows if r["action"] == "already_exact"),
        "new_accepts": [r["pid"] for r in rows if r["action"] == "new_accept"],
        "accepted_date_corrections": [{"pid": r["pid"], "fault": r["fault"]} for r in rows if r["action"] == "correct_date"],
        "sheet_vs_db_accepted_differs": [r["pid"] for r in rows if r.get("pid") and r.get("sheet_accepted") and r.get("db_accepted")
                                         and parse_sheet_dt(r["sheet_accepted"])[0] and
                                         parse_sheet_dt(r["sheet_accepted"])[0].strftime("%Y-%m-%d %H:%M")[:10] != r["db_accepted"][:10]],
    }
    for r in rows:
        if r["pid"]:
            rep["by_method"][r["how"]] = rep["by_method"].get(r["how"], 0) + 1
    rep["log_repairs"] = log_repairs(sh["Log"][0], sh["Log"][1], [r for r in rows if r["pid"]])
    brief = {r[0]: r[1] for r in sh["Brief"][1] if r}
    try:
        old = int(float(brief.get("gmail_last_scan") or 0))
    except ValueError:
        old = 0
    rep["cursor"] = {"brief_gmail_last_scan": old, "would_set": new_cursor(old, msgs, gmail.failed)}
    if not dry:
        if not db.has_0032:
            rep["writes"] = "none: migration 0032 not applied (ari_worker_accept_record missing)"
        elif gmail.failed:
            rep["writes"] = "none: a Gmail read failed; rerun"
        else:
            res = []
            for r in rows:
                if r["known"]:
                    continue
                at = dt.datetime.fromtimestamp(r["ts"], dt.timezone.utc).isoformat()
                res.append(db.record(r["msg"], r["pid"], at, r["how"]))
            rep["writes"] = {"recorded": len(res), "new_accept": sum(1 for x in res if (x or {}).get("new_accept")),
                             "push": "none (backfill)" if backfill else "caller pushes new_accept rows"}
            # Sheet Log repair and the Brief cursor stay manual until the morning review (spec 2 steps 4 and 5).
    else:
        rep["writes"] = "none (dry run)"
    if show:
        print(json.dumps(rep, indent=1))
    return rep


# --- repair-log: RETIRED (v18.17.7, Oct 19 2026) ----------------------------------------------------------------------------
# The spec-05 Log history repair (docs/specs/05_log_history_repair.md) finished Oct 18 2026 (395 rows). Migration 0038
# (S1 release 6, part 4) drops the ari_worker_log_repair RPC this mode called, so the mode is gone too. The command
# now refuses with exit 2 and touches nothing. The pre-repair snapshots stay under work/backups/log_repair_<utc>/.
REPAIR_RETIRED = ("repair-log is retired: the spec-05 Log repair finished Oct 18 2026 (395 rows) and migration 0038 "
                  "drops its RPC. Nothing was read or written.")


def cmd_repair_log(a=None, io=None):
    print(REPAIR_RETIRED)
    return 2


def main(argv):
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__ or open(__file__).read().split("import sys")[0]); return 0
    cmd, a = argv[0], argv[1:]
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d
    if cmd == "pending":
        sh = read_sheet(["People"])
        r = pending(int(float(opt("--since"))), rows_as_dicts(*sh["People"]))
        print(r["accepts"] + r["messages"]); return 0
    if cmd == "scan":
        since = int(float(opt("--since", 0))) or int(dt.datetime.now().timestamp()) - 86400
        cmd_scan(since, "--backfill" in a, "--dry" in a or "--dry-run" in a); return 0
    if cmd == "repair-log":
        return cmd_repair_log(a)
    if cmd == "backfill":
        if "--dry-run" not in a and "--dry" not in a:
            print("backfill without --dry-run is not enabled before the morning review"); return 2
        days = int(opt("--days", 14))
        cmd_scan(int(dt.datetime.now().timestamp()) - days * 86400, True, True); return 0
    print("unknown command " + cmd); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
