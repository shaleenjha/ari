# Ari nightly backup check (v18.6). The backup itself runs inside Supabase (edge function ari-backup, pg_cron 03:00 IST)
# and needs nothing from Hark. This reads the result through rpc ari_worker_backup_status (metadata only, no rows) with
# the restricted worker key the sandbox proxy already injects. Exit 0 = newest run finished in the last 26 h, verified,
# off-project copy written. Exit 1 = not; the reason is printed on one line.
import sys, os, json, datetime
sys.path.insert(0, os.path.dirname(__file__))
from ari_db import rpc

runs = rpc('ari_worker_backup_status') or []
if not runs: print('FAIL no backup run recorded'); sys.exit(1)
r = runs[0]
now = datetime.datetime.now(datetime.timezone.utc)
fin = r.get('finished_at')
age_h = (now - datetime.datetime.fromisoformat(fin)).total_seconds() / 3600 if fin else None
problems = []
if fin is None: problems.append('newest run has not finished')
elif age_h > 26: problems.append('newest run is %.0f h old' % age_h)
if r.get('error'): problems.append('error: ' + str(r['error'])[:160])
if r.get('verified') is not True: problems.append('restore test failed: ' + json.dumps(r.get('mismatches'))[:160])
if r.get('offsite') is not True: problems.append('off-project copy missing: ' + str(r.get('offsite_error'))[:120])
out = {'ok': not problems, 'file': r.get('file'), 'finished_at': fin, 'tables': r.get('tables'), 'rows': r.get('rows'),
       'verified': r.get('verified'), 'offsite': r.get('offsite'), 'problems': problems}
print(json.dumps(out))
sys.exit(0 if not problems else 1)
