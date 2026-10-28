#!/usr/bin/env python3
"""Draft assumptions, copy_check gate G12 (Oct 28 2026; spec plans/assumptions-to-confirm.md, Owner chose option C).

G12 pulls every number, date, name, title, event and customer name out of a draft and lists the ones that have no
written source for that person: the people row, the account (hook, research, account brief), emails at the account,
what Owner already sent or said about them, and anything Owner confirmed before. Each item is
    {"id", "text", "kind": name|title|number|date|event|customer|claim, "source": "drafter"|"checker", "status": "open"}
G12 never fails a draft. An unapproved customer name stays a hard G2 fail in copy_check.py; approved customers
(seller settings) count as sourced, because the approved proof list is their source.

Storage: one queue row per draft, id 'AS:<person_id>:<kind>', column queue.assumptions (migration 0046). Writing is OFF
unless ARI_ASSUMPTIONS_STORE=1 (staging only until Owner turns it on; production has no such column yet).
Option C gating lives in the app: Copy stays off while an open item of kind number or customer remains.

usage (shell, project folder):
  python3 scripts/copy_check.py check <pid> <kind> <draft.txt> --g12 [--assumptions drafter.json] [--store]
  python3 scripts/assumptions.py extract <draft.txt>          -> JSON items found in the text (no sources, no network)
Drafter file: [{"text": "<exact phrase from the draft>", "kind": "<one of the kinds>"}, ...]  (an empty list is fine)
"""
import datetime as dt, hashlib, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

KINDS = ("name", "title", "number", "date", "event", "customer", "claim")
HARD = ("number", "customer")          # option C: these block Copy while open
STATUSES = ("open", "confirmed", "struck", "edited")
MAX_ITEMS = 60                          # matches the 0046 check constraint
PLAYS_DOC = os.path.join(ROOT, "files", "uploads", "thrandvex-outbound-plays-for-hark.md")

MONTHS = r"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)"
WEEKDAYS = r"(?:Mon|Tues?|Wed(?:nes)?|Thu(?:rs)?|Fri|Sat(?:ur)?|Sun)(?:day)?"
DATE_RX = re.compile(
    r"\b(?:" + MONTHS + r"\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+(?:19|20)\d\d)?"     # Oct 14, Oct 14 2026
    r"|\d{1,2}(?:st|nd|rd|th)?\s+" + MONTHS + r"(?:,?\s+(?:19|20)\d\d)?"           # 14 Oct
    r"|" + MONTHS + r"\.?\s+(?:19|20)\d\d"                                          # Oct 2026
    r"|(?:19|20)\d\d-\d\d-\d\d"                                                     # 2026-10-14
    r"|Q[1-4](?:\s+(?:19|20)\d\d)?"                                                 # Q3, Q3 2026
    r"|(?:last|this|next)\s+(?:week|month|quarter|year)"
    r"|earlier\s+this\s+(?:week|month|quarter|year)|yesterday|recently"
    r"|" + WEEKDAYS + r"|" + MONTHS + r"|(?:19|20)\d\d)\b")
NUM_WORDS = r"(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|fifty|hundred|thousand|million|billion|dozens|hundreds|thousands|millions)"
NUM_RX = re.compile(
    r"(?<![\w.])\$?\d[\d,]*(?:\.\d+)?(?:\s?(?:%|percent\b|x\b|k\b|m\b|bn\b|million\b|billion\b|thousand\b))?(?![\w])"
    r"|\b" + NUM_WORDS + r"(?:[\s-]+" + NUM_WORDS + r")*\s+(?:percent|times|million|billion|thousand|of the top \d+|(?:of\s+)?(?:hospitals|customers|clinics|patients|teams|banks|payers|providers|health systems|companies|records|members|users))\b", re.I)
ASK_RX = re.compile(r"\b(?:worth|free for)\s+(?:a quick call|\d+\s+minutes)(?:\s+next week|\s+with you and [^?]+)?\?", re.I)
FIXED_RX = re.compile(r"\b(?:thanks for connecting|quick one|following up on|last one from me on|happy to show how|hope all is well|"
                      r"we spend all day on that same tension|we built a data privacy layer that|worth connecting)\b", re.I)
