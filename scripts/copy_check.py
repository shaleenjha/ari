#!/usr/bin/env python3
# Ari Copy Lab v1 (Quill, Sat 17 Oct 2026): the MANDATORY code check on every draft, plus the deterministic
# structure pick for DM1 and the list of queued DM2s that must be regenerated. Hark decision 4 (17 Oct 15:00 IST):
# never show Owner a flagged draft as Ari's pick; the worker redrafts (max 2 tries) until this prints PASS.
# Rules: plans/copy-lab/anti-sameness.md (Part 1A hard rules, Part 2 repeat checks), plans/copy-lab/craft-notes.md.
# Code, not a model, runs these checks. Read-only on the database (worker role through scripts/ari_db.py).
#
# usage (shell, project folder; the Supabase ari_worker binding is injected by the proxy):
#   python3 scripts/copy_check.py check <person_id> <kind> <draft.txt> [--structure S2] [--vendor-line] [--asset asset.txt]
#        kind: dm1 | dm2 | dm3 | note.  Prints "PASS" or "FLAG: R3 product line in DM1; R5 ..." (exit 0 / 1).
#        --vendor-line: this text is the "add one short what-we-do line" switch version (R3 not applied).
#   python3 scripts/copy_check.py arm <person_id>      -> JSON {arm, pick, switch, why}: which DM1 structure Ari uses
#   python3 scripts/copy_check.py regen [limit]        -> JSON list of unsent DM2s that must be regenerated (F1/F2/F5)
#   python3 scripts/copy_check.py regen --count        -> just the number (used by worker_precheck.py)
import sys, os, re, json, hashlib, datetime as dt

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

BANNED = ["reason i reached out", "thought this might be relevant", "helping companies like yours", "wanted to introduce myself",
          "would love to connect", "just bumping this", "i know this is a top priority", "transform", "revolutioni",
          "unlock potential", "just checking in", "circling back", "hope this finds you well", "i came across",
          "in today's landscape", "let me know if you're interested", "leverage", "utilize", "streamline", "robust",
          "seamless", "game-changer", "game changer", "synergy", "just following up", "i never heard back"]
HEDGES = [r"\bi'?m guessing\b", r"\bmy guess is\b", r"\bi'?d guess\b", r"\bi'?d expect\b", r"\bi imagine\b",
          r"\bi assume\b", r"\bi'?m assuming\b", r"\bi suspect\b"]
NOT_X_Y = [r"\bnot (just |only )?[\w ,']{1,40}, (it'?s|but)\b", r"\bless about\b.{1,60}\bmore about\b",
           r"\bthe question (stops|isn'?t)\b", r"\bisn'?t about\b.{1,60}\bit'?s about\b"]
LABELS = [r"^(short version|rough answer|the play|bottom line|tl;dr)\s*:", r"\b(short version|rough answer|the play):"]
MEETING = [r"\b\d{1,2} ?(min|mins|minutes)\b", r"\bquick (chat|call|look|swap|walkthrough)\b", r"\bworth a (chat|call|look|quick)\b",
           r"\bopen to (a |)(call|chat|walkthrough|15|20|30)\b", r"\bnext week\b", r"\bthis month\b", r"\bcalendly\b",
           r"\bbook (a|some) time\b", r"\bjump on a call\b", r"\bgood time to talk\b", r"\bwalk (you|your team) through\b"]
STOCK_CLOSERS = ["how is your team handling that today", "how are you handling that today", "is that on your roadmap",
                 "worth a quick chat", "how is your team handling that", "curious how your team handles that today"]
CAP_VERBS = r"(tokeni[sz]|de-?identif|mask|sanitiz|protect|keeps?|swap|strip|takes?|removes?|vault|gives?|handles?|answers?|clears?|enforces?|lets?|sits?|scrub|redact)"
FLATTERY = re.compile(r"\b(congrats|congratulations|love your|loved your|great post|enjoyed your)\b", re.I)
DATE = re.compile(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}\b")
GREETING = re.compile(r"^(hi|hey|hello|thanks)[^,.]*[,.]( (good|great) to connect\.| thanks for connecting\.)?\s*", re.I)
LIMIT = {"dm1": 300, "note": 300, "dm2": 350, "dm3": 350, "asset": 450}
# Clarity (Owner, pack 1 review 17 Oct 15:08 IST): succinct, full context, nothing hard to parse.
VAGUE = [r"\bstill on the list\b", r"\bon (your|the) radar\b", r"\bdraw (that|the) line\b", r"\bthat layer\b", r"\bthis space\b",
         r"\bthat question\b", r"\bthat boundary\b", r"\bthat step\b", r"\bthat piece\b", r"\bthe data side\b",
         r"\bhandling (that|it|this)\b", r"\bthinking about (that|it|this)\b", r"\bapproaching (that|it|this)\b"]
