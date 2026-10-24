# Ari v18.15.4 (Basalt): signal-scan heartbeat + dead-man check. No migration: rows live in the existing
# key/value table `brief` (role ari_worker has select/insert/update there, migration 0018), one key per book:
#   scan_hb:<book> (one per AE book in scripts/seller_config.py) -> JSON {started_at, finished_at, accounts_processed, errors}
#   scan_hb:armed  -> ISO time the watch was armed, or empty (disarmed: no alerts while the scans are paused)
# Why not scan_runs (0032): ari_worker cannot read it, and its built-in ari_scan_deadman() uses a 25 min miss rule
# meant for a 10 min cadence, so daily scans written there would false-alarm every 12 h.
# usage (shell, project folder):
#   python3 scripts/scan_heartbeat.py start <book>                         first step of a scan task
#   python3 scripts/scan_heartbeat.py finish <book> [--accounts N] [--errors "text"]
#        last step; without --accounts it counts signals/coverage.csv rows of this book with last_checked = run date (IST)
#   python3 scripts/scan_heartbeat.py arm | disarm | status
# The check runs inside scripts/health_check.py (the poller's existing ALERT path): a scan is flagged when its
# Tue to Sat 04:30 IST slot + 45 min passed with no start, it finished with 0 accounts, or it started > 2 h ago and
# never finished. Once per book per slot (state: work/v187/scan_deadman_state.json).
import sys, os, json, csv, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE = os.path.join(ROOT, 'work', 'v187', 'scan_deadman_state.json')
import seller_config
BOOKS = dict(seller_config.load()['aes'])   # book key -> AE full name (private settings; synthetic defaults in the repo)
SLOT_DAYS = (1, 2, 3, 4, 5)          # Tue..Sat (Mon = 0)
SLOT_TIME = (4, 30)
GRACE = dt.timedelta(minutes=45)
STUCK = dt.timedelta(hours=2)
EARLY = dt.timedelta(minutes=60)     # a start up to 60 min before the slot still counts for it

def iso(s):
    if not s: return None
    t = dt.datetime.fromisoformat(str(s).replace('Z', '+00:00'))
    return t if t.tzinfo else t.replace(tzinfo=IST)

def latest_due_slot(now):
    """Most recent scheduled slot whose grace window has passed."""
    d = now.astimezone(IST).date()
    for back in range(0, 8):
        day = d - dt.timedelta(days=back)
        if day.weekday() not in SLOT_DAYS: continue
        s = dt.datetime(day.year, day.month, day.day, *SLOT_TIME, tzinfo=IST)
        if s + GRACE <= now: return s
    return None

def evaluate(now, hbs, armed_from):
    """Pure check. hbs: {book: heartbeat dict or None}. Returns [(book, slot, kind, detail)]."""
    slot = latest_due_slot(now)
    if not armed_from or slot is None or slot < armed_from: return []
    out = []
    for book in BOOKS:
        hb = hbs.get(book) or {}
        st, fin = iso(hb.get('started_at')), iso(hb.get('finished_at'))
        if not st or st < slot - EARLY:
            out.append((book, slot, 'missed', None))
        elif fin:
            if not hb.get('accounts_processed'):
                out.append((book, slot, 'zero', hb.get('errors')))
        elif now - st > STUCK:
            out.append((book, slot, 'stuck', None))
    return out

def message(book, slot, kind, detail):
    when = slot.strftime('%a %d %b') + ' 04:30 run'
    name = BOOKS[book].split()[0]
    if kind == 'missed': return '%s book scan did not start (%s)' % (name, when)
    if kind == 'zero': return '%s book scan finished with 0 accounts checked (%s)%s' % (name, when, (': ' + str(detail)[:80]) if detail else '')
    return '%s book scan started over 2 h ago and never finished (%s)' % (name, when)

