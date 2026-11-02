#!/usr/bin/env python3
"""Ingest labels, step 1 (spec docs/specs/09-ingest-labels.md, Owner's decisions Oct 27 2026).

Pure, deterministic code labelers for the eight event types, idempotent event keys, the label checker
(vocabulary + no-PII), and a read-only backfill dry run. Nothing here writes to the Sheet or the database:
the real writes arrive in step 3 through public.ari_worker_event_record (migration 0044).

usage (project folder):
  python3 scripts/ingest_labels.py backfill --dry-run [--out work/ingest_labels] [--no-sheet]
    -> work/ingest_labels/dryrun.jsonl (one would-be app.events row per line) + summary.json, summary printed.
  python3 scripts/ingest_labels.py vocab [--sql] -> the label vocabulary as JSON (0044 embeds the --sql form)
Reads: Supabase as ari_worker (people, accounts, book, log_entries; rpc ari_worker_copy_stats) via scripts/ari_db.py,
signals/log.csv, work/profile_scan/state.json, and the Sheet Log tab row count for a parity line (gws, read-only).
Reply labels: intent / objection_type / sentiment / next_step are left unset with needs_review = true. No model call.
"""
import os, re, sys, json, csv, hashlib, datetime as dt, collections, subprocess
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
SHEET = 'SHEET_ID_PLACEHOLDER'
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
CUTOFF = dt.datetime(2026, 10, 16, tzinfo=IST)   # Owner (Oct 27 2026): rows before Gmail ingest started are approximate
LABEL_VERSION = 1

HOOK_KINDS = ['launch', 'funding', 'hire', 'breach_fine', 'partnership', 'mcp_agent', 'filing', 'post_talk',
              'product_change', 'role_pain', 'peer_move', 'hypothesis', 'personal', 'none']
PERSONAS = ['C-suite/founder', 'Security/legal', 'SE/solutions', 'Sales/rev', 'Product', 'Engineering/data', 'Other']
# Label vocabulary. Types: bool, int, num, date, slug (<= 40 chars, a-z 0-9 space _ -), domain, enum:<values>.
# Every value may also be null (unknown). 0044's validator embeds this exact JSON (test_ingest_labels checks parity).
COMMON = {'persona': 'enum:' + '|'.join(PERSONAS), 'play': 'play', 'tier': 'enum:Target A|Target B|Target C'}
VOCAB = {
    'connect_sent': {'with_note': 'bool', 'note_tag_id': 'int', 'weekday': 'enum:mon|tue|wed|thu|fri|sat|sun', 'hour_local': 'int'},
    'accept': {'days_to_accept': 'num', 'accept_via': 'enum:tap|gmail|list'},
    'dm_sent': {'step': 'enum:1|2|3', 'draft_tag_id': 'int', 'structure': 'slug', 'hook_kind': 'enum:' + '|'.join(HOOK_KINDS),
                'edited': 'bool', 'words_changed': 'int', 'switched': 'bool', 'asset': 'bool', 'days_since_prev': 'num',
                'late_days': 'num', 'profile_scanned': 'bool'},
    'reply': {'reply_to_step': 'enum:0|1|2|3', 'credited_tag_id': 'int', 'days_since_touch': 'num', 'text_available': 'bool',
              'intent': 'enum:interested|meeting|question|referral|not_now|objection|not_interested|unsubscribe|unknown',
              'objection_type': 'enum:has_vendor|build_in_house|no_need|timing|budget|security_review|wrong_person|other',
              'sentiment': 'enum:positive|neutral|negative',
              'next_step': 'enum:book|answer|send_asset|follow_up_later|route_referral|stop'},
    'meeting_booked': {'touches_before': 'int', 'days_from_first_touch': 'num', 'credited_step': 'enum:0|1|2|3',
                       'credited_tag_id': 'int', 'meeting_via': 'enum:reply|ae|calendar'},
    'withdraw': {'days_pending': 'num', 'reason': 'enum:auto_stale|manual'},
    'profile_scan_done': {'outcome': 'enum:scanned|unavailable', 'recent_post': 'bool', 'role_change': 'bool',
                          'owns_problem': 'bool', 'dm1_redrafted': 'bool'},
    'signal_found': {'hook_kind': 'enum:' + '|'.join(HOOK_KINDS), 'signal_age_days': 'num', 'source_domain': 'domain',
                     'used_in_draft': 'bool'},
}
JUDGED = ('intent', 'objection_type', 'sentiment', 'next_step')
EVENT_TYPES = list(VOCAB)