TITLE_RX = re.compile(
    r"\b(?:(?:Senior|Sr\.?|Executive|Group|Global|Associate|Assistant|Deputy)\s)?"
    r"(?:SVP|EVP|AVP|VP|Vice President|Director|Head|Chief(?:\s[A-Z][a-z]+){1,2}\sOfficer|CISO|CTO|CEO|CIO|CDO|CAIO|CPO|CMO|COO|CFO|CRO|CMIO|CNO|"
    r"General Manager|Product Manager|Engineering Manager|Founder|Co-?founder|President|Principal Engineer|Staff Engineer|Architect)\b"
    r"(?:,?\s(?:of\s|for\s)?(?!(?:at|in)\b)(?:[A-Z][a-z][\w&/]*|AI|ML|IT)(?:\s(?:&|and)\s[A-Z][a-z][\w&/]*)?)?")
GENERIC_BEFORE = re.compile(r"\b(?:your|a|an|every|any|most|their|our|each)\s+(?:new\s+|own\s+)?$", re.I)
CUSTOMER_CTX = [
    re.compile(r"\((?P<n>[A-Z][\w&.'-]*(?:\s[A-Z][\w&.'-]*){0,3})\s+(?:handles|uses|runs|does|solved|fixed)\b"),
    re.compile(r"\bteams like (?P<n>[A-Z][\w&.'-]*(?:\s[A-Z][\w&.'-]*){0,3})"),
    re.compile(r"\b(?:customers?|clients?|companies|teams) (?:like|such as|including) (?P<n>[A-Z][\w&.'-]*(?:\s[A-Z][\w&.'-]*){0,3})"),
    re.compile(r"(?:^|[.!?]\s+|,\s+|\band\s+)(?P<n>[A-Z][\w&.'-]*(?:\s[A-Z][\w&.'-]*){0,3}) (?:uses|use|chose|picked|runs on|relies on|cut|reduced|saved|shipped|passed|cleared|moved)\b"),
]
EVENT_WORDS = re.compile(r"\b(?:[A-Z][\w:'-]*\s){0,3}(?:Summit|Conference|Expo|Forum|Keynote|Webinar|Panel|Podcast|Hackathon|World|Week)\b(?:\s(?:19|20)\d\d)?")
EVENT_VERBS = re.compile(r"\b(?:launched|launches|announced|announces|raised|acquired|acquires|hired|joined|rolled out|released|unveiled|"
                         r"partnered|expanded|opened|went live|spoke|presented|posted|wrote|filed|closed a|series [A-F])\b", re.I)
DOMAIN_ACRONYMS = set("PHI PII PCI HIPAA SOC SOC2 GDPR CCPA AI ML LLM LLMS API APIS MCP EHR EHRS EMR SDK SAAS ISV CX ITSM IT SSN SSNS ID IDS "
                      "QA RAG BAA FHIR HL7 DPA ISO NIST FEDRAMP DLP SSO OAUTH US USA EU UK KYC AML PCI-DSS DSS SMS OCR NLP GPU CRM ERP "
                      "HR ROI KPI OK TV PDF CSV JSON SQL ETL BI UI UX".split())
COMMON = set("""a an and are as at be but by can do does for from had has have he her his how i i'd i'm i've if in into is it it's its
just last let me more most my new no not now of on one or our out over quick so some still than that the their them then there these
they this those to too up us was we we're what when where which while who why will with would you your you're yours
thanks thank worth happy hope hi hey hello free following follow following last teams team security every since once each also
our ours before after during agents agent card cards member members patient patients support data voice live calls""".split())
STOP = set("about after again their there these those which while would could should where every other being your yours with from "
           "into that this what when have will once than then them they ever only just more most also team teams data".split())
TITLE_EXPAND = {"vp": "vice president", "svp": "senior vice president", "evp": "executive vice president", "sr": "senior",
                "eng": "engineering", "cto": "chief technology officer", "ciso": "chief information security officer",
                "cio": "chief information officer", "ceo": "chief executive officer", "cdo": "chief data officer",
                "caio": "chief ai officer", "cpo": "chief product officer", "cmo": "chief medical officer"}


def norm(s):
    return re.sub(r"\s+", " ", re.sub(r"[^\w%$&.' -]", " ", str(s or "").lower().replace("\u2019", "'"))).strip(" .'")