GENERIC_OPEN = re.compile(r"^(how|what|where|curious how)\b.{0,40}\b(handl|think|approach|look at|deal with)\w*\b.{0,15}(that|it|this)\b", re.I)

FICTIONAL_SRC = [os.path.join(ROOT, "plans/copy-lab", f) for f in ("structures.md", "corpus.md", "cocreation-pack-2026-10-17.md")]


def words(t):
    return re.findall(r"[a-z0-9']+", t.lower())


def mask(t, names):
    t = t.lower()
    for n in names:
        if n:
            t = t.replace(n.lower(), " X ")
    t = re.sub(r"\d+", " 0 ", t)
    return words(t)


def grams(ws, n):
    return {" ".join(ws[i:i + n]) for i in range(len(ws) - n + 1)}


def last_sentence(t):
    parts = [p for p in re.split(r"(?<=[.!?])\s+", t.strip()) if p]
    return parts[-1] if parts else ""


def closer_shape(s):
    s2 = s.lower()
    if "?" not in s2:
        return "none"
    if re.search(r"\b(who|which person|whose)\b", s2):
        return "route"
    if re.search(r"\bwant me to\b|\bwant (it|the|a copy)\b|\bshall i send\b", s2):
        return "offer"
    if re.search(r",? or (is|still|not|later|it'?s|that|are|do|does|has)\b|\bor\b[^?]{1,60}\?$", s2):
        return "two-way"
    if re.match(r"^(how|what|where|curious how)\b", s2.split(", ")[-1] if ", " in s2 else s2) or re.search(r"\bhow (is|are|do|does) (your|you)\b", s2):
        return "open"
    return "yes/no"


def corpus_rows():
    import ari_db
    rows = ari_db.get("people?select=id,company,name,notes,dm,dm2_text,dm3_text,dm1_sent,dm2_sent,dm3_sent,dm2_due,updated_at&deleted_at=is.null")
    return rows


OFFER = re.compile(r"\b(send|share|pass along|forward)\b[^.?!]{0,40}\b(it|this|that|the|a|how|short|version|read|details|breakdown|map|notes|summary|over)\b|\bwant (it|a copy|the read)\b|\bmapped\b[^.?!]{0,60}\bwant\b", re.I)


