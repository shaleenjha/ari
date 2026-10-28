#!/usr/bin/env python3
"""Ari v17: two-way sync between the Google Sheet "Outbound HQ" and Supabase project "ari".

Supabase is canonical; the Sheet is the mirror during the transition.
  * Rows/fields written by the app (Supabase) are copied to the Sheet.
  * Rows/fields edited in the Sheet (Hark's hourly worker, Apps Script, Owner by hand) are copied to Supabase.
  * A field changed on both sides since the last run: Supabase wins (and the Sheet is overwritten).
Change detection is per field against a base snapshot (the agreed values after the previous run), kept in
public.sync_state. Re-running with nothing changed writes nothing, so it is safe every 10 minutes.

Heartbeat (v17.1.2): every real run writes public.scan_heartbeat (running at start; last_scan_at, next_scan_at,
changes at the end) for the app header hourglass. Best effort: never fails the sync.

Tabs: People, Accounts, Queue, Emails, Brief (two-way, per field); Log (two-way, append-only, deduped by a
row hash); Book (Sheet -> Supabase only, worker-owned).

Run (Hark sandbox; one command: the gws Google credentials and the Supabase ari_worker binding (v18.5, least privilege) are both injected by the proxy):
    shell(command="python3 scripts/sync_sheet_supabase.py", credentials=[{provider: google, email: owner@example.com}])
Flags: --dry-run (plan only, no writes), --backfill (first load: writes are tagged 'backfill', so no pushes fire),
       --tabs People,Log (subset), --verify (print row counts on both sides and exit).
Outside Hark / tests: set ARI_SB_URL, ARI_SB_APIKEY and ARI_SB_JWT_FILE (an ari_worker JWT) and have `gws` authenticated.
Database rights: role ari_worker only (native/supabase/migrations/0018_least_privilege_worker.sql); no service_role, no raw SQL.
"""
import argparse, datetime as dt, hashlib, json, os, re, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ari_token  # S1 R7 (off unless ARI_WORKER_BROKER=1)

SHEET_ID = "SHEET_ID_PLACEHOLDER"
SB_URL = os.environ.get("ARI_SB_URL") or "https://rbkrqlzlblquvgmuohro.supabase.co"
# Public publishable key (safe to ship). In Hark the proxy binding "supabase-ari-bearer" injects
# "Authorization: Bearer <ari_worker JWT>" (v18.5); the gateway also needs an apikey, so we send the publishable one.
SB_PUBLISHABLE = os.environ.get("ARI_SB_APIKEY") or "sb_publishable_jC4J7_kj6zUiAB6_zs6_NQ_6D1gMVxl"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
LOCK_MINUTES = 8

# ---------- table config ----------
PEOPLE_TS = ["connect_sent", "accepted", "dm1_sent", "dm2_sent", "dm3_sent", "replied", "meeting", "withdrawn"]
CFG = {
    "People": dict(table="people", key="id", colmap={"why": "why_this_person"}, ts=PEOPLE_TS,
                   dates=["connect_day", "dm2_due", "dm3_due", "snooze_until", "skipped"], tsmin=[],
                   lower=["review"], mirror_db_only=["dm2_text", "dm3_text", "play", "context"], account_fk=True,
                   system_keep=["context"]),
    "Accounts": dict(table="accounts", key="company", colmap={}, ts=[], dates=["hook_date"], tsmin=[],
                     lower=[], mirror_db_only=["play", "domain", "stage", "stage_source", "stage_reason"], ci_key=True),
    "Queue": dict(table="queue", key="id", colmap={}, ts=[], dates=[], tsmin=["created"], lower=[], mirror_db_only=[]),
    "Emails": dict(table="emails", key="id", colmap={}, ts=[], dates=[], tsmin=["created"], lower=[], mirror_db_only=[]),
    "Brief": dict(table="brief", key="key", colmap={}, ts=[], dates=[], tsmin=[], lower=[], mirror_db_only=[]),
}
TWO_WAY = ["Accounts", "People", "Queue", "Emails", "Brief"]
SYSTEM_COLS = {"created_at", "updated_at", "updated_by", "field_ts", "extra", "sheet_row", "deleted_at",
               "account_id", "stage_changed_at", "ae", "lane", "flags", "context"}

def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)

