# Kyte health check (v18.7). Runs after every scheduled sync (task 56e17ef1). Prints nothing when healthy.
# Prints ONE line starting "ALERT:" when a problem is new or was last raised more than 12 h ago:
#   scan heartbeat stale (> 40 min since the last completed sync), newest nightly backup failed / older than 26 h,
#   or (once migration 0026 is applied) pushes failing. State in work/v187/health_state.json.
#   v18.15.4: plus signal scans that missed their slot, found 0 accounts or got stuck (scripts/scan_heartbeat.py).
# After 0026 the database also sends its own push (pg_cron ari-health-alert); this line is the fallback in Hark chat.
import os, sys, json, datetime
sys.path.insert(0, os.path.dirname(__file__))
import ari_db
STATE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'work', 'v187', 'health_state.json')
now = datetime.datetime.now(datetime.timezone.utc)
iso = lambda s: datetime.datetime.fromisoformat(s.replace('Z', '+00:00')) if s else None
problems = {}
try:
    h = ari_db.request('POST', 'rpc/ari_worker_health', {}, timeout=20)
except SystemExit:
    h = None   # 0026 not applied yet
if h:
    if h.get('scan_stale'): problems['scan'] = 'scans paused (%s min since last sync)' % h.get('scan_age_min')
    if not h.get('backup_ok'): problems['backup'] = 'nightly backup did not finish cleanly'
    if (h.get('push_failed_24h') or 0) > 0: problems['push'] = '%s push(es) failed in 24 h' % h['push_failed_24h']
    if h.get('deadman'): problems['deadman'] = 'scan dead-man'   # 0032: a scheduled scan stopped or keeps coming back empty
else:
    hb = (ari_db.get('scan_heartbeat?select=last_scan_at') or [{}])[0]
    t = iso(hb.get('last_scan_at'))
    if not t or (now - t).total_seconds() > 40 * 60:
        problems['scan'] = 'scans paused (%s min since last sync)' % (int((now - t).total_seconds() / 60) if t else '?')
    runs = ari_db.rpc('ari_worker_backup_status') or []
    r = runs[0] if runs else {}
    f = iso(r.get('finished_at'))
    if not f or (now - f).total_seconds() > 26 * 3600 or r.get('verified') is not True or r.get('error'):
        problems['backup'] = 'nightly backup did not finish cleanly'
# Stall alarm (Owner, 27 Oct 2026): worker_precheck.py records each run's line in work/state/precheck_history.json.
# The same WORK line (unchanged counts) on the last 3+ worker runs spanning 20+ min means the worker is not doing
# the work it is woken for. Raised once (re-armed when the line changes or goes IDLE, else at most every 12 h).
try:
    _h = json.load(open(os.path.join(os.path.dirname(STATE), '..', 'state', 'precheck_history.json')))
    _last = _h[-1]['line'] if _h else ''
    _same = 0
    for _e in reversed(_h):
        if _e['line'] != _last: break
        _same += 1
    if _last.startswith('WORK') and _same >= 3:
        _span = (now - iso(_h[-_same]['at'])).total_seconds() / 60
        if _span >= 20:
            problems['stall'] = 'worker stalled: the same work has been pending for %d runs (%d min), %s' % (_same, _span, _last[6:][:160])
except Exception as e:
    print('stall check skipped: %s' % str(e)[:120], file=sys.stderr)
try: state = json.load(open(STATE))
except Exception: state = {}
fire = [k for k in problems if k not in state or (now - iso(state[k])).total_seconds() > 12 * 3600]
for k in list(state):
    if k not in problems: del state[k]          # recovered: re-arm
for k in fire: state[k] = now.isoformat()
os.makedirs(os.path.dirname(STATE), exist_ok=True)
json.dump(state, open(STATE, 'w'))
try:                                           # v18.15.4: signal-scan dead-man, deduped per book per slot inside
    import scan_heartbeat; dm = scan_heartbeat.check_live(now)
except BaseException as e: dm = []; print('scan dead-man check skipped: %s' % str(e)[:120], file=sys.stderr)
parts = [problems[k] for k in fire] + dm
if parts: print('ALERT: Ari ' + '; '.join(parts))
