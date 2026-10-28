# Ari v18.11.2 (Council ship gate fix #1, Sat 17 Oct 2026): keep Owner's one-tap SWITCHES out of the copy loop's "edits".
# Why: v18.11 saves a switch through the same setFields path as an edit, so the 0031 people trigger records it in
# draft_edits / copy_guidance (original = Ari's pick, edited = the alternative), and a switched send is credited to the
# pick's structure unless a role=alt draft_tags row matched the exact sent text. This module fixes it on the READ side
# (no migration, no app change): brief_upsert.py guidance, draft_tag.py stats and phase0_metrics.py all pass through it.
#
# Where the alternatives come from (all readable by the restricted worker role, or local files):
#   1. people.notes V line  "Ari's pick (dm2): ... Switch to F2 New chapter: "<text>""   (same parser as the app, pick.js)
#   2. work/copylab/alts/<person_id>_<kind>.json  {"pick":{"structure","text"},"switch":{"structure","label","text"}}
#   3. draft_tags rows with variant "role=alt;of=<pick>" (the worker role cannot read draft_tags; only used when a caller
#      passes rows in, and indirectly through copy stats, whose sent tags carry variant role=alt when the exact text matched)
#   4. log_entries event "Ari edit switch", detail "dm2 · F1 > F2[ · back| · asset]" (person + kind + time; no text)
# Rules:
#   guidance pair whose "after" equals a known alternative (whitespace-normalised, as ari_draft_md5)      -> dropped (switch)
#   guidance pair edited from the alternative (closer to the alt than to "before", alt known)            -> kept, rebased:
#                                                                                                          before := alt
#   guidance pair with no alt text known but a switch log for that company + kind from 2 min before
#   its created_at up to 7 days after                                                                    -> dropped (switch, text unknown)
#   sent DM whose tags.variant is role=alt, or whose body equals a known alt                             -> switched, structure = alt,
#                                                                                                          not counted as edited
#   sent DM edited from the alt (closer to alt than to Ari's original)                                   -> switched + edited, structure = alt
#   sent DM with Ari's original but no alt text known, last switch log before the send pointing away from
#   the pick                                                                                             -> switched, structure = logged id
# Pure functions take plain lists so tests run on synthetic data (work/v18112/test_copy_switch.py).
import os, re, json, glob, difflib, datetime, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)
ALTS_DIR = os.path.join(PROJECT, 'work', 'copylab', 'alts')
NAMES = {'S1': 'Observation only', 'S2': 'Confirm or correct', 'S3': 'Poke the bear', 'S4': 'Peer pattern', 'S5': 'The give',
         'S6': 'Who owns this', 'S7': 'Practitioner question', 'S8': 'Their words back', 'S9': 'Shared ground', 'S10': 'Plain truth',
         'S11': "Their buyer's question", 'S12': 'New in seat', 'F1': 'The reason I asked', 'F2': 'New chapter', 'F3': 'Give, no ask',
         'F4': 'Change the person', 'F5': 'Graceful close', 'X0': 'Current shape', 'EX': 'Exec note'}
ID_RE = r'(S1[0-2]|S[1-9]|F[1-5]|X0|EX)'
LOG_EVENT = 'Ari edit switch'
LOG_BEFORE_S, LOG_AFTER_DAYS = 120, 7

def norm(s):  # = app norm() and the whitespace part of ari_draft_md5
    return re.sub(r'\s+', ' ', str(s or '').strip())

def ck(company):
    return norm(company).lower()

def struct_name(sid):
    sid = (sid or '').upper()
    return (sid + (' ' + NAMES[sid] if sid in NAMES else '')).lower() if sid else ''

def sid_of(structure):
    m = re.match(r'\s*' + ID_RE + r'\b', str(structure or ''), re.I)
    return m.group(1).upper() if m else ''

def sim(a, b):
    return difflib.SequenceMatcher(None, norm(a).split(), norm(b).split()).ratio()

