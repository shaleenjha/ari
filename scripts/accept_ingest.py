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
#   python3 scripts/accept_ingest.py repair-log [--dry-run] [--since <unix>] [--out FILE]
#       spec docs/specs/05_log_history_repair.md. Plans the atomic Log + accepted-date repair: per row old -> new values,
#       old -> new sheet_key, rows to append on both sides, People.accepted fixes. Reads only. Default mode.
#   ARI_SYNC_PAUSED=1 python3 scripts/accept_ingest.py repair-log --execute [--out FILE]
#       refuses unless tasks 56e17ef1 + e8fbd86f are paused (env flag), no sync ran for 15 min, the sync lock is free, the
#       ari_worker_log_repair RPC exists (work/0036_log_repair_rpc.sql) and the plan has no blockers. Snapshots to
#       work/backups/log_repair_<utc>/, applies (DB half then Sheet half per item), post-checks, releases the lock.
#   ARI_SYNC_PAUSED=1 python3 scripts/accept_ingest.py repair-log --rollback work/backups/log_repair_<utc>
# Gmail: metadata only (From, Subject, Date + snippet); never bodies, never modifies mail. Sheet: read only (except repair-log --execute/--rollback).
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


# --- repair-log: atomic historical repair of the Log tab + accepted dates (spec docs/specs/05_log_history_repair.md) -------
# The sync keys every Sheet Log row by its CONTENT (sync_sheet_supabase.log_key: md5 of ts|person_id|event|detail, first 20
# hex, plus "#<n>" = the n-th identical row in Sheet order). Rewriting a row changes its key, so a plain Sheet edit makes the
# next sync insert a duplicate. repair-log therefore changes each row on BOTH sides in one pass, with the sync paused:
# the DB row is found by its OLD key and gets the new content and the recomputed NEW key; missing rows are written to both
# sides with the key the sync itself would compute. Dry run is the default and only reads.
REPAIR_DETAIL_NEW = "gmail backfill"          # detail of the appended Accepted rows (Owner may change before running)
REPAIR_SOURCE_NEW = "backfill"                 # log_entries.source of the appended rows (check constraint allows it)
REPAIR_SINCE_DEFAULT = 1791050640              # 2026-10-03 23:34 IST: the window of the Oct 17 backfill dry run
LOG_COLS = ["ts", "person_id", "event", "detail"]
PID_RE = re.compile(r"^P[A]?\d+$")
EPOCH_LOCK = "1970-01-01T00:00:00+00:00"       # what sync_sheet_supabase.py writes to release its lock
LOCK_MINUTES = 8                               # the sync skips its run while a lock younger than this exists
QUIET_MINUTES = 15                             # preflight: no sync may have finished in the last 15 min (cadence is 10)


def _sync_mod():
    sys.path.insert(0, HERE)
    import sync_sheet_supabase as S
    return S


def _keys(rows4):
    """rows4: [(rownum, [ts, pid, event, detail])] in Sheet order -> {rownum: key}, exactly as the sync computes them."""
    S, seen, out = _sync_mod(), {}, {}
    for n, v in rows4:
        if not any(v):
            continue
        out[n] = S.log_key(list(v), seen)
    return out


def _log4(hdr, rows):
    """Sheet Log tab -> [(rownum, [ts, pid, event, detail])] (rows as read_sheet returns them, data from row 2)."""
    ix = [hdr.index(c) if c in hdr else None for c in LOG_COLS]
    return [(n, [r[i] if i is not None and i < len(r) else "" for i in ix]) for n, r in enumerate(rows, start=2)]


def _minute(v):
    """Sheet text or DB timestamptz -> 'YYYY-MM-DD HH:MM' IST (Sheet bare dates become noon, as the sync stores them)."""
    S = _sync_mod()
    if not v:
        return ""
    if re.match(r"^\d{4}-\d{2}-\d{2}( \d{1,2}:\d{2}(:\d{2})?)?$", str(v).strip()):
        v = S.parse_ts(str(v)) or v
    try:
        return S.ts_to_ist(v).strftime("%Y-%m-%d %H:%M")
    except ValueError:
        return str(v)


def _same_content(sheet4, dbrow):
    return (_minute(sheet4[0]) == _minute(dbrow.get("ts")) and (sheet4[1] or None) == (dbrow.get("person_id") or None)
            and (sheet4[2] or "(blank)") == dbrow.get("event") and (sheet4[3] or None) == (dbrow.get("detail") or None))