def item_id(text):
    return hashlib.sha1(norm(text).encode()).hexdigest()[:10]


def _words(s):
    return re.findall(r"[a-z0-9][a-z0-9&'-]*", str(s or "").lower().replace("\u2019", "'"))


def _cfg():
    try:
        import seller_config
        return seller_config.load()
    except Exception:
        return {"seller": "", "allowed_customers": [], "never_name": {"match": ""}}


# ---------------- extraction (pure, no network) ----------------
def extract(text, cfg=None):
    """Every checkable fact in the draft, in order: [{"text", "kind"}]. Fixed guide lines and the ask are skipped."""
    cfg = cfg or _cfg()
    seller = (cfg.get("seller") or "").lower()
    t = str(text or "").replace("\u2019", "'")
    taken = [False] * len(t)
    out = []

    def free(a, b):
        return not any(taken[a:b])

    def take(a, b, kind, s=None):
        s = (s if s is not None else t[a:b]).strip(" ,.;:'")
        if not s or not free(a, b):
            return
        for i in range(a, b):
            taken[i] = True
        out.append({"text": s, "kind": kind, "_at": a})

    for rx in (ASK_RX, FIXED_RX):
        for m in rx.finditer(t):
            for i in range(m.start(), m.end()):
                taken[i] = True
    for m in re.finditer(r"\b(?:[A-Z]{3,}[a-z]?|[a-z]{2}:[A-Z][a-z]+)\s(?:19|20)\d\d\b", t):
        take(m.start(), m.end(), "event")          # HLTH 2026, re:Invent 2026
    for m in DATE_RX.finditer(t):
        take(m.start(), m.end(), "date")
    for rx in CUSTOMER_CTX:
        for m in rx.finditer(t):
            n = m.group("n").rstrip(".'")
            if n.lower().endswith("'s"):
                n = n[:-2]
            a = m.start("n")
            low = n.lower()
            if low in COMMON or low == seller or low.upper() in DOMAIN_ACRONYMS:
                continue
            take(a, a + len(n), "customer", n)
    for m in TITLE_RX.finditer(t):
        if GENERIC_BEFORE.search(t[max(0, m.start() - 20):m.start()]):
            for i in range(m.start(), m.end()):
                taken[i] = True
            continue
        take(m.start(), m.end(), "title")
    for m in EVENT_WORDS.finditer(t):
        take(m.start(), m.end(), "event")
    for m in NUM_RX.finditer(t):
        take(m.start(), m.end(), "number")
    # event phrases: the clause around a trigger verb ("Quillfen launched an AI scribe")
    ev_end = -1
    for m in EVENT_VERBS.finditer(t):
        if m.start() < ev_end:
            continue
        a = max(t.rfind(".", 0, m.start()), t.rfind(",", 0, m.start()), t.rfind("?", 0, m.start()), t.rfind("!", 0, m.start())) + 1
        stops = [x for x in (t.find(".", m.end()), t.find(",", m.end()), t.find("?", m.end()), t.find(" and ", m.end())) if x >= 0]
        b = min(stops) if stops else len(t)
        pre = t[a:m.start()].split()[-4:]
        post = t[m.end():b].split()[:6]
        phrase = " ".join(pre + [m.group(0)] + post).strip()
        if phrase and phrase.lower() not in {x["text"].lower() for x in out}:
            out.append({"text": phrase, "kind": "event", "_at": m.start(), "_soft": True})
        ev_end = b
    # proper nouns and unknown acronyms: runs of capitalised tokens not already taken by another kind
    tok_rx = re.compile(r"[A-Za-z0-9][A-Za-z0-9'&.:-]*")
    for sm in re.finditer(r"[^.!?\n]+[.!?]?", t):
        s0, sent = sm.start(), sm.group(0)
        toks = [(s0 + m.start(), s0 + m.end(), m.group(0).rstrip(".'-:")) for m in tok_rx.finditer(sent)]
        runs, cur = [], []
        for i, (a, b, w) in enumerate(toks):
            cap = bool(w) and w[0].isupper() and free(a, a + len(w))
            conn = w.lower() in ("of", "de", "van", "von", "&") and cur
            if cap or conn:
                cur.append((i, a, w))
            else:
                if cur:
                    runs.append(cur)
                cur = []
        if cur:
            runs.append(cur)
        for run in runs:
            while run and run[-1][2].lower() in ("of", "de", "van", "von", "&"):
                run.pop()
            first_in_sentence = bool(run) and run[0][0] == 0
            while run and run[0][2].lower().replace("'s", "") in COMMON:
                run.pop(0)
                first_in_sentence = False
            run = [x for x in run if x[2].upper().replace("'S", "") not in DOMAIN_ACRONYMS]
            if not run:
                continue
            a = run[0][1]
            last = run[-1]
            b = last[1] + len(last[2])
            span = t[a:b]
            if span.lower().endswith("'s"):
                span, b = span[:-2], b - 2
            if span.lower() == seller or re.fullmatch(MONTHS + r"|" + WEEKDAYS + r"|Series [A-Z]", span):
                continue
            follow = t[b:b + 2]
            if first_in_sentence and len(run) == 1 and not (follow.startswith(",") or follow.startswith("'")
                                                            or re.search(r"(?<![.!?]\s)\b%s\b" % re.escape(span), t[b:])):
                continue  # one capitalised word opening a sentence: an ordinary word unless it reads as a name
            take(a, b, "name", span)
    out.sort(key=lambda x: x["_at"])
    seen, res = set(), []
    for x in out:
        k = norm(x["text"])
        if k in seen or not k:
            continue
        seen.add(k)
        res.append({"text": x["text"], "kind": x["kind"]})
    return res


