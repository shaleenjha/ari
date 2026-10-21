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
#   python3 scripts/copy_check.py regen [limit]        -> JSON list of unsent DM1s and DM2s that fail the AE style guide (since 21 Oct 2026)
#        kind exec = an exec-track note (old v1 checks only); kind note = Owner's connect note (AE guide shape).
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
    rows = ari_db.get("people?select=id,account_id,company,name,notes,dm,dm2_text,dm3_text,connect_sent,accepted,dm1_sent,dm2_sent,dm3_sent,dm2_due,stage,route,review,research,replied,updated_at&deleted_at=is.null")
    return rows


OFFER = re.compile(r"\b(send|share|pass along|forward)\b[^.?!]{0,40}\b(it|this|that|the|a|how|short|version|read|details|breakdown|map|notes|summary|over)\b|\bwant (it|a copy|the read)\b|\bmapped\b[^.?!]{0,60}\bwant\b", re.I)


def _check_v1(pid, kind, text, structure="", vendor_line=False, rows=None, has_asset=False):
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


# ---------------- AE style guide (Owner, Wed 21 Oct 2026 04:24 IST, option A) ----------------
# plans/copy-lab/ae-styles.md (from Owner's work Claude) is now the canonical shape for connect notes, DM1 and DM2.
# Style comes from the account's AE: Blake -> Blake style; Alex, Casey (Owner's call) and no AE -> Alex style.
# The Copy Lab v1 checks that contradict the guide (no meeting ask, no Vendor line in DM1, stock closer
# "worth a quick chat", closer reuse, opening share, character caps, S/F structure minimums) are dropped for
# these kinds; every other floor (dashes, banned phrases, hedges, clarity, links, repeats) still runs.
AE_STYLE_SINCE = "2026-10-21"
STYLE_KINDS = ("note", "dm1", "dm2")
ALLOWED_CUSTOMERS = ["goodrx", "walmart", "visa", "flo health"]
KNOWN_CUSTOMERS = ALLOWED_CUSTOMERS + ["hippocratic"]
COMPETITORS = ["protegrity", "private ai", "tonic", "gretel", "incountry", "agentcloak", "very good security", "vgs",
               "basis theory", "evervault", "bigid", "onetrust", "securiti", "nightfall", "cyera", "thales", "voltage",
               "piiano", "immuta", "privacera", "tokenex", "vendor alternative"]
STYLE_BANNED = ["i'd love to", "i would love to", "reason i'm reaching out", "reason i am reaching out", "unlock",
                "revolutioniz", "transform your", "just following up"]
GUIDE_FIXED = re.compile(r"(thanks for connecting, [^.]+\.|^\S+, last one from me\.|we built a data privacy layer that|"
                         r"teams like visa use it\.|worth connecting\?|worth 15 minutes\?|worth a quick call\?|"
                         r"worth 20 minutes with you and|happy to show how|we talk to|on your 2027 list|most )", re.I)
V1_DROP = ("M1", "R3", "P1", "R5", "R4", "R2", "R10", "S2 ", "S5 ", "S6 ", "F1 ")
TRIGGER = re.compile(r"\b(saw|noticed|congrats|just (launched|announced|raised|hired)|announced|launched|raised|hired|joined as)\b", re.I)


_ACC = None


def _accounts():
    global _ACC
    if _ACC is None:
        import ari_db
        _ACC = {a["id"]: a for a in (ari_db.get("accounts?select=id,ae,hook_date&deleted_at=is.null") or [])}
    return _ACC


def style_for(pid, rows=None):
    ae = ""
    try:
        import ari_db
        me = next((r for r in (rows or []) if r.get("id") == pid), None)
        if me is None:
            me = (ari_db.get("people?select=id,account_id&id=eq.%s" % pid) or [{}])[0]
        if me.get("account_id"):
            ae = (_accounts().get(me["account_id"]) or {}).get("ae") or ""
    except BaseException:
        pass
    return ("blake" if "blake" in ae.lower() else "alex"), ae


def _hook_ok(pid, rows=None):
    # A trigger line must be real and dated: the account needs a hook_date in the last ~6 months, or the
    # person's V notes a "Trigger: <date>" line.
    try:
        import ari_db
        me = next((r for r in (rows or []) if r.get("id") == pid), None) or \
            (ari_db.get("people?select=id,account_id,notes&id=eq.%s" % pid) or [{}])[0]
        if re.search(r"trigger:\s*20\d\d-\d\d-\d\d", (me.get("notes") or "").lower()):
            return True
        if me.get("account_id"):
            a = _accounts().get(me["account_id"]) or {}
            d = (a.get("hook_date") or "")[:10]
            if d:
                return (dt.date.today() - dt.date.fromisoformat(d)).days <= 190
    except BaseException:
        return True  # db down: never block on this; the human floor still applies
    return False