def ts(v):
    if isinstance(v, datetime.datetime): d = v
    else:
        s = str(v or '').strip().replace(' ', 'T', 1)
        if not s: return None
        if s.endswith('Z'): s = s[:-1] + '+00:00'
        s = re.sub(r'([+-]\d\d)$', r'\1:00', s)
        try: d = datetime.datetime.fromisoformat(s)
        except ValueError:
            try: d = datetime.datetime.fromisoformat(s[:10])
            except ValueError: return None
    return d if d.tzinfo else d.replace(tzinfo=datetime.timezone.utc)

# ---------- sources ----------
def _segs(n):
    return [x.strip() for x in re.split(r'\s+\|\s+|\n+', str(n or '')) if x.strip()]

def _unq(s):
    s = str(s or '').strip()
    m = re.match(r'^["\u201c](.*)["\u201d]$', s, re.S)
    return m.group(1).strip() if m else s

def from_notes(notes):
    """{kind: {pick_id, alt_id, alt_text}} from a person's V notes (port of pick.js fromNotes)."""
    out = {}
    for s in _segs(notes):
        t = s.replace('\u2019', "'")
        m = re.match(r"^Ari's pick \((dm[123])\):\s*(.*)$", t, re.I | re.S)
        if not m: continue
        k, rest = m.group(1).lower(), m.group(2)
        sw = re.search(r'Switch to\s', rest, re.I)
        head = rest if not sw else rest[:sw.start()]
        pm = re.search(r'\b' + ID_RE + r'\b', re.sub(r'\bP\d+\b', '', head))
        e = {'pick_id': pm.group(1).upper() if pm else ''}
        if sw:
            a = re.match(r'^Switch to\s+' + ID_RE + r'\b([^:"\u201c]*):\s*(["\u201c][\s\S]*["\u201d])\s*$', rest[sw.start():], re.I)
            if a: e['alt_id'], e['alt_text'] = a.group(1).upper(), _unq(a.group(3))
        out[k] = e
    return out

def build_alts(people=(), alt_files=(), tag_rows=()):
    """(person_id, kind) -> {company, alt_text, alt_id, alt_structure, pick_text, pick_id, src}. Later sources fill gaps only;
    a draft_tags role=alt row (the stored, authoritative text) overrides the V notes / file text."""
    comp = {p.get('id'): p.get('company') for p in people}
    A = {}
    def put(pid, kind, src, alt_text, alt_id='', alt_structure='', pick_text='', pick_id='', override=False):
        if not pid or not kind or not norm(alt_text): return
        key = (pid, kind)
        e = A.setdefault(key, {'company': comp.get(pid, ''), 'texts': set()})
        e['texts'].add(norm(alt_text))
        if override or not e.get('alt_text'):
            e.update({'alt_text': alt_text, 'src': src})
            if alt_id: e['alt_id'] = alt_id
            if alt_structure: e['alt_structure'] = alt_structure
        if alt_id and not e.get('alt_id'): e['alt_id'] = alt_id
        if pick_text and not e.get('pick_text'): e['pick_text'] = pick_text
        if pick_id and not e.get('pick_id'): e['pick_id'] = pick_id
    for p in people:
        for k, e in from_notes(p.get('notes')).items():
            if e.get('alt_text'): put(p.get('id'), k, 'notes', e['alt_text'], e.get('alt_id', ''), pick_id=e.get('pick_id', ''))
    for f in alt_files:
        pid, kind, d = f['person_id'], f['kind'], f['data']
        sw, pk = d.get('switch') or {}, d.get('pick') or {}
        aid = sid_of(sw.get('structure'))
        put(pid, kind, 'file', sw.get('text'), aid, (aid + ' ' + sw['label']).lower() if aid and sw.get('label') else '',
            pk.get('text', ''), sid_of(pk.get('structure')))
    for r in tag_rows:
        if re.match(r'^\s*role=alt', str(r.get('variant') or ''), re.I):
            put(r.get('person_id'), r.get('kind'), 'draft_tags', r.get('body'), sid_of(r.get('structure')), norm(r.get('structure')).lower(),
                override=True)
    for e in A.values():
        if not e.get('alt_structure'): e['alt_structure'] = struct_name(e.get('alt_id'))
    return A