def vocab_json():
    return {t: dict(COMMON, **v) for t, v in VOCAB.items()}


# ---------- small helpers ----------
def ts(v):
    """ISO string (any precision) or datetime -> aware datetime in IST, None for empty."""
    if not v: return None
    d = v if isinstance(v, dt.datetime) else dt.datetime.fromisoformat(str(v).replace('Z', '+00:00'))
    if d.tzinfo is None: d = d.replace(tzinfo=IST)
    return d.astimezone(IST)


def bare_time(d):   # 0028 rule: exactly 00:00 or 12:00 IST means "date only"
    return d is not None and (d.hour, d.minute, d.second, d.microsecond) in ((0, 0, 0, 0), (12, 0, 0, 0))


def approx_of(d, flagged=False):
    return bool(flagged or d is None or bare_time(d) or d < CUTOFF)


def days(a, b):
    return None if a is None or b is None else round((a - b).total_seconds() / 86400, 1)


def persona(title):   # same buckets as retro_stats.py pers()
    t = (title or '').lower()
    if re.search(r'\b(ceo|founder|cto|ciso|cio|chief|president)', t): return 'C-suite/founder'
    if re.search(r'secur|privacy|counsel|compliance|infosec', t): return 'Security/legal'
    if re.search(r'solution|sales eng|pre.?sales|\bse\b|value|implementation|customer eng', t): return 'SE/solutions'
    if re.search(r'sales|revenue|partner|business dev|growth|account|gtm', t): return 'Sales/rev'
    if re.search(r'product|design', t): return 'Product'
    if re.search(r'engineer|architect|infra|platform|data|ai|ml|technolog', t): return 'Engineering/data'
    return 'Other'


def play_of(why):     # same rule as retro_stats.py play()
    m = re.match(r'(Play [A-Z])', why or '')
    return m.group(1) if m else 'other'


def structure_code(s):
    """draft_tags.structure ('f1 the reason i asked', 'ae2 <AE name> style') -> its code ('f1', 'ae2'). The words can
    carry an AE's name, so only the code goes into labels; free text that has no code is slugged and name-checked."""
    m = re.match(r'\s*([a-z]{1,3}\d{1,2})\b', (s or '').lower())
    return m.group(1) if m else slug(s)


def slug(s, n=40):
    s = re.sub(r'[^a-z0-9 _-]+', ' ', (s or '').lower()); s = re.sub(r'\s+', ' ', s).strip()
    return s[:n].strip() or None


def merge_times(cands):
    """cands: [(datetime, approx, ref)]. Earlier non-approx time wins; disagreement (> 1 h) marks it approximate."""
    c = [x for x in cands if x[0] is not None]
    if not c: return None, True, None
    exact = sorted([x for x in c if not x[1]], key=lambda x: x[0])
    pick = exact[0] if exact else sorted(c, key=lambda x: x[0])[0]
    spread = max(x[0] for x in c) - min(x[0] for x in c)
    return pick[0], bool(pick[1] or spread > dt.timedelta(hours=1)), pick[2]


def dedupe_key(event_type, person_id=None, step=None, natural=None, account_id=None):
    """Idempotent key. Natural source key when one exists (Gmail id, signal hash); else one-per-person(-per-step)."""
    if natural: return '%s:%s' % (event_type, natural)
    owner = person_id or ('acct-%s' % account_id if account_id else None)
    if not owner: raise ValueError('event needs a person or an account')
    return ':'.join(str(x) for x in (owner, event_type, step) if x is not None)