def style_flags(pid, kind, text, style, rows=None):
    f = []
    t = text.strip()
    low = t.lower()
    nw = len(t.split())
    sents = [x for x in re.split(r"(?<=[.!?])\s+", t) if x]
    last = (sents[-1] if sents else "").lower()
    first_name = ""
    me = next((r for r in (rows or []) if r.get("id") == pid), {}) if rows else {}
    first_name = ((me.get("name") or "").split(" ") or [""])[0].lower()
    for b in STYLE_BANNED:
        if b in low:
            f.append("G1 banned by the AE guide ('%s')" % b)
    if "{{" in t:
        f.append("G1 template placeholder left in")
    named = [c for c in KNOWN_CUSTOMERS if re.search(r"\b%s\b" % re.escape(c), low)]
    if "hippocratic" in named:
        f.append("G2 Hippocratic AI may never be named")
    if style == "blake" and any(c != "visa" for c in named):
        f.append("G2 Blake's accounts name Visa only")
    if style == "blake":
        comp = [c for c in COMPETITORS if re.search(r"\b%s\b" % re.escape(c), low)]
        if comp:
            f.append("G2 Blake's accounts never name a competitor ('%s')" % comp[0])
    if TRIGGER.search(t) and not _hook_ok(pid, rows):
        f.append("G3 trigger line with no dated hook on file (drop it and use the plain problem)")
    if t.count("?") == 0 or not last.endswith("?"):
        f.append("G4 must end on one closed ask")
    if kind == "note":
        if len(t) >= 200:
            f.append("G5 connect note over 200 characters (%d)" % len(t))
        if re.search(r"https?://|www\.", low):
            f.append("G5 link in a connect note")
        if not re.match(r"^hi \S+,", low):
            f.append("G6 connect note opens 'Hi <First>,'")
        if "we built a data privacy layer that" not in low:
            f.append("G6 connect note says 'we built a data privacy layer that ...'")
        if not last.startswith("worth connecting"):
            f.append("G6 connect note ends 'Worth connecting?'")
        if style == "blake" and "teams like visa use it" not in low:
            f.append("G6 Blake connect note carries 'Teams like Visa use it.'")
        if style == "alex" and not (named or re.search(r"\b\d+ of the top\b", low)):
            f.append("G6 Alex connect note carries one proof line (a number or an allowed customer)")
        if t.count("?") > 1:
            f.append("G4 one ask only")
        return f
    lim = 65 if (kind == "dm1" and style == "blake") else 55
    if nw > lim:
        f.append("G5 over %d words (%d)" % (lim, nw))
    if kind == "dm1":
        if not low.startswith("thanks for connecting"):
            f.append("G6 DM1 opens 'Thanks for connecting, <First>.'")
        if "we talk to" not in low and style == "blake":
            f.append("G6 Blake beat 2: 'Most <peer group> we talk to ...'")
        if style == "alex":
            if not re.search(r"worth 15 minutes\?$", last):
                f.append("G6 Alex DM1 ends 'Worth 15 minutes?'")
            if t.count("?") > 1:
                f.append("G4 Alex asks for the meeting only, no open question")
            if re.search(r"\b(20|30|45) (min|mins|minutes)\b", low):
                f.append("G6 Alex never asks past 15 minutes")
            if re.search(r"\btokeni[sz]ation\b|\bencrypt|\bvault\b", low):
                f.append("G7 Alex never explains how it works")
        else:
            if t.count("?") != 2:
                f.append("G6 Blake DM1 has two questions: beat 1 and the ask")
            if not re.search(r"^worth 20 minutes with you and .+\?$", last):
                f.append("G6 Blake DM1 ends 'Worth 20 minutes with you and <owner>?'")
            if "vendor" not in low:
                f.append("G6 Blake beat 3: one line on what Vendor does")
    if kind == "dm2":
        if not re.match(r"^\S+, last one from me\.", low):
            f.append("G6 DM2 opens '<First>, last one from me.'")
        if "happy to show how" not in low:
            f.append("G6 DM2 carries 'happy to show how ...'")
        if not last.startswith("worth a quick call"):
            f.append("G6 DM2 ends 'Worth a quick call?'")
        if t.count("?") > 1:
            f.append("G4 one ask only")
    return f