def parse_logs(rows, people=()):
    """'Ari edit switch' rows -> [{person_id, company, kind, from, to, back, ts}] oldest first."""
    comp = {p.get('id'): p.get('company') for p in people}
    out = []
    for r in rows:
        if r.get('event') not in (None, LOG_EVENT): continue
        m = re.match(r'^\s*(dm[123])\s*\u00b7\s*(\S+)\s*>\s*(\S+)(.*)$', str(r.get('detail') or ''), re.I)
        if not m: continue
        out.append({'person_id': r.get('person_id'), 'company': comp.get(r.get('person_id'), ''), 'kind': m.group(1).lower(),
                    'from': m.group(2).upper().strip('?'), 'to': m.group(3).upper().strip('?'), 'back': 'back' in m.group(4).lower(), 'ts': ts(r.get('ts'))})
    return sorted(out, key=lambda x: x['ts'] or datetime.datetime.min.replace(tzinfo=datetime.timezone.utc))

def _cands(alts, company, kind, person_id=None):
    if person_id: return [e for (p, k), e in alts.items() if p == person_id and k == kind]
    c = ck(company)
    return [e for (p, k), e in alts.items() if k == kind and c and ck(e.get('company')) == c]

def _match_alt(alts, company, kind, text, person_id=None):
    n = norm(text)
    for e in _cands(alts, company, kind, person_id):
        if n in e['texts']: return e
    for (p, k), e in alts.items():  # exact text is decisive even if the company string differs
        if k == kind and n in e['texts']: return e
    return None

# ---------- 1. copy guidance ----------
def filter_guidance(rows, alts, logs):
    """-> (kept rows, dropped [{company, kind, created_at, reason}]); kept rows keep the RPC's shape, rebased ones get
    'rebased_from': 'switch'."""
    kept, dropped = [], []
    for r in rows:
        kind, co, after, before = r.get('kind'), r.get('company'), r.get('after'), r.get('before')
        if _match_alt(alts, co, kind, after):
            dropped.append({'company': co, 'kind': kind, 'created_at': r.get('created_at'), 'reason': 'after = stored alternative (switch)'}); continue
        cs = _cands(alts, co, kind)
        reb = None
        for e in cs:
            if norm(e['alt_text']) != norm(before) and sim(after, e['alt_text']) > sim(after, before) and sim(after, e['alt_text']) >= 0.5:
                reb = e; break
        if reb:
            r2 = dict(r); r2['before'] = reb['alt_text']; r2['rebased_from'] = 'switch'; kept.append(r2); continue
        if not cs:
            t0 = ts(r.get('created_at'))
            hit = t0 and any(l['kind'] == kind and ck(l['company']) == ck(co) and ck(co) and not l['back'] and l['ts']
                             and t0 - datetime.timedelta(seconds=LOG_BEFORE_S) <= l['ts'] <= t0 + datetime.timedelta(days=LOG_AFTER_DAYS)
                             for l in logs)
            if hit:
                dropped.append({'company': co, 'kind': kind, 'created_at': r.get('created_at'), 'reason': 'switch log near the edit, alternative text unknown'}); continue
        kept.append(r)
    return kept, dropped

# ---------- 2. copy stats ----------
def _agg(msgs, key):
    out = {}
    for m in msgs:
        k = (m.get('tags') or {}).get(key) or 'untagged'
        c = out.setdefault(k, {'sent': 0, 'replied': 0})
        c['sent'] += 1; c['replied'] += 1 if m.get('replied') else 0
    return out