# ---------------- sources ----------------
def _section6():
    try:
        with open(PLAYS_DOC, encoding="utf-8") as f:
            s = f.read()
        a = s.find("## 6.")
        b = s.find("## 7.", a)
        return s[a:b] if a >= 0 else ""
    except OSError:
        return ""


def _safe_get(path):
    try:
        import ari_db
        return ari_db.get(path) or []
    except BaseException:   # db down or a column missing (production before 0046): fewer sources, never a crash
        return []


def gather_sources(pid, rows=None):
    """One text blob of everything written about this person that a draft may lean on, plus the stored list of the draft rows."""
    from urllib.parse import quote
    me = next((r for r in (rows or []) if r.get("id") == pid), None)
    if me is None or "title" not in me:
        got = _safe_get("people?select=*&id=eq.%s" % quote(pid))
        me = dict(got[0]) if got else (me or {})
    parts = [json.dumps({k: v for k, v in me.items() if k not in ("dm", "dm2_text", "dm3_text")}, default=str)]
    # what Owner already sent this person counts as his own words
    for col, sent in (("dm", "dm1_sent"), ("dm2_text", "dm2_sent"), ("dm3_text", "dm3_sent")):
        if me.get(sent) and me.get(col):
            parts.append(me[col])
    acc = me.get("account_id")
    if acc:
        q = quote(str(acc))
        parts += [json.dumps(x, default=str) for x in _safe_get("accounts?select=company,one_liner,hook,hook_date,hook_url,why_thrandvex,domain,meeting_notes,extra&id=eq.%s" % q)]
        parts += [json.dumps(x, default=str) for x in _safe_get("account_briefs?select=thesis,why_now,data_flow,committee,angle,soft_angles&account_id=eq.%s" % q)]
        parts += [json.dumps(x, default=str) for x in _safe_get("research?select=summary,source_url,dated&account_id=eq.%s" % q)]
    p = quote(pid)
    parts += [x.get("body") or "" for x in _safe_get("sent_messages?select=body&person_id=eq.%s" % p)]
    parts += [x.get("snippet") or "" for x in _safe_get("replies?select=snippet&person_id=eq.%s" % p)]
    parts += [x.get("details") or "" for x in _safe_get("queue?select=details&target=eq.%s&action=eq.Chat" % p)]
    if me.get("company"):
        parts += [json.dumps(x, default=str) for x in _safe_get("emails?select=subject,body&company=eq.%s" % quote(me["company"]))]
    prof = os.path.join(ROOT, "work", "profiles", "%s.md" % pid)
    if os.path.exists(prof):
        with open(prof, encoding="utf-8") as f:
            parts.append(f.read())
    stored = _safe_get("queue?select=id,assumptions&target=eq.%s&id=like.AS:*" % p)
    for r in stored:
        for it in r.get("assumptions") or []:
            if isinstance(it, dict) and it.get("status") == "confirmed":
                parts.append(str(it.get("text") or ""))     # Owner confirmed it: a source from now on
    parts.append(_section6())
    return "\n".join(str(x) for x in parts if x), stored