# ---------- the checker: vocabulary + no PII ----------
EMAIL = re.compile(r'[\w.+-]+@[\w-]+\.[\w.]+'); URLISH = re.compile(r'https?:|www\.|linkedin|/|@', re.I)
PHONE = re.compile(r'\d{7,}'); KEY_OK = re.compile(r'^[A-Za-z0-9:_.-]{1,120}$')


def _pii(s, names):
    if EMAIL.search(s) or URLISH.search(s) or PHONE.search(s): return 'looks like contact data or a link'
    low = ' %s ' % re.sub(r'[^a-z0-9]+', ' ', s.lower())
    for n in names:
        if ' %s ' % n in low: return 'contains a known name'
    return None


def check_labels(event_type, labels, names=()):
    """Faults for one labels object (empty list = clean). names: lower-case known person/company names and name tokens."""
    if event_type not in VOCAB: return ['unknown event_type']
    voc, out = vocab_json()[event_type], []
    if not isinstance(labels, dict): return ['labels is not an object']
    for k, v in labels.items():
        t = voc.get(k)
        if t is None: out.append('unknown key %s' % k); continue
        if v is None: continue
        if t == 'bool' and not isinstance(v, bool): out.append('%s not bool' % k)
        elif t == 'int' and (isinstance(v, bool) or not isinstance(v, int)): out.append('%s not int' % k)
        elif t == 'num' and (isinstance(v, bool) or not isinstance(v, (int, float))): out.append('%s not a number' % k)
        elif t in ('slug', 'domain', 'play', 'date') or t.startswith('enum:'):
            if not isinstance(v, str): out.append('%s not text' % k); continue
            if len(v) > 40: out.append('%s over 40 chars' % k); continue
            if t.startswith('enum:') and v not in t[5:].split('|'): out.append('%s=%s not in vocabulary' % (k, v)); continue
            if t == 'slug' and not re.fullmatch(r'[a-z0-9 _-]+', v): out.append('%s not a slug' % k); continue
            if t == 'play' and not re.fullmatch(r'Play [A-Z]|other', v): out.append('%s not a play code' % k); continue
            if t == 'date' and not re.fullmatch(r'\d{4}-\d{2}-\d{2}', v): out.append('%s not a date' % k); continue
            if t == 'domain':
                if not re.fullmatch(r'[a-z0-9-]+(\.[a-z0-9-]+)+', v): out.append('%s not a bare domain' % k)
                continue   # a source domain is allowed by spec section 7; it is not a link
            why = _pii(v, names) if t == 'slug' else None
            if why: out.append('%s %s' % (k, why))
    return out


def check_row(row, names=()):
    out = check_labels(row['event_type'], row['labels'], names)
    for f in ('dedupe_key', 'source_ref'):
        if row.get(f) and not KEY_OK.match(row[f]): out.append('%s has characters outside [A-Za-z0-9:_.-]' % f)
    if row.get('person_id') and not re.fullmatch(r'P\d+', row['person_id']): out.append('person_id not a P-id')
    if row['labeled_by'] != 'shal':
        for j in JUDGED:
            if row['labels'].get(j) is not None and row['labeled_by'] == 'code': out.append('code cannot set judged %s' % j)
    return out


# ---------- one event row ----------
def event(event_type, *, person=None, account=None, occurred_at, approx, source, source_ref, labels, ctx,
          step=None, natural=None, labeled_by='code', needs_review=False, confidence=1.0):
    pid = person['id'] if person else None
    acc = account or (ctx['acc'].get(person.get('account_id')) if person else None)
    common = {'persona': persona(person.get('title')) if person else None,
              'play': play_of(person.get('why_this_person')) if person else None,
              'tier': ctx['tier'].get(((acc or {}).get('company') or (person or {}).get('company') or '').strip().lower())}
    return {'event_type': event_type, 'dedupe_key': dedupe_key(event_type, pid, step, natural, (acc or {}).get('id')),
            'person_id': pid, 'account_id': (acc or {}).get('id'), 'ae': (acc or {}).get('ae') or ctx['ae_of'].get((person or {}).get('owner')),
            'occurred_at': occurred_at.isoformat() if occurred_at else None, 'approx': bool(approx), 'source': source,
            'source_ref': source_ref, 'labels': dict(common, **labels), 'label_version': LABEL_VERSION,
            'labeled_by': labeled_by, 'confidence': confidence, 'needs_review': needs_review}