def check(pid, kind, text, structure="", vendor_line=False, rows=None, has_asset=False):
    if kind == "exec":  # exec-track note: v1 note checks, minus closer reuse (its closer is fixed by Owner)
        fl, notes = _check_v1(pid, "note", text, structure, vendor_line, rows, has_asset)
        return [x for x in fl if not x.startswith("R4")], notes
    if kind not in STYLE_KINDS:
        return _check_v1(pid, kind, text, structure, vendor_line, rows, has_asset)
    if rows is None:
        try:
            rows = corpus_rows()
        except BaseException:
            rows = []
    style, _ = style_for(pid, rows)
    # The guide's fixed lines are shared on purpose; take them out before the repeat checks see the text.
    core = GUIDE_FIXED.sub(" ", text)
    fl, notes = _check_v1(pid, kind, core, structure, True, rows, has_asset)
    fl = [x for x in fl if not x.startswith(V1_DROP)]
    if style == "blake" and kind == "dm1":
        fl = [x for x in fl if x != "R11 more than one question"]
    fl += style_flags(pid, kind, text, style, rows)
    return fl, notes


# ---------------- deterministic DM1 arm (Hark decision 3) ----------------
ISV_HINTS = re.compile(r"\b(mcp|agent|api|platform|isv|saas|connector|sdk|marketplace|embedded|ai)\b", re.I)


def arm(pid):
    # Since Wed 21 Oct 2026 (Owner, option A): the AE style guide replaces the Copy Lab v1 arms.
    style, ae = style_for(pid)
    name = "AE Blake style" if style == "blake" else "AE Alex style"
    return {"arm": "ae_style", "pick": name, "style": style, "ae": ae or "none",
            "switch": "%s, other angle" % name,
            "why": "plans/copy-lab/ae-styles.md, %s shape. Pick = the trigger version when a real dated hook is on file, "
                   "else the plain-problem version; switch = the other one, same style." % ("Blake four-beat" if style == "blake" else "Alex")}


def _arm_v1(pid):
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
    # Since Wed 21 Oct 2026 (Owner, option A): every unsent DM1 and DM2 that fails the AE style guide is redrafted.
    # Sent messages are never touched. Exec-track people (their K dm is an exec note), Hold, personal, flagged
    # and replied people are skipped. A row Ari already marked "Flagged:" is not retried.
    rows = corpus_rows()
    out = []
    for r in rows:
        if (r.get("review") or "").lower() == "personal" or r.get("replied"):
            continue
        st = (r.get("stage") or "").lower()
        if st in ("hold", "founder") or "founder" in (r.get("route") or "").lower():
            continue
        if (r.get("research") or "").lower().startswith("flagged"):
            continue
        if "flagged:" in (r.get("notes") or "").lower():
            continue
        if "event invite: keep" in (r.get("notes") or "").lower():   # Owner Oct 21 2026: re:Invent leads keep the Descope dinner / booth invite
            continue
        for kind, col, sent in (("dm1", "dm", "dm1_sent"), ("dm2", "dm2_text", "dm2_sent")):
            txt = (r.get(col) or "").strip()
            if not txt or r.get(sent):
                continue
            fl, _ = check(r["id"], kind, txt, rows=rows)
            # Repeat-only flags (R6/R7) do not trigger a redraft: Owner's own sheet copy reuses the guide's
            # lines across one segment on purpose. New drafts still have to clear them.
            fl = [x for x in fl if not x.startswith(("R6", "R7"))]
            if fl:
                out.append({"person_id": r["id"], "kind": kind, "company": r.get("company"),
                            "due": r.get("dm2_due") if kind == "dm2" else r.get("accepted"), "flags": fl[:4]})
    # accepted people's DM1s first (they are next to send), then DM2s by due date, then the rest
    out.sort(key=lambda x: (0 if (x["kind"] == "dm1" and x.get("due")) else 1 if x["kind"] == "dm2" else 2,
                            str(x.get("due") or "9999"), x["person_id"]))
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
        lst = regen(100000)
        if "--count" in a:
            print(len(lst)); return 0
        lim = int(a[1]) if len(a) > 1 and a[1].isdigit() else 200
        print(json.dumps(lst[:lim], indent=1)); return 0
    print("unknown command"); return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