def check(pid, kind, text, structure="", vendor_line=False, rows=None, has_asset=False):
    flags = []
    t = text.strip()
    low = t.lower()
    body = GREETING.sub("", t)
    # ---- R11 hard rules (anti-sameness Part 1A) ----
    if "\u2014" in t or "\u2013" in t or re.search(r"\s-\s", t):
        flags.append("R11 dash")
    for b in BANNED:
        if b in low:
            flags.append("R11 banned phrase '%s'" % b)
    for h in HEDGES:
        if re.search(h, low):
            flags.append("R11 hedge about the reader")
            break
    for p in NOT_X_Y:
        if re.search(p, low):
            flags.append("R11 not-X-it's-Y shape")
            break
    for p in LABELS:
        if re.search(p, low, re.M):
            flags.append("R11 framing label")
            break
    if "p.s" in low or re.search(r"\bps[:.]", low):
        flags.append("R11 P.S.")
    if kind == "asset" and re.search(r"\b(deck|whitepaper|white paper|case study|guide|checklist|report|audit)\b", low):
        flags.append("A1 asset names a document type that is not an approved asset (only the 3-line read is approved)")
    if t.count("?") > 1:
        flags.append("R11 more than one question")
    if "..." in t or "\u2026" in t:
        flags.append("R11 trailing dots")
    if ";" in t:
        flags.append("R11 semicolon (over-polish)")
    m = FLATTERY.search(body)
    if m and len(body.split(".")[0].split()) <= 6:
        flags.append("R11 surface flattery with nothing attached")
    if re.search(r"https?://|calendly|cal\.com", low):
        flags.append("R11 link or calendar in a DM")
    # ---- C1 clarity (Owner 17 Oct): short sentences, no vague referents ----
    for sent in re.split(r"(?<=[.!?])\s+", body):
        if len(sent.split()) > 26:
            flags.append("C1 sentence over 26 words, hard to parse")
            break
    for p in VAGUE:
        if re.search(p, low):
            flags.append("C1 vague phrase '%s' (say the concrete thing)" % re.search(p, low).group(0))
            break
    # ---- meeting asks (Hark decision 5 for DM2, anti-sameness 1A for cold DM1) ----
    if kind in ("dm1", "dm2", "dm3", "asset"):
        for p in MEETING:
            if re.search(p, low):
                flags.append("M1 meeting or time ask")
                break
    # ---- A2 asset rule (Owner 17 Oct, hard): an offer to send something needs its asset written alongside ----
    if kind in ("dm1", "dm2", "dm3") and not has_asset and OFFER.search(t):
        flags.append("A2 offers to send something with no asset (write the 3-line read and pass --asset <file>, or drop the offer)")
    # ---- R10 length ----
    lim = LIMIT.get(kind, 350)
    if len(t) > lim:
        flags.append("R10 over %d characters (%d)" % (lim, len(t)))
    # ---- R3 product line in DM1 (Hark decision 1: default no Vendor line) ----
    if kind == "dm1" and not vendor_line and re.search(r"\bthrandvex\b", low):
        flags.append("R3 Vendor named in DM1 (default is no product line; the switch version carries it)")
    if kind == "dm1" and vendor_line:
        sl = [s for s in re.split(r"(?<=[.!?])\s+", t) if "vendor" in s.lower()]
        if len(sl) > 1 or (sl and len(sl[0].split()) > 16):
            flags.append("R3 Vendor line longer than one short line")
    # ---- P1 capability pitch in a follow-up (Hark decision 5: DM2s stop re-pitching) ----
    if kind in ("dm2", "dm3"):
        for sent in re.split(r"(?<=[.!?])\s+", t):
            sl = sent.lower()
            if "vendor" in sl and "working with a leading ai lab" not in sl and re.search(r"\bthrandvex('s)?\b[^.?!]{0,40}\b" + CAP_VERBS, sl):
                flags.append("P1 capability pitch (use one Section 6 proof line as evidence, not a feature line)")
                break
    # ---- R5 closer shape / stock closers ----
    last = last_sentence(t)
    shape = closer_shape(last)
    if kind == "dm1" and shape == "open" and GENERIC_OPEN.search(re.sub(r"^[^,]*, ", "", last) if last.lower().startswith(("so", "and")) else last):
        flags.append("R5 generic open closer (ask a direct, specific question instead)")
    norm_last = re.sub(r"[^a-z ]", "", last.lower()).strip()
    for sc in STOCK_CLOSERS:
        if sc in norm_last:
            flags.append("R5 stock closer")
            break
    # ---- structure-specific minimums ----
    s = (structure or "").upper().split()[0] if structure else ""
    if s == "S5" and shape != "offer":
        flags.append("S5 The give must end on the offer (want me to send it?)")
    if s == "S6" and shape != "route":
        flags.append("S6 Who owns this must ask who owns it")
    if s == "S2" and shape != "two-way":
        flags.append("S2 Confirm or correct needs a two-way close (X, or still Y?)")
    if s == "F1" and not low.startswith("the reason i asked") and "reason i asked" not in low[:60]:
        flags.append("F1 should open 'The reason I asked'")
    # ---- R9 example copying (6-word runs from the library or corpus) ----
    ws = words(t)
    six = grams(ws, 6)
    for f in FICTIONAL_SRC:
        try:
            src = grams(words(open(f).read()), 6)
        except Exception:
            continue
        hit = six & src
        hit = {h for h in hit if not re.fullmatch(r"(hi|the|a|of|to|and|in|is|it|that|you|your|or|on)( \S+)*", h) or len(set(h.split())) > 4}
        if hit:
            flags.append("R9 copies a 6-word run from %s ('%s')" % (os.path.basename(f), sorted(hit)[0]))
            break
    # ---- repeat checks against Ari's own drafts and sends ----
    if rows is None:
        try:
            rows = corpus_rows()
        except BaseException as e:  # DB down: hard rules above still apply; repeat checks are skipped and said so
            flags.append("NOTE repeat checks skipped (db: %s)" % str(e)[:80])
            rows = []
    me = next((r for r in rows if r.get("id") == pid), {}) if rows else {}
    company = (me.get("company") or "").strip()
    names = [company] + [(r.get("name") or "").split(" ")[0] for r in rows if r.get("name")][:0]
    first = (me.get("name") or "").split(" ")[0]
    mine = mask(t, [company, first, me.get("name") or ""])
    mine4 = grams(mine, 4)
    own_cols = {"dm1": "dm", "note": "dm", "dm2": "dm2_text", "dm3": "dm3_text"}
    others, same_acct = [], []
    for r in rows:
        for col in ("dm", "dm2_text", "dm3_text"):
            txt = (r.get(col) or "").strip()
            if not txt or (r.get("id") == pid and col == own_cols.get(kind)):
                continue
            entry = (r, col, txt)
            others.append(entry)
            if company and (r.get("company") or "").strip().lower() == company.lower() and r.get("id") != pid:
                same_acct.append(entry)
    # R4 closer reuse (any other draft or send)
    mine_close = re.sub(r"[^a-z ]", "", last.lower().replace(first.lower(), "").replace(company.lower(), "")).strip()
    if mine_close and len(mine_close.split()) >= 3:
        n = 0
        for r, col, txt in others:
            rc = (r.get("name") or "").split(" ")[0].lower()
            oc = re.sub(r"[^a-z ]", "", last_sentence(txt).lower().replace(rc, "").replace((r.get("company") or "").lower(), "")).strip()
            if oc == mine_close:
                n += 1
        if n:
            flags.append("R4 same closer as %d other draft(s) or send(s)" % n)
    # R6 phrase overlap (masked 4-grams) > 35% with any other draft; R7-lite: > 25% with a draft at the same account
    if mine4:
        worst, worst_same = 0.0, 0.0
        for r, col, txt in others:
            o = grams(mask(txt, [r.get("company") or "", (r.get("name") or "").split(" ")[0], r.get("name") or ""]), 4)
            if not o:
                continue
            ov = len(mine4 & o) / len(mine4)
            worst = max(worst, ov)
            if (r, col, txt) in same_acct:
                worst_same = max(worst_same, ov)
        if worst > 0.35:
            flags.append("R6 phrase overlap %d%% with another draft" % round(worst * 100))
        elif worst_same > 0.25:
            flags.append("R7 too close to a colleague's draft at the same account (%d%%)" % round(worst_same * 100))
    # R2 opening move share (DM1): first content word vs the last 20 DM1s
    if kind == "dm1":
        op = (words(body) or [""])[0]
        dm1s = sorted([r for r in rows if r.get("dm") and r.get("id") != pid], key=lambda r: str(r.get("updated_at") or ""))[-20:]
        if dm1s and op:
            share = sum(1 for r in dm1s if (words(GREETING.sub("", r["dm"].strip())) or [""])[0] == op) / len(dm1s)
            if share > 0.40:
                flags.append("R2 opens on '%s' like %d%% of recent DM1s" % (op, round(share * 100)))
    # Date for show: more than one month-day date
    if len(DATE.findall(t)) > 1:
        flags.append("R11 more than one date")
    return [f for f in flags if not f.startswith("NOTE")], [f for f in flags if f.startswith("NOTE")]