# ---------- labelers (pure: person dict + ctx -> rows) ----------
LOG_TYPE = {'Connect sent': 'connect_sent', 'Accepted': 'accept', 'Accepted via Gmail': 'accept', 'DM1 sent': 'dm_sent',
            'DM2 sent': 'dm_sent', 'DM3 sent': 'dm_sent', 'Replied': 'reply', 'Meeting set': 'meeting_booked', 'Withdrawn': 'withdraw'}


def _cands(p, field, logs):
    out = []
    if p.get(field): d = ts(p[field]); out.append((d, approx_of(d, field in (p.get('ts_approx') or [])), 'people.' + field))
    for r in logs:
        d = ts(r['ts']); out.append((d, approx_of(d), 'log_entries.%s' % r['id']))
    return out


def label_connect_sent(p, ctx, logs):
    if not p.get('connect_sent'): return None
    at, ap, ref = merge_times(_cands(p, 'connect_sent', logs))
    return event('connect_sent', person=p, occurred_at=at, approx=ap, source='people' if ref.startswith('people') else 'log',
                 source_ref=ref, ctx=ctx, labels={'with_note': None, 'note_tag_id': None,
                 'weekday': at.strftime('%a').lower(), 'hour_local': None if ap else at.hour})


def accept_via(p, logs):
    if p.get('accepted_source') == 'gmail': return 'gmail'
    if p.get('accepted_source') == 'manual': return 'tap'
    det = ' '.join((r.get('detail') or '').lower() for r in logs) + ' ' + ' '.join(r['event'].lower() for r in logs)
    if 'gmail' in det: return 'gmail'
    if 'linkedin list' in det: return 'list'
    if any(r.get('source') == 'app' for r in logs): return 'tap'
    return None


def label_accept(p, ctx, logs):
    if not p.get('accepted'): return None
    at, ap, ref = merge_times(_cands(p, 'accepted', logs))
    d = days(at, ts(p.get('connect_sent')))
    if d is not None and d < 0: ctx['anomalies']['accept before connect_sent'].append(p['id']); d = None
    if not p.get('connect_sent'): ctx['anomalies']['accept with no connect_sent on record'].append(p['id'])
    return event('accept', person=p, occurred_at=at, approx=ap, source='people' if ref.startswith('people') else 'log',
                 source_ref=ref, ctx=ctx, labels={'days_to_accept': d, 'accept_via': accept_via(p, logs)})


def switched(logs_switch, step):
    rows = [r for r in logs_switch if (r.get('detail') or '').lower().startswith('dm%d' % step)]
    return None if not rows else 'back' not in (rows[-1].get('detail') or '').lower()


def words_changed(diff):
    if not diff: return 0
    if isinstance(diff, dict) and 'added' in diff: return int(diff.get('added', 0)) + int(diff.get('removed', 0))
    ops = diff.get('ops', diff) if isinstance(diff, dict) else diff
    return sum(len((o.get('t') or '').split()) for o in ops if isinstance(o, dict) and o.get('op') in ('+', '-'))


def label_dm_sent(p, ctx, step, logs, msg, logs_switch):
    f = 'dm%d_sent' % step
    if not p.get(f): return None
    at, ap, ref = merge_times(_cands(p, f, logs))
    prev = ts(p.get('accepted')) if step == 1 else ts(p.get('dm%d_sent' % (step - 1)))
    due = p.get('dm%d_due' % step) if step > 1 else None
    tags = (msg or {}).get('tags') or {}
    scan = ctx['scan']
    labels = {'step': str(step), 'draft_tag_id': None, 'structure': structure_code(tags.get('structure')),
              'hook_kind': tags.get('hook_kind') if tags.get('hook_kind') in HOOK_KINDS else None,
              'edited': None if msg is None else bool(msg.get('edit_diff')),
              'words_changed': None if msg is None else words_changed(msg.get('edit_diff')),
              'switched': switched(logs_switch, step) if logs_switch else (False if msg is not None else None),
              'asset': None, 'days_since_prev': days(at, prev),
              'late_days': (at.date() - dt.date.fromisoformat(str(due)[:10])).days if due else None,
              'profile_scanned': None if scan is None else (step == 1 and p['id'] in scan['done'])}
    src_ref = 'sent_messages.%s' % msg['id'] if msg else ref
    return event('dm_sent', person=p, step=step, occurred_at=at, approx=ap, source='sent_messages' if msg else
                 ('people' if ref.startswith('people') else 'log'), source_ref=src_ref, ctx=ctx, labels=labels)