def fix_stats(stats, alts, logs):
    """Re-attribute switched sends in an ari_worker_copy_stats result. Adds per-message 'switched', 'switch_src',
    'edited'; recomputes edited / by_structure / by_hook_kind; adds 'switched' count, 'by_structure_switched' and keeps the
    database's numbers as 'raw_edited' / 'raw_by_structure'."""
    s = dict(stats or {})
    msgs = []
    for m0 in s.get('messages') or []:
        m = dict(m0); m['tags'] = dict(m0.get('tags') or {}) if m0.get('tags') else m0.get('tags')
        kind, co, body, orig = m.get('kind'), m.get('company'), m.get('body'), m.get('ari_original')
        tags = m['tags'] or {}
        sw, src, edited, e = False, '', bool(orig), None
        if re.match(r'^\s*role=alt', str(tags.get('variant') or ''), re.I):
            sw, src, edited = True, 'tag role=alt', False
        else:
            e = _match_alt(alts, co, kind, body)
            if e:
                sw, src, edited = True, 'body = alternative (' + e.get('src', '') + ')', False
            elif orig:
                for e2 in _cands(alts, co, kind):
                    if sim(body, e2['alt_text']) > sim(body, orig) and sim(body, e2['alt_text']) >= 0.5:
                        e, sw, src = e2, True, 'edited from alternative'; break
                if not sw and not _cands(alts, co, kind):
                    st = ts(m.get('sent_at'))
                    L = [l for l in logs if l['kind'] == kind and ck(l['company']) == ck(co) and ck(co) and l['ts'] and st and l['ts'] <= st]
                    if L and not L[-1]['back'] and L[-1]['to'] and L[-1]['to'] != sid_of(tags.get('structure')):
                        sw, src = True, 'switch log ' + L[-1]['from'] + ' > ' + L[-1]['to']
                        e = {'alt_structure': struct_name(L[-1]['to'])}
                        edited = None  # unknown: alt text not stored, so a pure switch and a switch + edit look the same
            if sw and e and m['tags'] is not None and e.get('alt_structure'):
                m['tags']['pick_structure'] = tags.get('structure')
                m['tags']['structure'] = e['alt_structure']
        m['switched'], m['switch_src'], m['edited'] = sw, src, edited
        msgs.append(m)
    s['raw_edited'], s['raw_by_structure'] = s.get('edited'), s.get('by_structure')
    s['messages'] = msgs
    s['switched'] = sum(1 for m in msgs if m['switched'])
    s['edited'] = sum(1 for m in msgs if m['edited'])
    s['edited_unknown'] = sum(1 for m in msgs if m['edited'] is None)
    s['by_structure'] = _agg(msgs, 'structure')
    s['by_hook_kind'] = _agg(msgs, 'hook_kind')
    s['by_structure_switched'] = _agg([m for m in msgs if m['switched']], 'structure')
    s['switch_note'] = 'v18.11.2: sends that went out as the one-tap alternative are credited to the alternative structure and not counted as edits; raw_* are the database numbers'
    return s

def filter_metric_edits(edits, alts, logs):
    """phase0 edit distance: ari_worker_metrics edits {kind, ae, before, after, at}; no company, so exact alt text only."""
    out = []
    for e in edits:
        if any(k == e.get('kind') and norm(e.get('after')) in a['texts'] for (p, k), a in alts.items()): continue
        out.append(e)
    return out

# ---------- live loading (restricted worker role, read-only) ----------
def load_alt_files(d=ALTS_DIR):
    out = []
    for f in sorted(glob.glob(os.path.join(d, '*.json'))):
        m = re.match(r'^(.+)_(dm[123])\.json$', os.path.basename(f))
        if not m: continue
        try: out.append({'person_id': m.group(1), 'kind': m.group(2), 'data': json.load(open(f))})
        except Exception: pass
    return out

def load_live():
    """-> (alts, logs, people) from the database (worker role reads only) + local alt files."""
    from ari_db import get
    people = get('people?select=id,company,notes&deleted_at=is.null&order=id')
    logs = get('log_entries?select=ts,person_id,event,detail&event=eq.' + urllib.parse.quote(LOG_EVENT) + '&order=ts.asc')
    return build_alts(people, load_alt_files()), parse_logs(logs, people), people