def accept_times(msgs, ppl):
    """Earliest accept email per matched person: {pid: (msg_id, unix_ts)}."""
    out = {}
    for m in msgs:
        if m["kind"] != "accept":
            continue
        pid, _ = ppl.match(m["name"])
        if pid and (pid not in out or m["ts"] < out[pid][1]):
            out[pid] = (m["id"], m["ts"])
    return out


def repair_plan(log_hdr, log_rows, ppl_hdr, ppl_rows, db_log, db_people, accepts):
    """Pure planner. accepts {pid: (msg_id, unix_ts)}; db_log = log_entries rows; db_people {id: {accepted, ts_approx}}.
    Returns the exact per-row changes, the key moves and everything that blocks --execute."""
    cur = _log4(log_hdr, log_rows)
    new = {n: list(v) for n, v in cur}
    edits = {}
    # 1. column-swapped and nonstandard accept rows -> fixed vocabulary; ts = the accept email's own time when known
    for n, v in cur:
        ts, pid, ev, det = v
        swapped = not PID_RE.match(pid.strip()) and bool(PID_RE.match(ev.strip()))
        if swapped:
            pid, ev = ev.strip(), pid.strip()
        if re.match(r"(?i)^accept", ev.strip()) and ev != "Accepted" and PID_RE.match(pid.strip()):
            ev = "Accepted"
        if [pid, ev] != v[1:3]:
            if ev == "Accepted" and pid in accepts:
                ts = ist(accepts[pid][1]).strftime("%Y-%m-%d %H:%M")
            new[n] = [ts, pid, ev, det]
            edits[n] = {"swapped_columns": swapped, "nonstandard_event": v[2 if not swapped else 1].strip() != "Accepted"}
    # 2. accept emails with no Accepted row (after the fixes above) -> appended rows, oldest first
    have = {v[1] for v in new.values() if v[2] == "Accepted"}
    last = max([n for n, v in cur if any(v)] or [1])
    appends = []
    for pid, (mid, t) in sorted(accepts.items(), key=lambda kv: (kv[1][1], kv[0])):
        # only accepts already recorded on the person; a brand-new accept is the worker's / scan's job (it writes its own row)
        if pid not in have and ((db_people or {}).get(pid) or {}).get("accepted"):
            last += 1
            appends.append({"row": last, "pid": pid, "msg": mid,
                            "new": [ist(t).strftime("%Y-%m-%d %H:%M"), pid, "Accepted", REPAIR_DETAIL_NEW]})
    # 3. keys before and after, over the whole tab (identical rows are numbered in Sheet order, so one edit can move others)
    k_old = _keys(cur)
    k_new = _keys(sorted(list(new.items()) + [(a["row"], a["new"]) for a in appends]))
    db_by_key = {r["sheet_key"]: r for r in db_log if r.get("sheet_key")}
    blockers, log_changes = [], []
    for n, v in cur:
        if n not in k_old:
            continue
        ko, kn = k_old[n], k_new.get(n)
        if n not in edits and ko == kn:
            continue
        d = db_by_key.get(ko)
        item = {"row": n, "kind": "edit" if n in edits else "rekey", "old": v, "new": new[n], "old_key": ko, "new_key": kn,
                "faults": [f for f, on in edits.get(n, {}).items() if on], "db_id": d["id"] if d else None, "db_done": False}
        if d is None:
            dn = db_by_key.get(kn)
            if dn is not None and _same_content(new[n], dn):
                item["db_id"], item["db_done"] = dn["id"], True          # a previous run did the DB half already
            else:
                blockers.append("row %d: no DB row with key %s" % (n, ko))
        elif not _same_content(v, d):
            blockers.append("row %d: DB row %s content differs from the Sheet; refusing to touch it" % (n, d["id"]))
        log_changes.append(item)
    for a in appends:
        a["new_key"] = k_new[a["row"]]
        d = db_by_key.get(a["new_key"])
        a["db_done"] = d is not None and _same_content(a["new"], d)
        if d is not None and not a["db_done"]:
            blockers.append("append %s: key %s already used by DB row %s" % (a["pid"], a["new_key"], d["id"]))
    # 4. the Sheet and the DB must agree before we start, except for halves a previous run already did
    planned_new = {c["new_key"] for c in log_changes} | {a["new_key"] for a in appends}
    done_old = {c["old_key"] for c in log_changes if c["db_done"]}
    sheet_keys = set(k_old.values())
    unexplained_sheet = sorted(k for k in sheet_keys if k not in db_by_key and k not in done_old)
    unexplained_db = sorted(k for k in db_by_key if k not in sheet_keys and k not in planned_new)
    if unexplained_sheet:
        blockers.append("%d Sheet Log rows have no DB row (run one normal sync first)" % len(unexplained_sheet))
    if unexplained_db:
        blockers.append("%d DB log rows have keys that are not in the Sheet" % len(unexplained_db))
    # 5. unique sheet_key: a new key may not belong to a different DB row that keeps it
    moving_old = {c["old_key"] for c in log_changes if not c["db_done"]}
    for c in log_changes:
        d = db_by_key.get(c["new_key"])
        if not c["db_done"] and d is not None and c["new_key"] not in moving_old:
            blockers.append("row %d: new key %s collides with DB row %s" % (c["row"], c["new_key"], d["id"]))
    order = _apply_order(log_changes)
    if order is None:
        blockers.append("key moves form a cycle; needs temporary keys (not implemented: stop and report)")
        order = log_changes
    # 6. accepted dates: People sheet cell and DB value -> the earliest accept email (IST), never later than an exact value
    ph = [h.lower() for h in ppl_hdr]
    ix_id, ix_acc = ph.index("id"), ph.index("accepted")
    sheet_row = {r[ix_id].strip(): (n, r[ix_acc].strip()) for n, r in enumerate(ppl_rows, start=2) if len(r) > ix_acc}
    people = []
    for pid, (mid, t) in sorted(accepts.items()):
        at = ist(t)
        dbr = (db_people or {}).get(pid)
        if dbr is None or pid not in sheet_row:
            blockers.append("%s: not found in %s" % (pid, "DB people" if dbr is None else "Sheet People"))
            continue
        dv = dbr.get("accepted")
        cur_db = dt.datetime.fromisoformat(dv.replace("Z", "+00:00")).astimezone(IST) if dv else None
        approx = "accepted" in (dbr.get("ts_approx") or [])
        if cur_db is None:
            people.append({"pid": pid, "action": "skip_new_accept (scan records it, not repair)"}); continue
        target = at if (approx or cur_db - at > dt.timedelta(seconds=60)) else cur_db
        fix_db = abs((target - cur_db).total_seconds()) >= 60 or (approx and target == at)
        n, sv = sheet_row[pid]
        sheet_new = target.strftime("%Y-%m-%d %H:%M")
        sv_dt, _ = parse_sheet_dt(sv)
        # Sheet cell: rewritten when the DB value moves or the Sheet shows another date; a correct bare date stays as is
        fix_sheet = sv != sheet_new and (fix_db or sv_dt is None or sv_dt.date() != target.date())
        if not (fix_db or fix_sheet):
            continue
        utc_d = dt.datetime.fromtimestamp(t, dt.timezone.utc).date()
        fault = ("utc_dated" if cur_db.date() != at.date() and cur_db.date() == utc_d else
                 "approximate_same_day" if cur_db.date() == at.date() and fix_db else
                 "sheet_time_only" if not fix_db else "other")
        people.append({"pid": pid, "row": n, "msg": mid, "fault": fault,
                       "sheet_old": sv, "sheet_new": sheet_new if fix_sheet else None,
                       "db_old": cur_db.isoformat() if cur_db else None, "db_old_approx": approx,
                       "db_new": target.isoformat() if fix_db else None})
    return {"log_changes": order, "log_appends": appends, "people": people, "blockers": blockers,
            "counts": {"sheet_log_rows": len(k_old), "db_log_rows": len(db_log),
                       "db_log_rows_without_key": sum(1 for r in db_log if not r.get("sheet_key")),
                       "edits": sum(1 for c in log_changes if c["kind"] == "edit"),
                       "rekeys_of_untouched_rows": sum(1 for c in log_changes if c["kind"] == "rekey"),
                       "appends": len(appends), "people_fixes": len([p for p in people if "row" in p]),
                       "people_db_fixes": len([p for p in people if p.get("db_new")]),
                       "people_sheet_fixes": len([p for p in people if p.get("sheet_new")]),
                       "expected_rows_after": len(k_old) + len(appends)}}