def last_touch(p, before):
    """(step of the last send before `before`, time of the last touch of any kind). Step 0 = connect / accept only."""
    step, touch = 0, None
    for s, f in ((0, 'connect_sent'), (0, 'accepted'), (1, 'dm1_sent'), (2, 'dm2_sent'), (3, 'dm3_sent')):
        d = ts(p.get(f))
        if d and d <= before:
            if touch is None or d >= touch: touch = d
            if s: step = max(step, s)
    return step, touch


def label_reply(p, ctx, logs):
    if not p.get('replied'): return None
    at, ap, ref = merge_times(_cands(p, 'replied', logs))
    step, touch = last_touch(p, at)
    return event('reply', person=p, natural=None, step='first', occurred_at=at, approx=ap,
                 source='people' if ref.startswith('people') else 'log', source_ref=ref, ctx=ctx,
                 labels={'reply_to_step': str(step), 'credited_tag_id': None, 'days_since_touch': days(at, touch),
                         'text_available': None, **{j: None for j in JUDGED}},
                 needs_review=True, confidence=None)


def label_withdraw(p, ctx, logs):
    if not p.get('withdrawn'): return None
    at, ap, ref = merge_times(_cands(p, 'withdrawn', logs))
    auto = any(re.search(r'auto|stale', (r.get('detail') or ''), re.I) for r in logs)
    return event('withdraw', person=p, occurred_at=at, approx=ap, source='people' if ref.startswith('people') else 'log',
                 source_ref=ref, ctx=ctx, labels={'days_pending': days(at, ts(p.get('connect_sent'))),
                                                  'reason': 'auto_stale' if auto else 'manual'})


def label_meeting(ctx, acc, at, ap, ref, source, people):
    touches = [ts(q.get(f)) for q in people for f in ('dm1_sent', 'dm2_sent', 'dm3_sent') if q.get(f)]
    firsts = [ts(q.get('connect_sent')) for q in people if q.get('connect_sent')]
    steps = [(int(f[2]), ts(q[f])) for q in people for f in ('dm1_sent', 'dm2_sent', 'dm3_sent') if q.get(f) and ts(q[f]) <= at]
    via = {'reply': 'reply', 'ae': 'ae', 'calendar': 'calendar'}.get((acc.get('meeting_source') or '').lower())
    return event('meeting_booked', account=acc, occurred_at=at, approx=ap, source=source, source_ref=ref, ctx=ctx,
                 labels={'touches_before': sum(1 for t in touches if t <= at), 'days_from_first_touch': days(at, min(firsts)) if firsts else None,
                         'credited_step': str(max(steps, key=lambda x: x[1])[0]) if steps else '0', 'credited_tag_id': None,
                         'meeting_via': via})


SIGNAL_KINDS = [('funding', r'raise|raised|funding|series [a-z]|\$\d+m'), ('breach_fine', r'breach|fine|penalt|settle'),
                ('mcp_agent', r'\bagent|mcp|agentic'), ('partnership', r'partner|collab|co-develop|integrat'),
                ('hire', r'hire|appoint|joins|new (cto|ciso|ceo|vp)'), ('filing', r'10-k|s-1|filing|sec '),
                ('launch', r'launch|debut|announce|release|unveil'), ('product_change', r'update|expand|now supports')]


def signal_kind(text):
    t = (text or '').lower()
    for k, rx in SIGNAL_KINDS:
        if re.search(rx, t): return k
    return 'none'


