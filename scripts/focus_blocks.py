#!/usr/bin/env python3
"""Ari focus blocks (Owner, Oct 22 2026): a few calendar blocks a day instead of one invite per person.

Each shift day (IST date minus 6 h, the same day Ari's Today uses) gets up to three events on Owner's own
Google Calendar, no attendees:
  Ari · Replies     everyone who replied, with Ari's suggested answer
  Ari · Follow-ups  DM1, DM2, DM3 due and invites to withdraw, with the message to send
  Ari · Connects    connects due today, with the connect note when there is one
Each description has everything needed to work without the app: name, title, company, LinkedIn URL, the
message. Every run (the worker calls it every 10 minutes) rebuilds the lists from the Sheet and patches an
event only when its text changed, so replies that come in later land in the Replies block and finished
items drop off. Blocks keep their time once created. Queue logic mirrors model() in web/ops.html.

  python3 scripts/focus_blocks.py            create/update today's blocks (prints one line)
  python3 scripts/focus_blocks.py --dry      print what it would write, change nothing
  python3 scripts/focus_blocks.py --relayout redo the connect chunks for the day from scratch
  python3 scripts/focus_blocks.py --cleanup  also delete the old per-person "[HQ P..." reminders from today on
Needs shell credentials provider google, email owner@example.com. Never fails the worker: errors print
one line and exit 0.
"""
WITHDRAW_PAUSED = True  # Owner Oct 27 19:40 IST: hold withdrawals for now
import datetime as dt, hashlib, json, re, subprocess, sys

SHEET = "SHEET_ID_PLACEHOLDER"
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
START_HOUR = 21                      # Owner's shift starts 9 pm IST
MIN_PER = {"reply": 5, "follow": 3, "connect": 2}
TITLES = {"reply": "Replies", "follow": "Follow-ups", "connect": "Connects"}
COLOR = {"reply": "11", "follow": "9", "connect": "7"}   # tomato, blueberry, peacock


def gws(args):
    out = subprocess.run(["gws"] + args, capture_output=True, text=True, timeout=90)
    if out.returncode != 0:
        raise RuntimeError((out.stderr or out.stdout).strip()[:200])
    return json.loads(out.stdout or "{}")


def table(tab):
    v = gws(["sheets", "spreadsheets", "values", "get", "--params",
             json.dumps({"spreadsheetId": SHEET, "range": f"{tab}!A:AZ"})]).get("values", [])
    if not v:
        return []
    h = v[0]
    return [{h[i]: (r[i] if i < len(r) else "") for i in range(len(h))} for r in v[1:]]


def d(s):
    m = re.match(r"(\d{4}-\d{2}-\d{2})", str(s or "").strip())
    return m.group(1) if m else ""


def add(day, n):
    return (dt.date.fromisoformat(day) + dt.timedelta(days=n)).isoformat()


def low(s):
    return str(s or "").strip().lower()


def norm_co(s):
    return re.sub(r"[^a-z0-9]", "", low(s))


def li(u):
    u = str(u or "").strip()
    if u and not u.startswith("http"):
        u = "https://" + u.lstrip("/")
    return u