def _apply_order(changes):
    """Order key moves so no UPDATE takes a key another row still holds. None = cycle."""
    todo = [c for c in changes if not c["db_done"]]
    done = [c for c in changes if c["db_done"]]
    out = []
    while todo:
        held = {c["old_key"] for c in todo}
        ready = [c for c in todo if c["new_key"] == c["old_key"] or c["new_key"] not in held]
        if not ready:
            return None
        out += ready
        todo = [c for c in todo if c not in ready]
    return done + out


def plan_is_empty(p):
    return not (p["log_changes"] or p["log_appends"] or [x for x in p["people"] if "row" in x])


# --- I/O backends ---------------------------------------------------------------------------------------------------------
class LiveRepairIO:
    """Google Sheet via gws (Hark shell credentials google owner@example.com) and Supabase as ari_worker via ari_db."""

    def __init__(self):
        sys.path.insert(0, HERE)
        import ari_db
        self.db = ari_db

    def read_sheet(self, tabs):
        return read_sheet(tabs)

    def gmail_msgs(self, since):
        g = Gmail()
        msgs = g.messages(since)
        if g.failed:
            raise RuntimeError("a Gmail read failed; rerun")
        return msgs

    def db_log(self):
        return self.db.get("log_entries?select=id,ts,person_id,event,detail,source,sheet_key&order=id")

    def db_people(self):
        return {r["id"]: r for r in self.db.get("people?select=id,accepted,ts_approx&order=id")}

    def state_get(self, key):
        r = self.db.get("sync_state?select=value&key=eq.%s" % key)
        return r[0]["value"] if r else None

    def state_put(self, key, value):
        self.db.request("POST", "sync_state?on_conflict=key", [{"key": key, "value": value,
                        "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()}], actor="hark",
                        extra={"Prefer": "resolution=merge-duplicates,return=minimal"})

    def heartbeat(self):
        r = self.db.get("scan_heartbeat?select=running,last_started_at,last_scan_at&id=eq.1")
        return r[0] if r else {}

    def rpc_available(self):
        try:
            self.db.rpc("ari_worker_log_repair", {"p_old_key": None, "p_new_key": None, "p_expect": None, "p_set": None})
        except BaseException as e:
            return "404" not in str(e) and "PGRST202" not in str(e)
        return True

    def db_log_update(self, old_key, new_key, expect, setv):
        return self.db.rpc("ari_worker_log_repair", {"p_old_key": old_key, "p_new_key": new_key, "p_expect": expect,
                                                     "p_set": setv}, actor="backfill")

    def db_log_insert(self, row):
        self.db.request("POST", "log_entries", [row], actor="backfill", extra={"Prefer": "return=minimal"})

    def db_log_unappend(self, key):
        return self.db.rpc("ari_worker_log_unappend", {"p_key": key}, actor="backfill")

    def db_people_set(self, pid, iso):
        self.db.request("PATCH", "people?id=eq.%s" % pid, {"accepted": iso}, actor="backfill", extra={"Prefer": "return=minimal"})

    def sheet_row_values(self, tab, rownum, ncols):
        rng = "'%s'!A%d:%s%d" % (tab, rownum, _sync_mod().col_letter(ncols), rownum)
        d = gws(["sheets", "spreadsheets", "values", "get", "--params", json.dumps(
            {"spreadsheetId": SHEET_ID, "range": rng, "valueRenderOption": "FORMATTED_VALUE"})])
        v = (d.get("values") or [[]])[0]
        return [str(x) for x in v] + [""] * (ncols - len(v))

    def sheet_write(self, tab, rownum, col0, values):
        """RAW write of one row segment starting at 0-based column col0 (grows the grid when the row is past its end)."""
        meta = gws(["sheets", "spreadsheets", "get", "--params", json.dumps(
            {"spreadsheetId": SHEET_ID, "fields": "sheets.properties(title,sheetId,gridProperties)"})])
        props = [s["properties"] for s in meta["sheets"] if s["properties"]["title"] == tab][0]
        have = props["gridProperties"].get("rowCount", 1000)
        if rownum > have:
            gws(["sheets", "spreadsheets", "batchUpdate", "--params", json.dumps({"spreadsheetId": SHEET_ID}), "--json",
                 json.dumps({"requests": [{"appendDimension": {"sheetId": props["sheetId"], "dimension": "ROWS",
                                                               "length": rownum - have}}]})])
        a, b = _sync_mod().col_letter(col0 + 1), _sync_mod().col_letter(col0 + len(values))
        gws(["sheets", "spreadsheets", "values", "update", "--params", json.dumps(
            {"spreadsheetId": SHEET_ID, "range": "'%s'!%s%d:%s%d" % (tab, a, rownum, b, rownum), "valueInputOption": "RAW"}),
             "--json", json.dumps({"values": [values]})])

    def sync_dry_log(self, sheet_for_sync):
        """The sync's own Log diff in dry-run mode -> {insert, append} parsed from its log line."""
        import io, contextlib, argparse
        S = _sync_mod()
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            S.sync_log(sheet_for_sync, argparse.Namespace(dry_run=True), "sheet")
        m = re.search(r"Log (\{.*\})", buf.getvalue())
        return json.loads(m.group(1)) if m else {"insert": None, "append": None, "raw": buf.getvalue()[-300:]}

    def sync_dry_people(self, sheet_for_sync):
        S = _sync_mod()
        cfg = S.CFG["People"]
        hdr, rows = sheet_for_sync["People"]
        return S.plan_table(cfg, hdr, rows, S.sb_all("people"), S.state_get("base:People"), S.sb_columns("people"))


def _sheet_for_sync(sh):
    """read_sheet() shape -> the (header, [(rownum, row)]) shape sync_sheet_supabase uses."""
    out = {}
    for tab, (hdr, rows) in sh.items():
        out[tab] = (hdr, [(i + 2, (list(r) + [""] * len(hdr))[:len(hdr)]) for i, r in enumerate(rows)])
    return out


# --- repair-log command ---------------------------------------------------------------------------------------------------
def _gather(io, since):
    sh = io.read_sheet(["People", "Log"])
    ppl = People(rows_as_dicts(*sh["People"]))
    acc = accept_times(io.gmail_msgs(since), ppl)
    dbl, dbp = io.db_log(), io.db_people()
    return sh, acc, dbl, dbp


def _plan_from(sh, acc, dbl, dbp):
    return repair_plan(sh["Log"][0], sh["Log"][1], sh["People"][0], sh["People"][1], dbl, dbp, acc)


def _preflight(io, now=None):
    """Blocks unless the sync is paused (env flag), quiet for QUIET_MINUTES and not holding its lock."""
    now = now or dt.datetime.now(dt.timezone.utc)
    problems = []
    if os.environ.get("ARI_SYNC_PAUSED") != "1":
        problems.append("ARI_SYNC_PAUSED=1 not set (pause tasks 56e17ef1 sync AND e8fbd86f worker first)")
    lock = io.state_get("lock") or {}
    try:
        lock_at = dt.datetime.fromisoformat(str(lock.get("at", EPOCH_LOCK)).replace("Z", "+00:00"))
    except ValueError:
        lock_at = None
    if lock_at is None or now - lock_at < dt.timedelta(minutes=LOCK_MINUTES):
        problems.append("sync lock is held or unreadable (%s)" % lock.get("at"))
    last = (io.state_get("last_run") or {}).get("at")
    if last and now - dt.datetime.fromisoformat(last.replace("Z", "+00:00")) < dt.timedelta(minutes=QUIET_MINUTES):
        problems.append("a sync finished %s, less than %d min ago: is it really paused?" % (last, QUIET_MINUTES))
    hb = io.heartbeat() or {}
    if hb.get("running"):
        problems.append("scan_heartbeat says a sync is running")
    if not io.rpc_available():
        problems.append("rpc ari_worker_log_repair missing (apply work/0036_log_repair_rpc.sql first; ari_worker may only "
                        "update log_entries.sheet_key)")
    return problems


def _journal(path, **kw):
    kw["at"] = dt.datetime.now(dt.timezone.utc).isoformat()
    with open(path, "a") as f:
        f.write(json.dumps(kw) + "\n")


def _db_row(v4, key):
    S = _sync_mod()
    return {"ts": S.parse_ts(v4[0]), "person_id": v4[1] or None, "event": v4[2] or "(blank)", "detail": v4[3] or None,
            "sheet_key": key}


def _take_lock(io):
    io.state_put("lock", {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "pid": os.getpid(), "holder": "repair-log"})


def apply_plan(io, p, sh, journal, log_hdr):
    """Forward apply. Each item: DB half first, then the Sheet half; every step checks the current state first, so a rerun
    after a failure finishes the job and a rerun after success writes nothing."""
    ncols = len(log_hdr)
    ix = [log_hdr.index(c) for c in LOG_COLS]
    if ix != list(range(4)):
        raise SystemExit("Log columns are not A:D ts,person_id,event,detail; refusing")
    dbid = {r["id"]: r for r in io.db_log()}
    for c in p["log_changes"]:
        _take_lock(io)
        d = dbid.get(c["db_id"])                # by id: identical rows share content, so keys alone can mislead a rerun
        if d is not None and d.get("sheet_key") == c["new_key"] and _same_content(c["new"], d):
            pass                                 # DB half already done
        elif d is not None and d.get("sheet_key") == c["old_key"] and _same_content(c["old"], d):
            io.db_log_update(c["old_key"], c["new_key"], _db_row(c["old"], c["old_key"]), _db_row(c["new"], c["new_key"]))
            d.update(_db_row(c["new"], c["new_key"]))
            _journal(journal, op="db_log_update", row=c["row"], db_id=c["db_id"], old_key=c["old_key"], new_key=c["new_key"])
        else:
            raise SystemExit("DB log row %s is in neither the old nor the new state; stop" % c["db_id"])
        if c["old"] != c["new"]:
            curv = io.sheet_row_values("Log", c["row"], ncols)[:4]
            if curv == c["old"]:
                io.sheet_write("Log", c["row"], 0, c["new"])
                _journal(journal, op="sheet_log_row", row=c["row"])
            elif curv != c["new"]:
                raise SystemExit("Log row %d changed under us (%s); stop" % (c["row"], curv))
    for a in p["log_appends"]:
        _take_lock(io)
        d = next((r for r in dbid.values() if r.get("sheet_key") == a["new_key"]), None)
        if d is not None and not _same_content(a["new"], d):
            raise SystemExit("key %s is taken by DB row %s; stop" % (a["new_key"], d["id"]))
        if d is None:
            r = _db_row(a["new"], a["new_key"]); r["source"] = REPAIR_SOURCE_NEW
            io.db_log_insert(r)
            _journal(journal, op="db_log_insert", pid=a["pid"], key=a["new_key"])
        curv = io.sheet_row_values("Log", a["row"], ncols)[:4]
        if curv == ["", "", "", ""]:
            io.sheet_write("Log", a["row"], 0, a["new"])
            _journal(journal, op="sheet_log_append", row=a["row"], pid=a["pid"])
        elif curv != a["new"]:
            raise SystemExit("Log row %d is not empty (%s); stop" % (a["row"], curv))
    ph = [h.lower() for h in sh["People"][0]]
    col_acc, col_id = ph.index("accepted"), ph.index("id")
    for x in p["people"]:
        if "row" not in x:
            continue
        _take_lock(io)
        if x["db_new"]:
            io.db_people_set(x["pid"], x["db_new"])
            _journal(journal, op="db_people_accepted", pid=x["pid"])
        if x["sheet_new"]:
            row = io.sheet_row_values("People", x["row"], max(col_acc, col_id) + 1)
            if row[col_id].strip() != x["pid"]:
                raise SystemExit("People row %d is no longer %s; stop" % (x["row"], x["pid"]))
            if row[col_acc].strip() == x["sheet_old"]:
                io.sheet_write("People", x["row"], col_acc, [x["sheet_new"]])
                _journal(journal, op="sheet_people_accepted", pid=x["pid"], row=x["row"])
            elif row[col_acc].strip() != x["sheet_new"]:
                raise SystemExit("People %s accepted changed under us; stop" % x["pid"])


def rollback_plan(io, p, sh, journal):
    """Reverse of apply_plan from the snapshot's plan, newest first; each step only fires when the current value is the
    repaired one, so it is safe after a partial run and safe to rerun."""
    log_hdr = sh["Log"][0]; ncols = len(log_hdr)
    ph = [h.lower() for h in sh["People"][0]]
    col_acc = ph.index("accepted")
    dbp = io.db_people()
    for x in reversed([x for x in p["people"] if "row" in x]):
        _take_lock(io)
        if x["sheet_new"] and io.sheet_row_values("People", x["row"], col_acc + 1)[col_acc].strip() == x["sheet_new"]:
            io.sheet_write("People", x["row"], col_acc, [x["sheet_old"]])
            _journal(journal, op="undo_sheet_people_accepted", pid=x["pid"])
        if x["db_new"]:
            cur = (dbp.get(x["pid"]) or {}).get("accepted")
            if cur and _minute(cur) == _minute(x["db_new"]):
                io.db_people_set(x["pid"], x["db_old"])
                _journal(journal, op="undo_db_people_accepted", pid=x["pid"])
    allrows = io.db_log()
    dbl = {r["sheet_key"]: r for r in allrows if r.get("sheet_key")}
    dbl_id = {r["id"]: r for r in allrows}
    for a in reversed(p["log_appends"]):
        _take_lock(io)
        if io.sheet_row_values("Log", a["row"], ncols)[:4] == a["new"]:
            io.sheet_write("Log", a["row"], 0, ["", "", "", ""])
            _journal(journal, op="undo_sheet_log_append", row=a["row"])
        d = dbl.get(a["new_key"])
        if d is not None and d.get("source") == REPAIR_SOURCE_NEW and _same_content(a["new"], d):
            io.db_log_unappend(a["new_key"])
            _journal(journal, op="undo_db_log_insert", key=a["new_key"])
    for c in reversed(p["log_changes"]):
        _take_lock(io)
        if c["old"] != c["new"] and io.sheet_row_values("Log", c["row"], ncols)[:4] == c["new"]:
            io.sheet_write("Log", c["row"], 0, c["old"])
            _journal(journal, op="undo_sheet_log_row", row=c["row"])
        d = dbl_id.get(c["db_id"])          # by id: identical rows can share content, the id is the only safe handle
        if d is not None and d.get("sheet_key") == c["new_key"] and _same_content(c["new"], d) and \
           (c["old"] != c["new"] or c["old_key"] != c["new_key"]):
            io.db_log_update(c["new_key"], c["old_key"], _db_row(c["new"], c["new_key"]), _db_row(c["old"], c["old_key"]))
            _journal(journal, op="undo_db_log_update", row=c["row"])


def postcheck(io, sh_before_counts=None):
    sh = io.read_sheet(["People", "Log"])
    cur = _log4(*sh["Log"])
    sk = set(_keys(cur).values())
    dbl = io.db_log()
    dk = {r["sheet_key"] for r in dbl if r.get("sheet_key")}
    sfs = _sheet_for_sync(sh)
    sync_log = io.sync_dry_log(sfs)
    return {"sheet_log_rows": len(sk), "db_log_rows_with_key": len(dk),
            "db_log_rows_without_key": sum(1 for r in dbl if not r.get("sheet_key")),
            "keys_match": sk == dk, "sheet_only_keys": len(sk - dk), "db_only_keys": len(dk - sk),
            "sync_dry_run_log": sync_log, "ok": sk == dk and sync_log.get("insert") == 0}


def _print_plan(p):
    """Per-row planned changes. P-ids and keys only: the detail column (it can hold names) is shown as unchanged/new text."""
    out = {"counts": p["counts"], "blockers": p["blockers"], "log_changes": [], "log_appends": [], "people": []}
    for c in p["log_changes"]:
        out["log_changes"].append({"row": c["row"], "kind": c["kind"], "faults": c["faults"],
                                   "old": {"ts": c["old"][0], "person_id": c["old"][1], "event": c["old"][2]},
                                   "new": {"ts": c["new"][0], "person_id": c["new"][1], "event": c["new"][2]},
                                   "detail": "unchanged" if c["old"][3] == c["new"][3] else "changed",
                                   "db_id": c["db_id"], "old_key": c["old_key"], "new_key": c["new_key"],
                                   "db_already_done": c["db_done"]})
    for a in p["log_appends"]:
        out["log_appends"].append({"row": a["row"], "ts": a["new"][0], "person_id": a["pid"], "event": "Accepted",
                                   "detail": a["new"][3], "source": REPAIR_SOURCE_NEW, "new_key": a["new_key"],
                                   "db_already_done": a["db_done"]})
    for x in p["people"]:
        out["people"].append({k: v for k, v in x.items() if k != "msg"})
    return out


def cmd_repair_log(a, io=None):
    opt = lambda k, d=None: a[a.index(k) + 1] if k in a and a.index(k) + 1 < len(a) else d
    io = io or LiveRepairIO()
    since = int(float(opt("--since", REPAIR_SINCE_DEFAULT)))
    out_path = opt("--out")
    if "--rollback" in a:
        bdir = opt("--rollback")
        pre = _preflight(io)
        if pre:
            print(json.dumps({"refused": pre}, indent=1)); return 2
        snap = json.load(open(os.path.join(bdir, "snapshot.json")))
        _take_lock(io)
        try:
            rollback_plan(io, snap["plan"], snap["sheet"], os.path.join(bdir, "journal.jsonl"))
            pc = postcheck(io)
            with open(os.path.join(bdir, "finished.json"), "w") as f:
                json.dump({"at": dt.datetime.now(dt.timezone.utc).isoformat(), "rolled_back": True, "postcheck": pc}, f)
        finally:
            io.state_put("lock", {"at": EPOCH_LOCK})
        print(json.dumps({"rolled_back_from": bdir, "postcheck": pc}, indent=1))
        return 0 if pc["ok"] else 1
    sh, acc, dbl, dbp = _gather(io, since)
    p = _plan_from(sh, acc, dbl, dbp)
    rep = {"mode": "execute" if "--execute" in a else "dry-run",
           "window_ist": [ist(since).strftime("%Y-%m-%d %H:%M"), dt.datetime.now(IST).strftime("%Y-%m-%d %H:%M")],
           "accept_emails_matched": len(acc), "plan": _print_plan(p)}
    if "--execute" not in a:
        rep["preflight_if_executed_now"] = _preflight(io)
        rep["writes"] = "none (dry run)"
        _emit(rep, out_path); return 0
    root = os.environ.get("ARI_REPAIR_BACKUP_ROOT") or os.path.join(os.path.dirname(HERE), "work", "backups")
    unfinished = sorted(d for d in (os.listdir(root) if os.path.isdir(root) else []) if d.startswith("log_repair_")
                        and os.path.exists(os.path.join(root, d, "snapshot.json"))
                        and not os.path.exists(os.path.join(root, d, "finished.json")))
    if unfinished:                              # a previous --execute stopped halfway: finish ITS plan, by DB id
        bdir = os.path.join(root, unfinished[-1])
        snap = json.load(open(os.path.join(bdir, "snapshot.json")))
        pre = _preflight(io)
        if pre:
            rep["refused"] = pre; rep["unfinished_run"] = bdir
            _emit(rep, out_path); return 2
        rep["resumed"] = bdir
        return _run(io, rep, snap["plan"], snap["sheet"], bdir, since, out_path)
    pre = _preflight(io) + p["blockers"]
    if pre:
        rep["refused"] = pre
        _emit(rep, out_path); return 2
    if plan_is_empty(p):
        rep["writes"] = "none: nothing to repair (already done)"
        rep["postcheck"] = postcheck(io)
        _emit(rep, out_path); return 0
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    bdir = os.path.join(root, "log_repair_" + stamp)
    os.makedirs(bdir, exist_ok=True)
    _take_lock(io)
    with open(os.path.join(bdir, "snapshot.json"), "w") as f:
        json.dump({"taken_at": stamp, "sheet": sh, "db_log_entries": dbl, "db_people": dbp,
                   "accepts": acc, "plan": p}, f)
    return _run(io, rep, p, sh, bdir, since, out_path)


def _run(io, rep, p, sh, bdir, since, out_path):
    _take_lock(io)
    try:
        apply_plan(io, p, sh, os.path.join(bdir, "journal.jsonl"), sh["Log"][0])
        pc = postcheck(io)
        sh2, acc2, dbl2, dbp2 = _gather(io, since)
        again = _plan_from(sh2, acc2, dbl2, dbp2)
        pc["rerun_plan_empty"] = plan_is_empty(again)
        pc["ok"] = pc["ok"] and pc["rerun_plan_empty"] and pc["sheet_log_rows"] == p["counts"]["expected_rows_after"]
    finally:
        io.state_put("lock", {"at": EPOCH_LOCK})
    rep["backup"] = bdir
    rep["postcheck"] = pc
    if pc["ok"]:
        with open(os.path.join(bdir, "finished.json"), "w") as f:
            json.dump({"at": dt.datetime.now(dt.timezone.utc).isoformat(), "postcheck": pc}, f)
    rep["next"] = ("resume tasks 56e17ef1 and e8fbd86f" if pc["ok"] else
                   "KEEP THE SYNC PAUSED; rerun --execute (finishes a partial run) or --rollback " + bdir)
    _emit(rep, out_path)
    return 0 if pc["ok"] else 1


def _emit(rep, out_path):
    s = json.dumps(rep, indent=1, default=str)
    print(s)
    if out_path:
        with open(out_path, "w") as f:
            f.write(s + "\n")


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