def label_signal(row, ctx):
    acc = ctx['acc_by_name'].get((row.get('company') or '').strip().lower())
    if not acc: return None
    at = dt.datetime.fromisoformat(row['date']).replace(hour=12, tzinfo=IST)
    sd = row.get('signal_date') or ''
    age = (dt.date.fromisoformat(row['date']) - dt.date.fromisoformat(sd)).days if re.fullmatch(r'\d{4}-\d{2}-\d{2}', sd) else None
    dom = (urlparse(row.get('source_url') or '').netloc or '').lower().removeprefix('www.') or None
    h = hashlib.md5(('%s|%s' % (row.get('company', '').strip().lower(), row.get('source_url', ''))).encode()).hexdigest()[:16]
    return event('signal_found', account=acc, natural=h, occurred_at=at, approx=True, source='signals_log',
                 source_ref='signals.%s' % h, ctx=ctx, labels={'hook_kind': signal_kind(row.get('signal')),
                 'signal_age_days': age, 'source_domain': dom, 'used_in_draft': None})


# ---------- backfill ----------
def match_messages(people, messages, anomalies):
    """copy_stats messages carry no person id: match on (step, exact sent time), then company when several share it."""
    idx = collections.defaultdict(list)
    for p in people:
        for s in (1, 2, 3):
            d = ts(p.get('dm%d_sent' % s))
            if d: idx[(s, d)].append(p)
    out = {}
    for m in messages:
        s = int(m['kind'][2]); hits = idx.get((s, ts(m['sent_at'])), [])
        if len(hits) > 1: hits = [p for p in hits if (p.get('company') or '').lower() == (m.get('company') or '').lower()] or hits
        if len(hits) == 1 and (hits[0]['id'], s) not in out: out[(hits[0]['id'], s)] = m
        else: anomalies['sent message not matched to one person'].append('sent_messages.%s' % m['id'])
    return out