def build(sd):
    people, accts, queue = table("People"), table("Accounts"), table("Queue")
    acc = {a.get("company"): a for a in accts if a.get("company")}
    meet = {norm_co(a.get("company")) for a in accts if low(a.get("meeting_status")) == "set"}
    anq, reply_draft = {}, {}
    for q in queue:
        ac, t = low(q.get("action")), str(q.get("target") or "").strip()
        if not t or low(q.get("status")).startswith("blocked"):
            continue
        if ac in ("send to founder", "take back from founder"):
            anq[t] = "send" if ac == "send to founder" else "back"
        if ac == "draft reply" and q.get("status") == "done" and q.get("result"):
            reply_draft[t] = q["result"]
    out = {"reply": [], "follow": [], "connect": []}
    for p in people:
        if not p.get("id") or not p.get("name") or low(p.get("review")) in ("personal", "pending"):
            continue
        st = p.get("stage") or ""
        x = anq.get(p["id"])
        if x == "send" or (x != "back" and (re.search("founder", p.get("route") or "", re.I) or low(st) == "founder")):
            continue
        if low(st) == "hold":
            continue
        if norm_co(p.get("company")) in meet and not d(p.get("replied")) and not d(p.get("meeting")):
            continue
        cs, ac, d1, d2, d3 = (d(p.get(k)) for k in ("connect_sent", "accepted", "dm1_sent", "dm2_sent", "dm3_sent"))
        rp, mt, wd = d(p.get("replied")), d(p.get("meeting")), d(p.get("withdrawn"))
        if mt or wd or str(p.get("skipped") or "").strip():
            continue
        snz = d(p.get("snooze_until"))
        if snz and snz > sd:
            continue
        d2due = d(p.get("dm2_due")) or (add(d1, 4) if d1 else "")
        d3due = d(p.get("dm3_due")) or (add(d2, 7) if d2 else add(d1, 11) if d1 else "")
        who = {"id": p["id"], "name": p["name"], "title": p.get("title", ""), "co": p.get("company", ""),
               "url": li(p.get("linkedin_url"))}
        if rp:
            if low(p.get("next_action")).startswith(("declined", "removed from queue", "opted out")):
                continue
            out["reply"].append(dict(who, tag="Reply", due=rp, msg=reply_draft.get(p["id"], "")))
        elif d3:
            continue
        elif d2:
            if d3due and d3due <= sd:
                out["follow"].append(dict(who, tag="DM3", due=d3due, msg=p.get("dm3_text", "")))
        elif d1:
            if d2due <= sd:
                out["follow"].append(dict(who, tag="DM2", due=d2due, msg=p.get("dm2_text", "")))
        elif ac:
            if low(p.get("review")) in ("pending", "personal"):
                continue  # Owner picks Lead or Personal first (Oct 27)
            out["follow"].append(dict(who, tag="DM1", due=ac, msg=p.get("dm", "")))
        elif cs:
            if WITHDRAW_PAUSED:
                continue
            age = (dt.date.fromisoformat(sd) - dt.date.fromisoformat(cs)).days
            if age >= 14:
                out["follow"].append(dict(who, tag="Withdraw", due=cs, msg=""))
        elif re.search("connect queued", st, re.I) or not st:
            cd = d(p.get("connect_day"))
            if cd and cd <= sd:
                m = re.search(r"Connect note:\s*([\s\S]*?)(?:\s*\|\s|$)", p.get("notes") or "")
                out["connect"].append(dict(who, tag="Connect", due=cd, msg=(m.group(1).strip() if m else "")))
    order = {"Reply": 0, "DM1": 1, "DM2": 2, "DM3": 3, "Withdraw": 4, "Connect": 5}
    for k in out:
        out[k].sort(key=lambda i: (order[i["tag"]], i["due"], i["co"], i["name"]))
    return out


def describe(kind, items, first_n=1):
    head = {"reply": "Answer each reply yourself on LinkedIn. Ari's suggested answer is under each name.",
            "follow": "Send each message on LinkedIn, then tick it in Ari. Withdraw = pull the invite, no message.",
            # Oct 23 2026 (Owner): blanket connection requests for this run, so the copy says send with no note.
            # Undo: restore "... A note is shown when the invite takes one; otherwise send it blank."
            "connect": "Send each connect on LinkedIn as a blank invite with no note, then tick it in Ari."}[kind]
    lines = [head, ""]
    for n, i in enumerate(items, first_n):
        lines.append(f"{n}. [{i['tag']}] {i['name']}, {i['title']} · {i['co']}".replace(",  ·", " ·"))
        if i["url"]:
            lines.append(i["url"])
        if i["msg"]:
            lines.append(i["msg"])
        elif i["tag"] == "DM3":
            lines.append("(DM3 not drafted yet. Ari writes it before it is due.)")
        elif i["tag"] in ("DM1", "DM2", "Reply"):
            lines.append("(Ari is still drafting this one; it lands here on the next refresh.)")
        lines.append("")
    lines.append("Ari refreshes this block every 10 minutes while you work: finished items drop off, new ones appear.")
    return "\n".join(lines).strip()