# ---------------- deterministic DM1 arm (Hark decision 3) ----------------
ISV_HINTS = re.compile(r"\b(mcp|agent|api|platform|isv|saas|connector|sdk|marketplace|embedded|ai)\b", re.I)


def arm(pid):
    h = int(hashlib.md5(("copylab-v1:" + pid).encode()).hexdigest(), 16)
    ae, company, title = "", "", ""
    try:
        import ari_db
        r = (ari_db.get("people?select=id,company,title,account_id&id=eq.%s" % pid) or [{}])[0]
        company, title = r.get("company") or "", r.get("title") or ""
        if r.get("account_id"):
            a = (ari_db.get("accounts?select=ae&id=eq.%s" % r["account_id"]) or [{}])[0]
            ae = a.get("ae") or ""
    except BaseException:
        pass
    blake = "blake" in ae.lower()
    switch = "S11 Their buyer's question" if blake else "S6 Who owns this"
    if h % 5 == 0:  # 20% challenger arm, split across S2, S5, S11 (Owner 17 Oct 15:08 IST added S11)
        pick = ["S2 Confirm or correct", "S5 The give", "S11 Their buyer's question"][(h // 5) % 3]
        if pick.startswith("S11"):
            switch = "S6 Who owns this"
        return {"arm": "challenger", "pick": pick, "switch": switch,
                "why": "Copy Lab v1 challenger arm (20%% of DM1s split across S2, S5, S11, deterministic by person id). Switch: %s." % switch,
                "s5_fallback": "S5 only when Ari can write the 3-line read now (asset rule). Otherwise use S11 for ISV and AI vendors, else S2, and say so in V notes."}
    return {"arm": "control", "pick": "X0 Current shape", "switch": switch,
            "why": "Comparison arm (80%): a dated trigger, what it implies, one direct and specific question (open is fine if asked well), no Vendor line (decision 1)."}


# ---------------- DM2 regeneration list (Hark decision 5) ----------------
def regen(limit=200):
    # Every unsent DM2 written before Copy Lab v1 is regenerated: those drafts are untagged (no F1/F2/F5 structure).
    # A DM2 drops off this list once the worker has rewritten it and tagged it (draft_tag.py), or when it passes
    # the checks AND is tagged. Untagged = in ari_worker_untagged_drafts.
    import ari_db
    rows = corpus_rows()
    untagged = {(u.get("person_id"), u.get("kind")) for u in (ari_db.rpc("ari_worker_untagged_drafts", {"p_limit": 2000}) or [])}
    out = []
    for r in rows:
        txt = (r.get("dm2_text") or "").strip()
        if not txt or r.get("dm2_sent") or not r.get("dm1_sent"):
            continue
        fl, _ = check(r["id"], "dm2", txt, rows=rows)
        bad = [f for f in fl if f.startswith(("M1", "R11", "R10", "R5", "R4", "R6", "P1", "A2"))]
        if "flagged:" in (r.get("notes") or "").lower():
            continue  # Ari already tried twice and marked it for Owner; never loop on it
        if (r["id"], "dm2") in untagged:
            bad = bad or ["untagged pre Copy Lab draft"]
        if bad:
            out.append({"person_id": r["id"], "company": r.get("company"), "dm2_due": r.get("dm2_due"), "flags": bad})
    out.sort(key=lambda x: (str(x.get("dm2_due") or "9999"), x["person_id"]))
    return out[:limit]


def main(a):
    if not a:
        print(__doc__ or "usage: copy_check.py check|arm|regen"); return 2
    cmd = a[0]
    if cmd == "check":
        if len(a) < 4:
            print("usage: copy_check.py check <person_id> <kind> <draft.txt> [--structure S2] [--vendor-line]"); return 2
        st = a[a.index("--structure") + 1] if "--structure" in a else ""
        text = open(a[3]).read()
        ha = False
        if "--asset" in a:
            af = a[a.index("--asset") + 1]
            ha = os.path.exists(af) and len(open(af).read().strip()) > 40
            if ha:
                afl, _ = check(a[1], "asset", open(af).read(), rows=[])
                if afl:
                    print("FLAG: asset file: " + "; ".join(afl)); return 1
        fl, notes = check(a[1], a[2], text, st, "--vendor-line" in a, has_asset=ha)
        for n in notes:
            print(n)
        if fl:
            print("FLAG: " + "; ".join(fl)); return 1
        print("PASS"); return 0
    if cmd == "arm":
        print(json.dumps(arm(a[1]))); return 0
    if cmd == "regen":
        lst = regen()
        if "--count" in a:
            print(len(lst)); return 0
        lim = int(a[1]) if len(a) > 1 and a[1].isdigit() else 200
        print(json.dumps(lst[:lim], indent=1)); return 0
    print("unknown command"); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