# ---------- value conversion ----------
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
DTM_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})(?::\d{2})?$")

def parse_ts(s):
    """Sheet text -> ISO timestamptz (IST). Dates become noon IST so any +/-6h shift-day logic keeps the date."""
    s = s.strip()
    if DATE_RE.match(s):
        return s + "T12:00:00+05:30"
    m = DTM_RE.match(s)
    if m:
        return "%sT%02d:%s:00+05:30" % (m.group(1), int(m.group(2)), m.group(3))
    return None

def ts_to_ist(v):
    t = dt.datetime.fromisoformat(str(v).replace("Z", "+00:00"))
    if t.tzinfo is None:
        t = t.replace(tzinfo=dt.timezone.utc)
    return t.astimezone(IST)

def to_db(cfg, col, s):
    """Sheet string -> (db value, raw-or-None). raw is kept in extra._raw when the text does not parse."""
    if s == "":
        return None, None
    if col in cfg["ts"]:
        v = parse_ts(s)
        return (v, None) if v else (None, s)
    if col in cfg["tsmin"]:
        v = parse_ts(s)
        return (v, None) if v else (None, s)
    if col in cfg["dates"]:
        return (s.strip(), None) if DATE_RE.match(s.strip()) else (None, s)
    if col in cfg["lower"]:
        v = s.strip().lower()
        return (v, None) if v in ("lead", "pending", "personal") else (None, s)
    return s, None

def render(cfg, col, row):
    """DB row value -> the string the Sheet should show."""
    if row is None:
        return ""
    extra = row.get("extra") or {}
    if col not in row:  # Sheet column not modelled: lives in extra
        v = extra.get(col)
        return "" if v is None else str(v)
    v = row.get(col)
    if v is None:
        raw = (extra.get("_raw") or {}).get(col)
        return raw if raw is not None else ""
    if col in cfg["ts"]:
        return ts_to_ist(v).strftime("%Y-%m-%d")
    if col in cfg["tsmin"]:
        return ts_to_ist(v).strftime("%Y-%m-%d %H:%M")
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, (list, dict)):
        return json.dumps(v)
    return str(v)

def sysc(cfg):
    return SYSTEM_COLS - set(cfg.get("system_keep", []))

def canon(cfg, c, dc, text, db_cols):
    """Sheet text -> the string render() would produce for it after a round trip through the DB."""
    if text in (None, "") or dc not in db_cols or dc in sysc(cfg):
        return text
    val, raw = to_db(cfg, c, text)
    if val is None:
        return text
    return render(cfg, dc, {dc: val})

def keynorm(cfg, k):
    k = (k or "").strip()
    return k.lower() if cfg.get("ci_key") else k

# ---------- Google Sheets via gws ----------
# Hark's sandbox can inject either the Google credentials or the Supabase key binding into one shell command,
# not both. So a scheduled run is 3 commands: --dump-sheet F (Google creds), then the sync with --sheet-cache F
# (Supabase binding; Sheet writes are queued to F.pending.json), then --apply-pending F (Google creds).
CACHE = {"path": None, "pending": None}
WRITE_VERBS = {"batchUpdate", "update", "append"}

def gws(args, body=None):
    if CACHE["path"] and any(a in WRITE_VERBS for a in args[:4]):
        CACHE["pending"].append({"args": args, "body": body})
        with open(CACHE["path"] + ".pending.json", "w") as f:
            json.dump(CACHE["pending"], f)
        return {}
    cmd = ["gws"] + args
    if body is not None:
        cmd += ["--json", json.dumps(body)]
    for attempt in range(3):
        p = subprocess.run(cmd, capture_output=True, text=True)
        if p.returncode == 0:
            out = p.stdout.strip()
            return json.loads(out) if out else {}
        err = (p.stderr or p.stdout)[-500:]
        if attempt < 2 and re.search(r"429|500|502|503|quota|timed out", err, re.I):
            time.sleep(3 * (attempt + 1)); continue
        raise RuntimeError("gws failed: %s" % err)

