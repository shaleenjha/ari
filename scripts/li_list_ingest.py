#!/usr/bin/env python3
# Kyte LinkedIn list ingest (Owner, Oct 26 2026): a scheduled READ-ONLY browser pass reads Owner's own LinkedIn lists and this
# script records them. Connections (daily, weekdays) -> accepts; Sent invitations (weekly) -> connect_sent.
# usage (project folder; shell credentials [{"provider":"google","email":"owner@example.com"}]):
#   python3 scripts/li_list_ingest.py since connections|sent     prints the stop date (yyyy-MM-dd) for the browser pass
#   python3 scripts/li_list_ingest.py apply connections|sent <file.json> [--dry]
#       file = [{"name":..., "headline":..., "url":"https://www.linkedin.com/in/x/", "date":"yyyy-MM-dd"}]
# Match: LinkedIn vanity, then unique normalised name. Never deletes. Then run sync_sheet_supabase.py.
import sys, os, json, re, subprocess, datetime as dt
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from accept_ingest import norm, vanity_of
S = "SHEET_ID_PLACEHOLDER"
DETAIL = "linkedin list"


def gws(*a, j=None):
    cmd = ["gws", *a] + (["--json", json.dumps(j)] if j is not None else [])
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if p.returncode: raise SystemExit("gws failed: " + (p.stderr or p.stdout)[-300:])
    return json.loads(p.stdout)


def get(rng):
    return gws("sheets", "spreadsheets", "values", "get", "--params", json.dumps({"spreadsheetId": S, "range": rng})).get("values", [])


def colname(i):
    s = ""; i += 1
    while i: i, r = divmod(i - 1, 26); s = chr(65 + r) + s
    return s


def since(mode):
    ev = "Accepted" if mode == "connections" else "Connect sent"
    dates = [r[0][:10] for r in get("Log!A:D") if len(r) > 3 and r[2] == ev and r[3] == DETAIL]
    today = dt.date.today()
    if dates: d = dt.date.fromisoformat(max(dates)) - dt.timedelta(days=1)
    else: d = today - dt.timedelta(days=14 if mode == "connections" else 7)
    print(d.isoformat())


def apply(mode, path, dry):
    items = json.load(open(path))
    rows = get("People!A:AZ"); hdr = rows[0]; H = {h: i for i, h in enumerate(hdr)}
    need = ["id", "name", "linkedin_url", "stage", "connect_sent", "accepted", "next_action", "notes", "source", "review", "research", "why", "title", "company"]
    miss = [c for c in need if c not in H]
    if miss: raise SystemExit("People header missing: %s" % miss)
    cell = lambda r, c: r[H[c]] if len(r) > H[c] else ""
    byv, byn = {}, {}
    for i, r in enumerate(rows[1:], start=2):
        if not r or not r[0]: continue
        if cell(r, "linkedin_url"): byv[vanity_of(cell(r, "linkedin_url"))] = (i, r)
        byn.setdefault(norm(cell(r, "name")), []).append((i, r))
    upd, new, logs, out = [], [], [], {"matched": [], "updated": [], "new": []}
    last = max(int(r[0][1:]) for r in rows[1:] if r and re.fullmatch(r"P\d+", r[0]))
    setc = lambda i, c, v: upd.append({"range": "People!%s%d" % (colname(H[c]), i), "values": [[v]]})
    for it in items:
        hit = byv.get(vanity_of(it.get("url") or "")) if it.get("url") else None
        if not hit:
            h = byn.get(norm(it["name"]), []); hit = h[0] if len(h) == 1 else None
        d = it["date"]
        if hit:
            i, r = hit; pid = r[0]; out["matched"].append(pid); changed = False
            if mode == "connections" and not cell(r, "accepted"):
                setc(i, "accepted", d); changed = True
                if cell(r, "stage") in ("", "Connect queued", "Connect sent"): setc(i, "stage", "Accepted")
                if not cell(r, "connect_sent"): setc(i, "connect_sent", d)
                if cell(r, "review") in ("", "lead") and cell(r, "stage") not in ("Hold", "Founder"):
                    setc(i, "next_action", "Send DM1")
                    if not cell(r, "research") or cell(r, "research") in ("Researching now",): setc(i, "research", "Researching")
                logs.append([d, pid, "Accepted", DETAIL])
            if mode == "sent" and not cell(r, "connect_sent"):
                setc(i, "connect_sent", d); changed = True
                if cell(r, "stage") in ("", "Connect queued"): setc(i, "stage", "Connect sent")
                logs.append([d, pid, "Connect sent", DETAIL])
            if changed: out["updated"].append(pid)
            continue
        last += 1; pid = "P%03d" % last; r = [""] * len(hdr)
        m = re.search(r"(?:@| at )\s*([A-Z][\w&.\- ]{1,40}?)(?:\s*[|•,(]|$)", it.get("headline") or "")
        vals = {"id": pid, "company": m.group(1).strip() if m else "", "name": it["name"], "title": (it.get("headline") or "")[:120],
                "linkedin_url": it.get("url") or "", "connect_sent": d, "review": "pending",
                "source": "LinkedIn %s list (Hark read)" % mode, "next_action": "Pick Lead or Personal",
                "why": "Review pending: on Owner's LinkedIn %s list, not in Ari before. Pick Lead or Personal." % mode}
        if mode == "connections": vals.update(stage="Accepted", accepted=d)
        else: vals.update(stage="Connect sent")
        for k, v in vals.items(): r[H[k]] = v
        new.append(r); out["new"].append(pid)
        logs.append([d, pid, "Accepted" if mode == "connections" else "Connect sent", DETAIL])
    if not dry:
        if upd: gws("sheets", "spreadsheets", "values", "batchUpdate", "--params", json.dumps({"spreadsheetId": S}), j={"valueInputOption": "RAW", "data": upd})
        for rng, vals in (("People!A:A", new), ("Log!A:D", logs)):
            if vals: gws("sheets", "spreadsheets", "values", "append", "--params", json.dumps({"spreadsheetId": S, "range": rng, "valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"}), j={"values": vals})
    print(json.dumps({"mode": mode, "read": len(items), "already": len(out["matched"]) - len(out["updated"]),
                      "updated": out["updated"], "new": out["new"], "dry": dry}))


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == "since" and a[1] in ("connections", "sent"): since(a[1])
    elif len(a) >= 3 and a[0] == "apply" and a[1] in ("connections", "sent"): apply(a[1], a[2], "--dry" in a)
    else: print(__doc__ or "see header"); sys.exit(2)