def build(ctx):
    """ctx: people, accounts, book, logs, messages, signals, scan (state or None). Returns (rows, unlabeled)."""
    ctx.setdefault('anomalies', collections.defaultdict(list))
    ctx['acc'] = {a['id']: a for a in ctx['accounts'] if not a.get('deleted_at')}
    ctx['acc_by_name'] = {(a.get('company') or '').strip().lower(): a for a in ctx['acc'].values()}
    ctx['tier'] = {(b.get('company') or '').strip().lower(): b.get('tier') for b in ctx['book'] if b.get('tier') in ('Target A', 'Target B', 'Target C')}
    ctx['ae_of'] = {a.get('owner'): a.get('ae') for a in ctx['accounts'] if a.get('owner')}
    live = [p for p in ctx['people'] if not p.get('deleted_at') and p.get('review') != 'personal']
    byid = {p['id']: p for p in ctx['people']}
    logs = collections.defaultdict(list); unl = collections.defaultdict(list); rows = []
    for r in ctx['logs']:
        t = LOG_TYPE.get(r['event'])
        if r['event'] == 'Ari edit switch': logs[(r['person_id'], 'switch')].append(r); continue
        if not t: continue
        if t == 'meeting_booked': logs[(None, 'meeting')].append(r); continue
        p = byid.get(r.get('person_id'))
        if not p: unl['log row with no matching person'].append('log_entries.%s' % r['id']); continue
        if p.get('deleted_at') or p.get('review') == 'personal': unl['personal or deleted person (never labeled)'].append(p['id']); continue
        key = t if t != 'dm_sent' else 'dm%s' % r['event'][2]
        logs[(p['id'], key)].append(r)
    msgs = match_messages(live, ctx['messages'], ctx['anomalies'])
    for p in live:
        g = lambda k: logs.get((p['id'], k), [])
        for t, fn in (('connect_sent', label_connect_sent), ('accept', label_accept), ('reply', label_reply), ('withdraw', label_withdraw)):
            r = fn(p, ctx, g(t))
            if r: rows.append(r)
            elif g(t): unl['%s in Log but the person field is empty' % t].append(p['id'])
        for s in (1, 2, 3):
            r = label_dm_sent(p, ctx, s, g('dm%d' % s), msgs.get((p['id'], s)), g('switch'))
            if r: rows.append(r)
            elif g('dm%d' % s): unl['dm_sent in Log but the person field is empty (undone?)'].append(p['id'])
    # meetings: account meeting fields and the Log's 'Meeting set' rows, one event per account
    meets = {}
    for a in ctx['acc'].values():
        if a.get('meeting_status') or a.get('meeting_date'):
            d = ts(a.get('meeting_date')); meets[a['id']] = [a, [(d, approx_of(d), 'accounts.meeting')] if d else []]
    for r in logs.get((None, 'meeting'), []):
        det = (r.get('detail') or '').lower()
        a = next((a for n, a in sorted(ctx['acc_by_name'].items(), key=lambda x: -len(x[0])) if n and det.startswith(n)), None)
        if not a: unl['meeting row with no matching account'].append('log_entries.%s' % r['id']); continue
        d = ts(r['ts']); meets.setdefault(a['id'], [a, []])[1].append((d, approx_of(d), 'log_entries.%s' % r['id']))
    for aid, (a, cands) in meets.items():
        at, ap, ref = merge_times(cands)
        if at is None: unl['meeting with no date anywhere'].append('acct-' + aid); continue
        if not [p for p in live if p.get('account_id') == aid]: ctx['anomalies']['meeting on an account with no people'].append('acct-' + aid)
        rows.append(label_meeting(ctx, a, at, ap, ref, 'log' if ref.startswith('log') else 'accounts',
                                  [p for p in live if p.get('account_id') == aid]))
    for p in [p for p in live if p.get('meeting')]:
        ctx['anomalies']['person meeting field set (not in backfill yet)'].append(p['id'])
    for r in rows:
        if r['labels'].get('tier') is None and r['event_type'] == 'connect_sent': ctx['anomalies']['connect with no tier (company not in book)'].append(r['person_id'])
    for s in ctx['signals']:
        r = label_signal(s, ctx)
        if r: rows.append(r)
        else: unl['signal for a company with no account'].append('signals:%s' % s.get('date'))
    if ctx['scan']:
        for pid, info in list(ctx['scan'].get('done', {}).items()) + list(ctx['scan'].get('skip', {}).items()):
            p = byid.get(pid)
            if not p: unl['profile scan for unknown person'].append(pid); continue
            done = pid in ctx['scan'].get('done', {}); info = info if isinstance(info, dict) else {}
            at = ts(info.get('at')) if info.get('at') else None
            if at is None: unl['profile scan with no time'].append(pid); continue
            rows.append(event('profile_scan_done', person=p, occurred_at=at, approx=approx_of(at), source='profile_scan',
                              source_ref='profile_scan.state', ctx=ctx, labels={'outcome': 'scanned' if done else 'unavailable',
                              'recent_post': info.get('recent_post'), 'role_change': info.get('role_change'),
                              'owns_problem': info.get('owns_problem'), 'dm1_redrafted': info.get('dm1_redrafted')}))
    return rows, unl


def known_names(ctx):
    out = set()
    for p in ctx['people']:
        n = (p.get('name') or '').lower().strip()
        if n: out.add(re.sub(r'[^a-z0-9]+', ' ', n).strip())
        out.update(w for w in re.split(r'[^a-z0-9]+', n) if len(w) >= 4)
    for a in ctx['accounts']:   # AE first names and owner names count as names too
        for n in (a.get('ae'), a.get('owner')):
            out.update(w for w in re.split(r'[^a-z0-9]+', (n or '').lower()) if len(w) >= 3)
        c = re.sub(r'[^a-z0-9]+', ' ', (a.get('company') or '').lower()).strip()
        if len(c) >= 4: out.add(c)
    return out - {'data', 'health', 'labs', 'group', 'security', 'cloud', 'systems', 'platform', 'other', 'reason', 'asked'}


