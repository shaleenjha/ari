#!/usr/bin/env python3
# Scan controls gate (Owner approved Oct 30 2026 19:24 IST; spec docs/specs/scan_controls.md, migration 0052).
# Each LinkedIn read scan task asks this at start ("should I run?") and reports at the end. Read-only towards LinkedIn:
# it only talks to the database, through scripts/ari_db.py as the restricted worker role (named RPCs, no raw SQL).
#
# usage (shell, project folder; no credentials needed, the proxy injects the worker key):
#   python3 scripts/scan_gate.py check <scan>                   read-only: "RUN <reason>" | "SKIP <reason> [next <HH:MM IST, Day>]"
#   python3 scripts/scan_gate.py start <scan> [--task <id>]     decides and claims: "RUN <run_id> <reason>" | "SKIP <reason> [next ...]"
#   python3 scripts/scan_gate.py finish <run_id> <ok|empty|idle|error|blocked> [--items N] [--note "short text"]
#   python3 scripts/scan_gate.py status                         one line per scan
# <scan> is connections, sent or profile. Exit code is 0 for RUN and SKIP alike; read the first word.
#
# FAIL OPEN, on purpose: before 0052 is applied (or after its rollback) the RPCs do not exist, and the gate answers
# "RUN none no_settings" so every scan behaves exactly as it does today. The same holds when the database cannot be
# reached ("RUN none gate_unreachable"): the scan's own schedule and pacing (profile_scan.py) still bound it.
# finish with run_id "none" records nothing and prints "OK not recorded".
import sys, os, json, datetime as dt
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

SCANS = ('connections', 'sent', 'profile')
RESULTS = ('ok', 'empty', 'idle', 'error', 'blocked')
IST = dt.timezone(dt.timedelta(hours=5, minutes=30))
MISSING_MARKERS = ('PGRST202', '42883', '42P01', 'Could not find the function', 'does not exist')


class Missing(Exception):
    pass


class Unreachable(Exception):
    pass


def _rpc(fn, args):
    """Call one RPC. Missing function/table -> Missing; transport or server trouble -> Unreachable."""
    try:
        import ari_db
    except Exception as e:  # no client in this environment
        raise Unreachable(str(e)[:120])
    try:
        return ari_db.rpc(fn, args, actor='scan_gate')
    except SystemExit as e:  # ari_db raises SystemExit('ERR <code> <path> <body>') on HTTP errors
        msg = str(e)
        if any(m in msg for m in MISSING_MARKERS) or msg.startswith('ERR 404'):
            raise Missing(msg[:160])
        raise Unreachable(msg[:160])
    except Exception as e:
        raise Unreachable(str(e)[:160])


def _when(ts):
    if not ts: return ''
    try:
        t = dt.datetime.fromisoformat(str(ts).replace('Z', '+00:00')).astimezone(IST)
        return ' next ' + t.strftime('%H:%M IST, %a %d %b')
    except Exception:
        return ''


def decision_line(d, claimed=False):
    d = d or {}
    reason = d.get('reason') or 'unknown'
    if d.get('run'):
        if claimed:
            return 'RUN %s %s' % (d.get('run_id', 'none'), reason)
        return 'RUN ' + reason
    if reason == 'no_settings':   # no row for this scan: behave as today
        return ('RUN none no_settings' if claimed else 'RUN no_settings')
    return 'SKIP ' + reason + _when(d.get('next_due'))


def check(scan):
    try:
        return decision_line(_rpc('kyte_worker_scan_check', {'p_scan': scan}))
    except Missing:
        return 'RUN no_settings'
    except Unreachable:
        return 'RUN gate_unreachable'


def start(scan, task=None):
    try:
        return decision_line(_rpc('kyte_worker_scan_start', {'p_scan': scan, 'p_task': task}), claimed=True)
    except Missing:
        return 'RUN none no_settings'
    except Unreachable:
        return 'RUN none gate_unreachable'


def finish(run_id, result, items=None, note=None):
    if result not in RESULTS:
        return 'ERR result must be one of ' + ', '.join(RESULTS)
    if run_id in ('none', '', None):
        return 'OK not recorded'
    try:
        rid = int(run_id)
    except ValueError:
        return 'ERR run_id must be a number or none'
    note = (note or '').strip()[:200] or None
    try:
        r = _rpc('kyte_worker_scan_finish', {'p_run': rid, 'p_result': result, 'p_items': items, 'p_note': note}) or {}
    except Missing:
        return 'OK not recorded'
    except Unreachable as e:
        return 'WARN not recorded (%s)' % str(e)[:80]
    return 'OK recorded' if r.get('ok') else 'OK already finished'


def status():
    out = []
    for s in SCANS:
        out.append('%s: %s' % (s, check(s)))
    return '\n'.join(out)


def _opt(args, name, default=None):
    if name in args:
        i = args.index(name)
        if i + 1 < len(args):
            v = args[i + 1]; del args[i:i + 2]; return v
    return default


def main(argv):
    args = list(argv[1:])
    if not args:
        print(__doc__ or 'usage: scan_gate.py check|start|finish|status'); return 2
    cmd = args.pop(0)
    task = _opt(args, '--task'); items = _opt(args, '--items'); note = _opt(args, '--note')
    if cmd in ('check', 'start'):
        if not args or args[0] not in SCANS:
            print('ERR scan must be one of ' + ', '.join(SCANS)); return 2
        print(check(args[0]) if cmd == 'check' else start(args[0], task)); return 0
    if cmd == 'finish':
        if len(args) < 2:
            print('ERR usage: finish <run_id> <result> [--items N] [--note text]'); return 2
        try:
            n = int(items) if items is not None else None
        except ValueError:
            print('ERR --items must be a number'); return 2
        line = finish(args[0], args[1], n, note); print(line)
        return 2 if line.startswith('ERR') else 0
    if cmd == 'status':
        print(status()); return 0
    print('ERR unknown command ' + cmd); return 2


if __name__ == '__main__':
    sys.exit(main(sys.argv))