def _num_core(s):
    m = re.search(r"\d[\d,]*(?:\.\d+)?", s)
    return m.group(0).replace(",", "") if m else ""


def _iso_dates(blob):
    out = []
    for m in re.finditer(r"(20\d\d)-(\d\d)-(\d\d)", blob):
        try:
            out.append(dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3))))
        except ValueError:
            pass
    return out


def is_sourced(item, blob, cfg=None, today=None):
    cfg = cfg or _cfg()
    kind, text = item["kind"], item["text"]
    low_blob = blob.lower().replace("\u2019", "'")
    words = set(_words(low_blob))
    if kind == "number":
        core = _num_core(text)
        if core:
            return bool(re.search(r"(?<![\d.])%s(?![\d])" % re.escape(core), low_blob.replace(",", "")))
        return all(w in words for w in _words(text) if len(w) > 3)
    if kind == "date":
        tl = text.lower()
        rel = {"week": 14, "month": 45, "quarter": 100, "year": 370, "yesterday": 3, "recently": 90}
        for k, days in rel.items():
            if k in tl and not re.search(r"\d", tl):
                today = today or dt.date.today()
                return any(0 <= (today - d).days <= days for d in _iso_dates(blob))
        mon = re.search(MONTHS, text, re.I)
        day = re.search(r"\b(\d{1,2})(?:st|nd|rd|th)?\b", text)
        yr = re.search(r"(?:19|20)\d\d", text)
        iso = re.fullmatch(r"(20\d\d)-(\d\d)-(\d\d)", text)
        if iso:
            return text in blob
        if mon:
            mnum = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].index(mon.group(0)[:3].lower()) + 1
            if day and not (yr and day.group(1) == yr.group(0)[2:]):
                d = int(day.group(1))
                if re.search(r"-%02d-%02d\b" % (mnum, d), blob):
                    return True
                return bool(re.search(r"\b%s[a-z]*\.?\s+%d(?:st|nd|rd|th)?\b|\b%d(?:st|nd|rd|th)?\s+%s" % (mon.group(0)[:3], d, d, mon.group(0)[:3]), low_blob, re.I))
            return bool(re.search(r"-%02d-" % mnum, blob) or re.search(r"\b%s" % mon.group(0)[:3].lower(), low_blob))
        if yr:
            return yr.group(0) in blob
        return norm(text) in norm(blob)
    if kind == "title":
        tw = [TITLE_EXPAND.get(w, w) for w in _words(text) if w not in ("of", "for", "and", "&")]
        tw = " ".join(tw).split()
        exp = set(" ".join(TITLE_EXPAND.get(w, w) for w in words).split()) | words
        return all(w in exp for w in tw)
    if kind in ("name", "customer"):
        toks = [w for w in _words(text) if w not in ("of", "de", "van", "von", "&", "the")]
        toks = [w[:-2] if w.endswith("'s") else w for w in toks]
        if kind == "customer" and norm(text) in [c.lower() for c in cfg.get("allowed_customers", [])]:
            return True
        return bool(toks) and all(w in words for w in toks)
    content = [w for w in _words(text) if len(w) >= 4 and w not in STOP]
    if not content:
        return True
    return sum(1 for w in content if w in words) / len(content) >= 0.6


def g12(pid, text, rows=None, blob=None, cfg=None, today=None):
    """Checker items for one draft: every extracted fact with no written source."""
    cfg = cfg or _cfg()
    if blob is None:
        blob, _ = gather_sources(pid, rows)
    allowed = {c.lower() for c in cfg.get("allowed_customers", [])}
    never = (cfg.get("never_name") or {}).get("match", "").lower()
    out = []
    for it in extract(text, cfg):
        low = norm(it["text"])
        if low in allowed or (never and never in low):
            continue    # approved proof is sourced; a never-name is G2's hard fail, not an assumption
        if is_sourced(it, blob, cfg, today):
            continue
        out.append({"id": item_id(it["text"]), "text": it["text"], "kind": it["kind"], "source": "checker", "status": "open"})
    return out