def summarize(rows, unl, faults, ctx, sheet_log_rows):
    by = collections.Counter(r['event_type'] for r in rows); n = len(rows) or 1
    return {'rows': len(rows), 'by_event_type': dict(by),
            'approx_pct': round(100 * sum(r['approx'] for r in rows) / n, 1),
            'needs_review_pct': round(100 * sum(r['needs_review'] for r in rows) / n, 1),
            'approx_by_type': {t: sum(r['approx'] for r in rows if r['event_type'] == t) for t in by},
            'unlabeled': {k: {'count': len(v), 'refs': v[:25]} for k, v in unl.items()},
            'anomalies': {k: {'count': len(v), 'refs': v[:25]} for k, v in ctx['anomalies'].items()},
            'label_faults': faults[:50], 'label_fault_count': len(faults),
            'duplicate_keys': [k for k, c in collections.Counter((r['event_type'], r['dedupe_key']) for r in rows).items() if c > 1],
            'sources': {'people': len(ctx['people']), 'log_entries': len(ctx['logs']), 'sent_messages': len(ctx['messages']),
                        'signals': len(ctx['signals']), 'profile_scan_state': ctx['scan'] is not None,
                        'sheet_log_rows': sheet_log_rows}}


def load_live():
    sys.path.insert(0, HERE); import ari_db
    P = ari_db.get('people?select=id,account_id,company,owner,name,title,review,deleted_at,why_this_person,ts_approx,accepted_source,'
                   'connect_sent,accepted,dm1_sent,dm2_due,dm2_sent,dm3_due,dm3_sent,replied,meeting,withdrawn')
    A = ari_db.get('accounts?select=id,company,owner,ae,meeting_status,meeting_source,meeting_date,deleted_at')
    B = ari_db.get('book?select=company,tier')
    L = ari_db.get('log_entries?select=id,ts,person_id,event,detail,source&order=id')
    M = (ari_db.rpc('ari_worker_copy_stats', {'p_from': '2026-01-01'}) or {}).get('messages', [])
    for m in M: m.pop('body', None); m.pop('ari_original', None)   # never keep message text in memory longer than needed
    S = list(csv.DictReader(open(os.path.join(ROOT, 'signals', 'log.csv')))) if os.path.exists(os.path.join(ROOT, 'signals', 'log.csv')) else []
    sf = os.path.join(ROOT, 'work', 'profile_scan', 'state.json')
    return {'people': P, 'accounts': A, 'book': B, 'logs': L, 'messages': M, 'signals': S,
            'scan': json.load(open(sf)) if os.path.exists(sf) else None}


def sheet_log_rows():
    try:
        r = subprocess.run(['gws', 'sheets', 'spreadsheets', 'values', 'get', '--params',
                            json.dumps({'spreadsheetId': SHEET, 'range': 'Log!A2:A5000'})], capture_output=True, text=True, timeout=90)
        return len(json.loads(r.stdout).get('values', []))
    except Exception:
        return None


def main(argv):
    if argv[:1] == ['vocab']:   # --sql: the compact one-line JSON 0044's VOCAB block embeds
        print(json.dumps(vocab_json(), sort_keys=True, separators=(',', ':')) if '--sql' in argv else json.dumps(vocab_json(), indent=1)); return 0
    if argv[:1] != ['backfill']: print(__doc__); return 2
    if '--dry-run' not in argv: print('only --dry-run exists in step 1; real writes come in step 3 (event RPC, migration 0044)'); return 2
    out = argv[argv.index('--out') + 1] if '--out' in argv else os.path.join(ROOT, 'work', 'ingest_labels')
    ctx = load_live(); rows, unl = build(ctx); names = known_names(ctx); faults = []
    for r in rows:
        for f in check_row(r, names): faults.append('%s %s: %s' % (r['event_type'], r['dedupe_key'], f))
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, 'dryrun.jsonl'), 'w') as fh:
        for r in sorted(rows, key=lambda r: (r['occurred_at'] or '', r['event_type'], r['dedupe_key'])):
            fh.write(json.dumps(r, sort_keys=True) + '\n')
    s = summarize(rows, unl, faults, ctx, None if '--no-sheet' in argv else sheet_log_rows())
    json.dump(s, open(os.path.join(out, 'summary.json'), 'w'), indent=1)
    print(json.dumps(s, indent=1)); return 1 if faults or s['duplicate_keys'] else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