def sheet_read(tabs):
    if CACHE["path"]:
        d = json.load(open(CACHE["path"]))["sheet"]
        return {t: (d[t][0], [tuple(x) for x in d[t][1]]) for t in tabs}
    params = {"spreadsheetId": SHEET_ID, "ranges": tabs, "valueRenderOption": "FORMATTED_VALUE"}
    d = gws(["sheets", "spreadsheets", "values", "batchGet", "--params", json.dumps(params)])
    out = {}
    for tab, vr in zip(tabs, d.get("valueRanges", [])):
        vals = vr.get("values", [])
        header = [str(h) for h in vals[0]] if vals else []
        rows = []
        for i, r in enumerate(vals[1:]):
            r = [str(x) for x in r] + [""] * max(0, len(header) - len(r))
            rows.append((i + 2, r[:len(header)]))
        out[tab] = (header, rows)
    return out

def sheet_grid():
    if CACHE["path"]:
        return json.load(open(CACHE["path"]))["grid"]
    d = gws(["sheets", "spreadsheets", "get", "--params", json.dumps(
        {"spreadsheetId": SHEET_ID, "fields": "sheets.properties(title,sheetId,gridProperties)"})])
    return {s["properties"]["title"]: s["properties"] for s in d["sheets"]}

def col_letter(n):  # 1-based
    s = ""
    while n:
        n, r = divmod(n - 1, 26); s = chr(65 + r) + s
    return s

def sheet_add_headers(tab, header, new_cols, grid):
    props = grid[tab]; have = props["gridProperties"].get("columnCount", 26); need = len(header) + len(new_cols)
    if need > have:
        gws(["sheets", "spreadsheets", "batchUpdate", "--params", json.dumps({"spreadsheetId": SHEET_ID})],
            {"requests": [{"appendDimension": {"sheetId": props["sheetId"], "dimension": "COLUMNS", "length": need - have}}]})
        props["gridProperties"]["columnCount"] = need
    rng = "'%s'!%s1:%s1" % (tab, col_letter(len(header) + 1), col_letter(need))
    gws(["sheets", "spreadsheets", "values", "update", "--params", json.dumps(
        {"spreadsheetId": SHEET_ID, "range": rng, "valueInputOption": "RAW"})], {"values": [new_cols]})
    return header + new_cols

def sheet_update_cells(tab, cells):
    """cells: [(rownum, colidx0, value)]; RAW so dates stay text like Apps Script writes them."""
    for i in range(0, len(cells), 400):
        data = [{"range": "'%s'!%s%d" % (tab, col_letter(c + 1), r), "values": [[v]]} for r, c, v in cells[i:i + 400]]
        gws(["sheets", "spreadsheets", "values", "batchUpdate", "--params", json.dumps({"spreadsheetId": SHEET_ID})],
            {"valueInputOption": "RAW", "data": data})

def sheet_append(tab, rows):
    for i in range(0, len(rows), 200):
        gws(["sheets", "spreadsheets", "values", "append", "--params", json.dumps(
            {"spreadsheetId": SHEET_ID, "range": "'%s'!A1" % tab, "valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"})],
            {"values": rows[i:i + 200]})

# ---------- Supabase REST ----------
def sb(method, path, body=None, actor="sheet", prefer=None, rng=None):
    url = SB_URL + "/rest/v1/" + path
    h = {"Content-Type": "application/json", "x-ari-actor": actor}
    h["apikey"] = SB_PUBLISHABLE
    jf = os.environ.get("ARI_SB_JWT_FILE")
    if ari_token.enabled():  # S1 R7: broker token (off by default); 401 re-fetch below
        h.update(ari_token.auth_header())
    elif jf:  # tests / outside Hark; in Hark the proxy injects the ari_worker bearer
        h["Authorization"] = "Bearer " + open(jf).read().strip()
    if prefer:
        h["Prefer"] = prefer
    if rng:
        h["Range-Unit"] = "items"; h["Range"] = rng
    data = json.dumps(body).encode() if body is not None else None
    refetched = False
    for attempt in range(4 if ari_token.enabled() else 3):  # +1 slot only for the one 401 re-fetch
        req = urllib.request.Request(url, data=data, method=method, headers=h)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                t = r.read().decode()
                return json.loads(t) if t else None
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:600]
            if e.code == 401 and ari_token.enabled() and not refetched:  # S1 R7: one fresh token, one retry
                refetched = True
                h.update(ari_token.auth_header(force=True))
                continue
            if e.code >= 500 and attempt < 2:
                time.sleep(2 * (attempt + 1)); continue
            raise RuntimeError("supabase %s %s -> %s %s" % (method, path, e.code, msg))
        except urllib.error.URLError:
            if attempt < 2:
                time.sleep(2 * (attempt + 1)); continue
            raise

