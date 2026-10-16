# Ari data hygiene (board #31): the worker runs Ari's own checks. Flags only; it never edits, merges or links.
# usage: python3 scripts/hygiene_scan.py [--dry]     (role ari_worker via scripts/ari_db.py; needs migration 0029)
#   1. rpc ari_hygiene_scan()   -> upserts findings (accept_no_connect, duplicate_account, no_account_link,
#                                  stale_stage, dm1_past_due), closes ones whose problem is gone
#   2. rpc ari_worker_hygiene() -> summary; prints one line, exit 0. Fixes are one-tap user actions in the app.
# Before 0029 is applied the RPC 404s: the script says so and exits 0 (so the sync task never fails on it).
import sys, json, os
sys.path.insert(0, os.path.dirname(__file__))
import ari_db

LABEL = {'accept_no_connect': 'accepted without a connect tick', 'duplicate_account': 'possible duplicate accounts',
         'no_account_link': 'people with no account', 'stale_stage': 'stages behind the facts', 'dm1_past_due': 'DM1s past due'}

def summary_line(s):
    o = (s or {}).get('open') or {}
    parts = [f"{o[k]} {LABEL[k]}" for k in LABEL if o.get(k)]
    return 'hygiene: ' + ('; '.join(parts) if parts else 'clean') + f" (last scan {s.get('last_scan') or 'never'})"

def main(dry=False):
    try:
        if not dry: ari_db.rpc('ari_hygiene_scan', actor='ari-hygiene')
        s = ari_db.rpc('ari_worker_hygiene', actor='ari-hygiene')
    except SystemExit as e:
        if 'ERR 404' in str(e) or 'PGRST202' in str(e):
            print('hygiene: migration 0029 not applied yet, skipped'); return 0
        raise
    print(summary_line(s)); return 0

if __name__ == '__main__': sys.exit(main('--dry' in sys.argv))