def dedupe(findings, state):
    """Keep only findings not alerted before (one alert per book per slot). Mutates state['alerted']."""
    seen = state.setdefault('alerted', [])
    new = []
    for f in findings:
        k = '%s:%s' % (f[0], f[1].isoformat())
        if k in seen: continue
        seen.append(k); new.append(f)
    state['alerted'] = seen[-60:]
    return new

# ---------- storage (brief table through ari_db) ----------
def read_all():
    import ari_db
    rows = ari_db.request('GET', 'brief?select=key,value&key=like.scan_hb:*', timeout=20) or []
    kv = {r['key']: r.get('value') for r in rows}
    hbs = {}
    for b in BOOKS:
        v = kv.get('scan_hb:' + b)
        try: hbs[b] = json.loads(v) if v else None
        except ValueError: hbs[b] = None
    return hbs, iso(kv.get('scan_hb:armed')), kv

def write_key(key, value, kv=None):
    import ari_db
    if kv is None: _, _, kv = read_all()
    if key in kv:
        ari_db.request('PATCH', 'brief?key=eq.' + key, {'value': value}, extra={'Prefer': 'return=minimal'})
    else:
        ari_db.request('POST', 'brief', {'key': key, 'value': value}, extra={'Prefer': 'return=minimal'})

def check_live(now=None, state_path=STATE):
    """Called by health_check.py. Returns alert strings to add to its ALERT line (already deduped)."""
    now = now or dt.datetime.now(dt.timezone.utc)
    hbs, armed, _ = read_all()
    findings = evaluate(now, hbs, armed)
    try: state = json.load(open(state_path))
    except Exception: state = {}
    new = dedupe(findings, state)
    os.makedirs(os.path.dirname(state_path), exist_ok=True)
    json.dump(state, open(state_path, 'w'))
    return [message(*f) for f in new]

def coverage_count(book, day, path=os.path.join(ROOT, 'signals', 'coverage.csv')):
    owner = BOOKS[book]
    try: rows = list(csv.DictReader(open(path)))
    except OSError: return 0
    return sum(1 for r in rows if r.get('owner') == owner and (r.get('last_checked') or '')[:10] == day)

def main(argv):
    cmd = argv[1] if len(argv) > 1 else 'status'
    now = dt.datetime.now(IST).replace(microsecond=0)
    if cmd in ('start', 'finish'):
        book = (argv[2] if len(argv) > 2 else '').lower()
        if book not in BOOKS: print('usage: scan_heartbeat.py %s <%s>' % (cmd, '|'.join(BOOKS))); return 2
        hbs, armed, kv = read_all()
        if cmd == 'start':
            hb = {'started_at': now.isoformat(), 'finished_at': None, 'accounts_processed': None, 'errors': None}
            write_key('scan_hb:' + book, json.dumps(hb), kv)
            if not armed: write_key('scan_hb:armed', now.isoformat(), kv)   # a real start proves scans are back on
        else:
            hb = hbs.get(book) or {'started_at': None}
            args = argv[3:]
            n = int(args[args.index('--accounts') + 1]) if '--accounts' in args else \
                coverage_count(book, (iso(hb.get('started_at')) or now).astimezone(IST).date().isoformat())
            hb.update(finished_at=now.isoformat(), accounts_processed=n,
                      errors=args[args.index('--errors') + 1][:300] if '--errors' in args else None)
            write_key('scan_hb:' + book, json.dumps(hb), kv)
        print('heartbeat %s %s %s' % (cmd, book, json.dumps(hb)))
    elif cmd in ('arm', 'disarm'):
        write_key('scan_hb:armed', now.isoformat() if cmd == 'arm' else '')
        print(cmd + 'ed')
    else:
        hbs, armed, _ = read_all()
        print(json.dumps({'armed_from': armed.isoformat() if armed else None, 'heartbeats': hbs}, indent=1))
    return 0

if __name__ == '__main__': sys.exit(main(sys.argv))