# ---------------- drafter list, union, storage ----------------
def load_drafter(path):
    try:
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError) as e:
        raise SystemExit("assumptions file unreadable: %s" % e)
    if not isinstance(raw, list):
        raise SystemExit("assumptions file must be a JSON list of {text, kind}")
    out = []
    for x in raw:
        if isinstance(x, str):
            x = {"text": x, "kind": "claim"}
        if not isinstance(x, dict) or not str(x.get("text") or "").strip():
            continue
        k = str(x.get("kind") or "claim").lower()
        txt = str(x["text"]).strip()[:200]
        out.append({"id": item_id(txt), "text": txt, "kind": k if k in KINDS else "claim", "source": "drafter", "status": "open"})
    return out


def merge(drafter, checker, previous=None, text=None):
    """Union of the drafter's list and G12's, deduped (same or contained phrase), keeping Owner's earlier decisions."""
    res = []
    for it in list(drafter or []) + list(checker or []):
        k = norm(it["text"])
        dup = next((r for r in res if k == norm(r["text"]) or (len(k) > 2 and k in norm(r["text"])) or (len(norm(r["text"])) > 2 and norm(r["text"]) in k)), None)
        if dup:
            if it["kind"] in HARD and dup["kind"] not in HARD:
                dup["kind"] = it["kind"]          # never let a merge soften an option C hard item
            continue
        res.append(dict(it))
    prev = {p.get("id"): p for p in (previous or []) if isinstance(p, dict)}
    for r in res:
        p = prev.get(r["id"])
        if p and p.get("status") in STATUSES:
            r["status"] = p["status"]
    if text is not None:
        tl = norm(text)
        # a phrase Owner struck or edited out that is back in the draft is open again
        for r in res:
            if r["status"] in ("struck", "edited") and norm(r["text"]) in tl:
                r["status"] = "open"
    ids = {r["id"] for r in res}
    kept = [dict(p) for p in prev.values() if p.get("status") == "confirmed" and p.get("id") not in ids]
    res = res + kept
    opens = [r for r in res if r["status"] == "open"][:MAX_ITEMS - 20]
    rest = [r for r in res if r["status"] != "open"][:MAX_ITEMS - len(opens)]
    order = {id(r): i for i, r in enumerate(res)}
    return sorted(opens + rest, key=lambda r: order[id(r)])


def enabled():
    return os.environ.get("ARI_ASSUMPTIONS_STORE", "").strip().lower() in ("1", "on", "true", "yes")


def row_id(pid, kind):
    return "AS:%s:%s" % (pid, kind)


def store(pid, kind, items):
    """Upsert the draft's list onto its AS row. Returns (stored, message). Never raises."""
    if not enabled():
        return False, "not stored (assumptions are off: ARI_ASSUMPTIONS_STORE is not set)"
    n_open = sum(1 for i in items if i.get("status") == "open")
    row = {"id": row_id(pid, kind), "action": "Draft assumptions", "target": pid, "details": kind, "status": "done",
           "result": "%d to confirm" % n_open, "assumptions": items,
           "created": dt.datetime.now(dt.timezone.utc).isoformat()}
    try:
        import ari_db
        ari_db.request("POST", "queue?on_conflict=id", [row], extra={"Prefer": "resolution=merge-duplicates,return=minimal"})
        return True, "stored %d items (%d to confirm) on %s" % (len(items), n_open, row["id"])
    except BaseException as e:
        return False, "not stored (%s)" % str(e)[:160]


def run(pid, kind, text, rows=None, drafter_path=None, do_store=False):
    """Everything copy_check --g12 needs: (items, store_message)."""
    blob, stored = gather_sources(pid, rows)
    checker = g12(pid, text, rows, blob)
    drafter = load_drafter(drafter_path) if drafter_path else []
    prev = next((r.get("assumptions") for r in stored if r.get("id") == row_id(pid, kind)), None)
    items = merge(drafter, checker, prev, text)
    msg = store(pid, kind, items)[1] if do_store else ""
    return items, msg


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) == 2 and a[0] == "extract":
        with open(a[1], encoding="utf-8") as f:
            print(json.dumps(extract(f.read()), indent=1))
        sys.exit(0)
    print(__doc__)
    sys.exit(2)