def connects(items, have, cursor, sd, now, dry, relayout):
    """Connects come in a handful of fixed chunks spread across the shift (Owner, Oct 22): each block keeps
    its own people (ids in ari_ids), so he can pick one up, finish it and wait for the next. Ticked people
    drop off their block; a finished block reads done. New connects join the last block that has not
    started (up to the chunk size), else get a new block after the last one."""
    log = []
    by_id = {i["id"]: i for i in items}
    blocks = []
    for key, e in have.items():
        if not key or not key.startswith("connect"):
            continue
        ids = e.get("extendedProperties", {}).get("private", {}).get("ari_ids")
        if ids is None or relayout:          # pre-chunking block: replace it
            if not dry:
                gws(["calendar", "events", "delete", "--params", json.dumps({"calendarId": "primary", "eventId": e["id"]})])
            log.append(f"{key} replaced")
            continue
        blocks.append({"e": e, "ids": [x for x in ids.split(",") if x],
                       "start": dt.datetime.fromisoformat(e["start"]["dateTime"]),
                       "end": dt.datetime.fromisoformat(e["end"]["dateTime"])})
    blocks.sort(key=lambda b: b["start"])
    assigned = {x for b in blocks for x in b["ids"]}
    fresh = [i for i in items if i["id"] not in assigned]
    chunk = max(12, -(-len(items) // 6))
    while chunk > 4 and fresh and len(describe("connect", fresh[:chunk])) > 7800:
        chunk -= 2
    if fresh and blocks and blocks[-1]["start"] > now and len(blocks[-1]["ids"]) < chunk:
        room = chunk - len(blocks[-1]["ids"])
        blocks[-1]["ids"] += [i["id"] for i in fresh[:room]]
        fresh = fresh[room:]
    new = [fresh[k:k + chunk] for k in range(0, len(fresh), chunk)]
    if new:
        q = (now + dt.timedelta(minutes=(15 - now.minute % 15) or 15)).replace(second=0, microsecond=0)
        t0 = max(cursor + dt.timedelta(minutes=15), q)
        if blocks:
            t0 = max(t0, blocks[-1]["end"] + dt.timedelta(minutes=30))
        win_end = dt.datetime.fromisoformat(add(sd, 1) + "T03:30:00+05:30")
        durs = [min(45, max(15, -(-len(c) * MIN_PER["connect"] // 15) * 15)) for c in new]
        spare = (win_end - t0).total_seconds() / 60 - sum(durs)
        gap = max(15, int(spare / (len(new) - 1)) // 15 * 15) if len(new) > 1 else 0
        t = t0
        for c, m in zip(new, durs):
            blocks.append({"e": None, "ids": [i["id"] for i in c], "start": t, "end": t + dt.timedelta(minutes=m)})
            t = t + dt.timedelta(minutes=m + gap)
    total = len(blocks)
    for k, b in enumerate(blocks, 1):
        left = [by_id[x] for x in b["ids"] if x in by_id]
        key = "connect" if k == 1 else f"connect#{k}"
        title = f"Ari · Connects {k} of {total} · {len(left)} to send" if left else f"Ari · Connects {k} of {total} · done"
        desc = describe("connect", left, 1) if left else "All sent. Nice work. The next block is on your calendar."
        h = hashlib.md5((title + desc + ",".join(b["ids"])).encode()).hexdigest()[:12]
        priv = {"ari_day": sd, "ari_block": key, "ari_hash": h, "ari_ids": ",".join(b["ids"])}
        if b["e"]:
            if b["e"].get("extendedProperties", {}).get("private", {}).get("ari_hash") != h:
                if not dry:
                    gws(["calendar", "events", "patch", "--params", json.dumps({"calendarId": "primary", "eventId": b["e"]["id"]}),
                         "--json", json.dumps({"summary": title, "description": desc, "extendedProperties": {"private": priv}})])
                log.append(f"{key} updated ({len(left)})")
            continue
        body = {"summary": title, "description": desc, "colorId": COLOR["connect"],
                "start": {"dateTime": b["start"].isoformat(), "timeZone": "Asia/Kolkata"},
                "end": {"dateTime": b["end"].isoformat(), "timeZone": "Asia/Kolkata"},
                "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 0}]},
                "extendedProperties": {"private": priv}}
        if dry:
            print(title, b["start"].strftime("%H:%M"), b["end"].strftime("%H:%M"), len(desc))
        else:
            gws(["calendar", "events", "insert", "--params", json.dumps({"calendarId": "primary"}), "--json", json.dumps(body)])
        log.append(f"{key} created ({len(left)})")
    return log


def main():
    dry, cleanup, relayout = "--dry" in sys.argv, "--cleanup" in sys.argv, "--relayout" in sys.argv
    if not dry:                        # DM3 a week after DM2 (Owner Oct 22): fix dm3_due first so blocks read the rule
        try:
            import cadence
            cadence.main()
        except BaseException as e:
            print("cadence: error %s" % e)
    now = dt.datetime.now(IST)
    sd = (now - dt.timedelta(hours=6)).date().isoformat()
    try:
        groups = build(sd)
        lo = dt.datetime.fromisoformat(sd + "T12:00:00+05:30")
        hi = lo + dt.timedelta(days=1)
        ev = gws(["calendar", "events", "list", "--params", json.dumps({
            "calendarId": "primary", "timeMin": lo.isoformat(), "timeMax": hi.isoformat(),
            "privateExtendedProperty": "ari_day=" + sd, "singleEvents": True, "maxResults": 20})]).get("items", [])
        have = {e.get("extendedProperties", {}).get("private", {}).get("ari_block"): e for e in ev}
        cursor = dt.datetime.fromisoformat(f"{sd}T{START_HOUR:02d}:00:00+05:30")
        done = []
        plan = []
        for kind in ("reply", "follow"):
            items, parts, cur = groups[kind], [], []
            for i in items:            # Google keeps 8,192 characters of a description; split before that
                if cur and len(describe(kind, cur + [i])) > 7800:
                    parts.append(cur); cur = []
                cur.append(i)
            if cur:
                parts.append(cur)
            if not parts:
                parts = [[]]
            n0 = 1
            for k, part in enumerate(parts, 1):
                plan.append((kind, k, len(parts), part, n0, len(items)))
                n0 += len(part)
        wanted = set()
        for kind, k, of, items, n0, total in plan:
            key = kind if k == 1 else f"{kind}#{k}"
            wanted.add(key)
            e = have.get(key)
            mins = min(60, max(15, -(-len(items) * MIN_PER[kind] // 15) * 15))
            label = TITLES[kind] + (f" {k} of {of}" if of > 1 else "")
            title = f"Ari · {label} · {len(items)}" if items else f"Ari · {TITLES[kind]} · all done"
            desc = describe(kind, items, n0) if items else "All done for today. Nice work."
            h = hashlib.md5((title + desc).encode()).hexdigest()[:12]
            if not items and not e:
                continue
            if e:
                if e.get("extendedProperties", {}).get("private", {}).get("ari_hash") != h:
                    body = {"summary": title, "description": desc,
                            "extendedProperties": {"private": {"ari_day": sd, "ari_block": key, "ari_hash": h}}}
                    if not dry:
                        gws(["calendar", "events", "patch", "--params",
                             json.dumps({"calendarId": "primary", "eventId": e["id"]}), "--json", json.dumps(body)])
                    done.append(f"{key} updated ({len(items)})")
                cursor = max(cursor, dt.datetime.fromisoformat(e["end"]["dateTime"]))
                continue
            start, end = cursor, cursor + dt.timedelta(minutes=mins)
            body = {"summary": title, "description": desc, "colorId": COLOR[kind],
                    "start": {"dateTime": start.isoformat(), "timeZone": "Asia/Kolkata"},
                    "end": {"dateTime": end.isoformat(), "timeZone": "Asia/Kolkata"},
                    "reminders": {"useDefault": False, "overrides": [{"method": "popup", "minutes": 0}]},
                    "extendedProperties": {"private": {"ari_day": sd, "ari_block": key, "ari_hash": h}}}
            if dry:
                print(title, start.strftime("%H:%M"), end.strftime("%H:%M"), len(desc))
            else:
                gws(["calendar", "events", "insert", "--params", json.dumps({"calendarId": "primary"}),
                     "--json", json.dumps(body)])
            done.append(f"{key} created ({len(items)})")
            cursor = end
        for key, e in have.items():   # a later part that emptied out goes away
            if key and "#" in key and key not in wanted and not key.startswith("connect"):
                if not dry:
                    gws(["calendar", "events", "delete", "--params",
                         json.dumps({"calendarId": "primary", "eventId": e["id"]})])
                done.append(f"{key} removed")
        done += connects(groups["connect"], have, cursor, sd, now, dry, relayout)
        removed = 0
        if cleanup:
            tmin = dt.datetime.fromisoformat(sd + "T00:00:00+05:30")
            tok = None
            while True:
                prm = {"calendarId": "primary", "timeMin": tmin.isoformat(), "q": "HQ", "singleEvents": True,
                       "maxResults": 250}
                if tok:
                    prm["pageToken"] = tok
                r = gws(["calendar", "events", "list", "--params", json.dumps(prm)])
                for e in r.get("items", []):
                    if re.match(r"^\[HQ P\d+\]", e.get("summary") or ""):
                        if not dry:
                            gws(["calendar", "events", "delete", "--params",
                                 json.dumps({"calendarId": "primary", "eventId": e["id"]})])
                        removed += 1
                tok = r.get("nextPageToken")
                if not tok:
                    break
        msg = f"focus blocks {sd}: " + (", ".join(done) or "unchanged")
        if cleanup:
            msg += f"; old per-person reminders removed: {removed}"
        print(msg)
    except Exception as e:
        print(f"focus blocks skipped: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