def sb_all(table, select="*"):
    out, off = [], 0
    while True:
        page = sb("GET", "%s?select=%s&order=%s&limit=1000&offset=%d" % (table, select, "key" if table in ("brief", "book") else ("id" if table != "accounts" else "company"), off))
        out += page
        if len(page) < 1000:
            return out
        off += 1000

_COLS = {}
def sb_columns(table):
    # v18.5: the column catalogue comes from rpc ari_worker_columns (information_schema as role ari_worker), not hark_query.
    if not _COLS:
        rows = sb("POST", "rpc/ari_worker_columns", {})
        for r in rows:
            _COLS.setdefault(r["table_name"], []).append(r["column_name"])
    return _COLS[table]

def state_get(key):
    r = sb("GET", "sync_state?key=eq.%s&select=value" % urllib.parse.quote(key))
    return r[0]["value"] if r else None

# ---------- scan heartbeat (v17.1.2): the app's hourglass reads public.scan_heartbeat over realtime ----------
HB_ANCHOR = dt.datetime(2026, 10, 16, 3, 3, tzinfo=dt.timezone.utc)  # a slot of task 56e17ef1's 10-minute grid (:x3)
HB_INTERVAL = 600

def hb_next(now):
    k = int((now - HB_ANCHOR).total_seconds() // HB_INTERVAL) + 1
    return HB_ANCHOR + dt.timedelta(seconds=k * HB_INTERVAL)

def hb_write(row):
    """Best effort: a heartbeat problem never breaks the sync."""
    try:
        row = dict(row, id=1, updated_at=dt.datetime.now(dt.timezone.utc).isoformat())
        sb("POST", "scan_heartbeat?on_conflict=id", [row], actor="hark", prefer="resolution=merge-duplicates,return=minimal")
    except Exception as e:
        log("heartbeat skipped:", str(e)[:200])

def state_put(key, value):
    sb("POST", "sync_state?on_conflict=key", [{"key": key, "value": value, "updated_at": dt.datetime.now(dt.timezone.utc).isoformat()}],
       prefer="resolution=merge-duplicates,return=minimal")

# ---------- planning (pure; unit-tested in work/v17/test_sync_plan.py) ----------
def plan_table(cfg, header, sheet_rows, db_rows, base, db_cols):
    """Returns dict(db_patch={key: {dbcol: val}}, db_insert=[row], sheet_cells=[(rownum, colidx, str)],
    sheet_append=[keys], add_headers=[col], new_base={key: {sheetcol: str}}, conflicts=[...])."""
    colmap = cfg["colmap"]
    dbcol = lambda c: colmap.get(c, c)
    db_by = {keynorm(cfg, r.get(cfg["key"])): r for r in db_rows if r.get(cfg["key"])}
    sh_by = {}
    for rownum, vals in sheet_rows:
        rec = dict(zip(header, vals))
        k = keynorm(cfg, rec.get(cfg["key"] if cfg["key"] != "company" else "company", ""))
        if k and k not in sh_by:
            sh_by[k] = (rownum, rec)
    # DB-only mirrored columns that have a value somewhere and no Sheet header yet
    add_headers = [c for c in cfg["mirror_db_only"] if c not in header and c in db_cols
                   and any(r.get(c) not in (None, "") for r in db_rows)]
    cols = header + add_headers
    plan = dict(db_patch={}, db_insert=[], sheet_cells=[], sheet_append=[], add_headers=add_headers, new_base={}, conflicts=[])
    for k in sorted(set(db_by) | set(sh_by)):
        d = db_by.get(k); s = sh_by.get(k); b = (base or {}).get(k)
        if s and not d:  # new in Sheet -> insert into DB
            rownum, rec = s
            row, raw, extra = {}, {}, {}
            for c in header:
                v = rec.get(c, "")
                if c == "" or v == "":
                    continue
                dc = dbcol(c)
                if dc in db_cols and dc not in sysc(cfg):
                    val, r = to_db(cfg, c, v)
                    if r is not None: raw[dc] = r
                    if val is not None: row[dc] = val
                else:
                    extra[c] = v
            if raw: extra["_raw"] = raw
            if extra and "extra" in db_cols: row["extra"] = extra
            if "sheet_row" in db_cols: row["sheet_row"] = rownum
            plan["db_insert"].append(row)
            plan["new_base"][k] = {c: rec.get(c, "") for c in header if c}
            continue
        if d and not s:
            if b is not None:
                plan["conflicts"].append("%s: in base and DB but gone from Sheet (left as is)" % k)
                plan["new_base"][k] = b
            elif not d.get("deleted_at"):
                plan["sheet_append"].append(k)  # new in DB -> append to Sheet
                plan["new_base"][k] = {c: render(cfg, dbcol(c), d) for c in cols if c}
            continue
        rownum, rec = s
        patch, extra_patch, raw_patch, nb = {}, {}, {}, {}
        for ci, c in enumerate(cols):
            if c == "":
                continue
            dc = dbcol(c)
            sv = rec.get(c, "") if c in header else ""
            dv = render(cfg, dc, d)
            bv = None if b is None else b.get(c)
            if sv == dv or canon(cfg, c, dc, sv, db_cols) == dv:
                nb[c] = sv; continue  # same value, maybe written differently ("2026-10-14" vs "2026-10-14 12:00")
            if bv is not None:
                bv = canon(cfg, c, dc, bv, db_cols); sv_c = canon(cfg, c, dc, sv, db_cols)
            else:
                sv_c = sv
            if b is None:
                sheet_wins = dv == ""       # no history: fill DB blanks from the Sheet, otherwise DB wins
            elif bv is None:
                sheet_wins = dv == "" and c in header
            else:
                s_changed, d_changed = sv_c != bv, dv != bv
                if s_changed and not d_changed:
                    sheet_wins = True
                elif d_changed and not s_changed:
                    sheet_wins = False
                else:
                    sheet_wins = False
                    plan["conflicts"].append("%s.%s: both changed, Supabase wins" % (k, c))
            if sheet_wins and c in header:
                if dc in db_cols and dc not in sysc(cfg):
                    val, r = to_db(cfg, c, sv)
                    patch[dc] = val
                    raw_patch[dc] = r
                else:
                    extra_patch[c] = sv if sv != "" else None
                nb[c] = sv
            else:
                plan["sheet_cells"].append((rownum, ci, dv))
                nb[c] = dv
        if extra_patch or any(v is not None for v in raw_patch.values()) or \
           any(v is None and ((d.get("extra") or {}).get("_raw") or {}).get(c) is not None for c, v in raw_patch.items()):
            ex = dict(d.get("extra") or {})
            for c, v in extra_patch.items():
                if v is None: ex.pop(c, None)
                else: ex[c] = v
            rw = dict(ex.get("_raw") or {})
            for c, v in raw_patch.items():
                if v is None: rw.pop(c, None)
                else: rw[c] = v
            if rw: ex["_raw"] = rw
            else: ex.pop("_raw", None)
            patch["extra"] = ex
        if "sheet_row" in db_cols and d.get("sheet_row") != rownum:
            patch["sheet_row"] = rownum
        if patch:
            plan["db_patch"][k] = patch
        plan["new_base"][k] = nb
    return plan

def log_key(vals, seen):
    h = hashlib.md5("\x1f".join(vals).encode()).hexdigest()[:20]
    seen[h] = seen.get(h, 0) + 1
    return "%s#%d" % (h, seen[h])

# ---------- runners ----------
def sync_two_way(tab, sheet, args, actor, grid):
    cfg = CFG[tab]; table = cfg["table"]
    header, rows = sheet[tab]
    db_cols = sb_columns(table)
    db_rows = sb_all(table)
    if tab == "Queue":  # 0046: 'AS:<pid>:<kind>' rows only hold a draft's assumptions list; DB-only, never mirrored to the Sheet
        db_rows = [r for r in db_rows if not str(r.get("id") or "").startswith("AS:")]
    base = state_get("base:" + tab)
    plan = plan_table(cfg, header, rows, db_rows, base, db_cols)
    n = dict(insert=len(plan["db_insert"]), patch=len(plan["db_patch"]), cells=len(plan["sheet_cells"]),
             append=len(plan["sheet_append"]), headers=plan["add_headers"], conflicts=len(plan["conflicts"]))
    log(tab, json.dumps(n))
    for c in plan["conflicts"][:10]:
        log("  conflict", c)
    if args.dry_run:
        return plan
    acc_ids = {}
    if cfg.get("account_fk"):
        acc_ids = {(a.get("company") or "").strip().lower(): a["id"] for a in sb_all("accounts", "id,company")}
    # plays referenced by the Sheet must exist (FK)
    plays = {r.get("play") for r in plan["db_insert"]} | {p.get("play") for p in plan["db_patch"].values()}
    plays.discard(None)
    if plays and "play" in db_cols:
        sb("POST", "plays?on_conflict=name", [{"name": p} for p in plays], actor=actor, prefer="resolution=ignore-duplicates,return=minimal")
    if plan["db_insert"]:
        for r in plan["db_insert"]:
            r["updated_by"] = actor
            if cfg.get("account_fk") and r.get("company"):
                r["account_id"] = acc_ids.get(r["company"].strip().lower())
        allk = set().union(*[r.keys() for r in plan["db_insert"]])
        batch = [{k2: r.get(k2) for k2 in allk} for r in plan["db_insert"]]
        for r in batch:  # keep defaults for missing structural columns
            for c in ("extra",):
                if r.get(c) is None and c in db_cols: r[c] = {}
        for i in range(0, len(batch), 200):
            sb("POST", table, batch[i:i + 200], actor=actor, prefer="return=minimal")
    keycol = cfg["key"]
    db_by = {keynorm(cfg, r.get(keycol)): r for r in db_rows}
    for k, patch in plan["db_patch"].items():
        if cfg.get("account_fk") and "company" in patch and patch["company"]:
            patch["account_id"] = acc_ids.get(patch["company"].strip().lower())
        real_key = db_by[k][keycol] if k in db_by else k
        if table == "accounts":
            q = "accounts?id=eq.%s" % db_by[k]["id"]
        else:
            q = "%s?%s=eq.%s" % (table, keycol, urllib.parse.quote(str(real_key), safe=""))
        sb("PATCH", q, patch, actor=actor, prefer="return=minimal")
    if plan["add_headers"]:
        header = sheet_add_headers(tab, header, plan["add_headers"], grid)
    if plan["sheet_cells"]:
        sheet_update_cells(tab, plan["sheet_cells"])
    if plan["sheet_append"]:
        cols = header if not plan["add_headers"] else header
        out = []
        for k in plan["sheet_append"]:
            d = db_by[k]
            out.append([render(cfg, cfg["colmap"].get(c, c), d) for c in cols])
        sheet_append(tab, out)
    state_put("base:" + tab, plan["new_base"])
    return plan

def sync_log(sheet, args, actor):
    header, rows = sheet["Log"]
    cols = ["ts", "person_id", "event", "detail"]
    idx = [header.index(c) if c in header else None for c in cols]
    seen, sheet_keys = {}, []
    for rownum, vals in rows:
        v = [vals[i] if i is not None and i < len(vals) else "" for i in idx]
        if not any(v):
            continue
        sheet_keys.append((log_key(v, seen), v))
    db = sb_all("log_entries", "id,ts,person_id,event,detail,source,sheet_key")
    have = {r["sheet_key"] for r in db if r.get("sheet_key")}
    ins = []
    for k, v in sheet_keys:
        if k in have:
            continue
        ins.append({"ts": parse_ts(v[0]) or dt.datetime.now(IST).isoformat(), "person_id": v[1] or None,
                    "event": v[2] or "(blank)", "detail": v[3] or None,
                    "source": "backfill" if actor == "backfill" else "sheet", "sheet_key": k})
    outgoing = [r for r in db if not r.get("sheet_key")]
    log("Log", json.dumps(dict(insert=len(ins), append=len(outgoing))))
    if args.dry_run:
        return len(ins) + len(outgoing)
    for i in range(0, len(ins), 300):
        sb("POST", "log_entries", ins[i:i + 300], actor=actor, prefer="return=minimal")
    if outgoing:
        outgoing.sort(key=lambda r: (r["ts"], r["id"]))
        vals = [[ts_to_ist(r["ts"]).strftime("%Y-%m-%d %H:%M"), r.get("person_id") or "", r["event"], r.get("detail") or ""] for r in outgoing]
        sheet_append("Log", vals)
        for r, v in zip(outgoing, vals):
            sb("PATCH", "log_entries?id=eq.%d" % r["id"], {"sheet_key": log_key(v, seen)}, actor=actor, prefer="return=minimal")
    return len(ins) + len(outgoing)

BOOK_PRUNE_MAX_ROWS = 20     # S1 R4: never delete more than 20 Book rows in one run
BOOK_PRUNE_MAX_SHARE = 0.05  # ...nor more than 5% of the Book (at least 1 row, so a tiny Book can still lose one)
ALERTS = []                  # set during a run; main() exits 3 after finishing if any is set, so the scheduled run surfaces it

def book_prune_limit(n_db):
    return min(BOOK_PRUNE_MAX_ROWS, max(1, int(n_db * BOOK_PRUNE_MAX_SHARE)))

def sync_book(sheet, args, actor):
    header, rows = sheet["Book"]
    seen, out = {}, []
    want = ["company", "owner", "tier", "flag", "cluster", "fit", "last_checked", "last_signal", "website"]
    for rownum, vals in rows:
        rec = dict(zip(header, vals))
        c = (rec.get("company") or "").strip()
        if not c:
            continue
        base = c.lower(); seen[base] = seen.get(base, 0) + 1
        r = {"key": "%s#%d" % (base, seen[base]), "sheet_row": rownum}
        for w in want:
            r[w] = rec.get(w) or None
        r["company"] = c
        out.append(r)
    db = {r["key"]: r for r in sb_all("book", "key,company,owner,tier,flag,cluster,fit,last_checked,last_signal,website,sheet_row")}
    changed = [r for r in out if any((db.get(r["key"]) or {}).get(k) != r[k] for k in r)]
    gone = [k for k in db if k not in {r["key"] for r in out}]
    log("Book", json.dumps(dict(upsert=len(changed), gone=len(gone))))
    limit = book_prune_limit(len(db))
    if len(gone) > limit:  # S1 R4 (audit D8): a cleared or half-read Book tab must never hard-delete the Book
        log("Book", "ALERT: %d of %d Book rows would be deleted (limit %d); deletes skipped, upserts still applied. "
                    "Check the Sheet's Book tab, then prune by hand." % (len(gone), len(db), limit))
        ALERTS.append("book_prune_refused: %d of %d rows" % (len(gone), len(db)))
        gone = []
    if args.dry_run:
        return len(changed) + len(gone)
    for i in range(0, len(changed), 500):
        sb("POST", "book?on_conflict=key", changed[i:i + 500], actor=actor, prefer="resolution=merge-duplicates,return=minimal")
    for i in range(0, len(gone), 100):
        keys = ",".join('"%s"' % k.replace('"', '') for k in gone[i:i + 100])
        sb("DELETE", "book?key=in.(%s)" % urllib.parse.quote(keys, safe=",()\""), actor=actor, prefer="return=minimal")
    return len(changed) + len(gone)

def verify(sheet):
    counts = {}
    for tab, table in [("People", "people"), ("Accounts", "accounts"), ("Queue", "queue"), ("Emails", "emails"),
                       ("Brief", "brief"), ("Log", "log_entries"), ("Book", "book")]:
        header, rows = sheet[tab]
        n_sheet = sum(1 for _, v in rows if any(x.strip() for x in v))
        if tab in CFG:
            ki = header.index(CFG[tab]["key"]) if CFG[tab]["key"] in header else 0
            n_sheet = len({keynorm(CFG[tab], v[ki]) for _, v in rows if v[ki].strip()})
        n_db = len(sb_all(table, "key" if table in ("brief", "book") else "id"))
        counts[tab] = {"sheet": n_sheet, "supabase": n_db, "match": n_sheet == n_db}
    return counts

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--backfill", action="store_true")
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--tabs", default="Accounts,People,Queue,Emails,Brief,Log,Book")
    ap.add_argument("--force", action="store_true", help="ignore a fresh lock")
    ap.add_argument("--dump-sheet", metavar="FILE", help="read the Sheet (Google creds) into FILE and exit")
    ap.add_argument("--sheet-cache", metavar="FILE", help="use FILE instead of reading the Sheet; queue Sheet writes")
    ap.add_argument("--apply-pending", metavar="FILE", help="replay FILE.pending.json Sheet writes (Google creds)")
    args = ap.parse_args()
    ALL_TABS = ["People", "Accounts", "Queue", "Emails", "Brief", "Log", "Book"]
    if args.dump_sheet:
        sh = sheet_read(ALL_TABS)
        json.dump({"sheet": sh, "grid": sheet_grid(), "at": dt.datetime.now(dt.timezone.utc).isoformat()}, open(args.dump_sheet, "w"))
        log("dumped", {t: len(sh[t][1]) for t in ALL_TABS}); return
    if args.apply_pending:
        pf = args.apply_pending + ".pending.json"
        ops = json.load(open(pf)) if os.path.exists(pf) else []
        for o in ops:
            gws(o["args"], o["body"])
        if ops:
            os.rename(pf, pf + ".done")
        log("applied", len(ops), "sheet writes"); return
    if args.sheet_cache:
        CACHE["path"] = args.sheet_cache; CACHE["pending"] = []
        pf = args.sheet_cache + ".pending.json"
        if os.path.exists(pf):
            raise SystemExit("pending Sheet writes from a previous run exist (%s); run --apply-pending first" % pf)
    tabs = [t.strip() for t in args.tabs.split(",") if t.strip()]
    actor = "backfill" if args.backfill else "sheet"
    sheet = sheet_read(["People", "Accounts", "Queue", "Emails", "Brief", "Log", "Book"])
    if args.verify:
        print(json.dumps(verify(sheet), indent=1)); return
    if not args.dry_run:
        lock = state_get("lock")
        now = dt.datetime.now(dt.timezone.utc)
        if lock and not args.force and now - dt.datetime.fromisoformat(lock["at"]) < dt.timedelta(minutes=LOCK_MINUTES):
            log("another sync holds the lock since", lock["at"], "- exiting"); return
        state_put("lock", {"at": now.isoformat(), "pid": os.getpid()})
        since_slot = (now - HB_ANCHOR).total_seconds() % HB_INTERVAL
        trigger = "scheduled" if since_slot < 240 else "worker"
        hb_write({"running": True, "last_started_at": now.isoformat(), "trigger": trigger,
                  "anchor_at": HB_ANCHOR.isoformat(), "interval_sec": HB_INTERVAL})
    counts = {"to_app": 0, "to_sheet": 0, "log": 0, "book": 0}
    ok = False
    grid = sheet_grid() if not args.dry_run else {}
    try:
        for tab in [t for t in TWO_WAY if t in tabs]:
            pl = sync_two_way(tab, sheet, args, actor, grid)
            counts["to_app"] += len(pl["db_insert"]) + len(pl["db_patch"])
            counts["to_sheet"] += len(pl["sheet_cells"]) + len(pl["sheet_append"])
        if "Log" in tabs:
            counts["log"] = sync_log(sheet, args, actor) or 0
        if "Book" in tabs:
            counts["book"] = sync_book(sheet, args, actor) or 0
        if not args.dry_run:
            try:  # v17.5: forward-only account stage catch-up (accounts Owner has not overridden); best effort
                moved = sb("POST", "rpc/ari_account_stage_reconcile", {}, actor="ari")
                if moved:
                    log("stages", "reconcile moved", moved)
            except Exception as e:
                log("stages", "reconcile skipped:", str(e)[:200])
            state_put("last_run", {"at": dt.datetime.now(dt.timezone.utc).isoformat(), "actor": actor, "tabs": tabs})
        ok = True
    finally:
        if not args.dry_run:
            state_put("lock", {"at": "1970-01-01T00:00:00+00:00"})
            end = dt.datetime.now(dt.timezone.utc)
            counts["seconds"] = round((end - now).total_seconds(), 1)
            if ok:
                hb_write({"running": False, "last_scan_at": end.isoformat(), "next_scan_at": hb_next(end).isoformat(), "changes": counts})
            else:
                hb_write({"running": False, "changes": dict(counts, error="sync failed")})

if __name__ == "__main__":
    main()
    if ALERTS:
        print("ALERT", "; ".join(ALERTS), flush=True)
        sys.exit(3)
