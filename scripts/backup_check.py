# Ari nightly backup check (v18.6; S1 R3 Oct 19 2026). The backup itself runs inside Supabase (edge function ari-backup,
# pg_cron 03:00 IST) and needs nothing from Hark. This reads the result through rpc ari_worker_backup_status (metadata only,
# no rows) with the restricted worker key the sandbox proxy already injects.
#
# S1 R3: the OFF-PROJECT copy is the encrypted export, not the plain copy on ari-staging (that one is slated to stop and
# no longer counts). A night passes only if its encrypted object ari_<stamp>.json.gz.cms exists in bucket ari-offsite,
# its sha256 equals backup_runs.enc_sha256, and its CMS recipients are exactly the certificates in
# native/supabase/offsite/ari-offsite-recipient*.pem (placeholders ignored), so a recipient added or dropped is caught the
# next night. With --drive (needs the google credential for the Drive owner on the shell call) it also checks that the
# Drive folder "Ari backups" holds the same file with the same sha256.
# Exit 0 = newest run finished in the last 26 h, verified, encrypted off-project copy present and matching.
# Exit 1 = not; the reasons are printed in one JSON line.
import sys, os, json, hashlib, datetime, subprocess, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import offsite_certs

BUCKET = 'ari-offsite'
FOLDER = 'Ari backups'
# Recipient certs committed here but not yet in the deployed ari-backup edge function. A night missing one of these is a
# WARNING, not a failure, until the function deploy lands; then delete the name from this set (the check turns strict).
# Owner's cert (added Oct 19 2026) waits for the edge release that deploys native/supabase/functions/ari-backup.
PENDING_IN_FUNCTION = {'ari-offsite-recipient-shal.pem'}


def fetch_offsite(name):
    import ari_db
    req = urllib.request.Request(ari_db.SB_URL + '/storage/v1/object/authenticated/%s/%s' % (BUCKET, name), headers=ari_db.headers())
    try:
        return urllib.request.urlopen(req, timeout=120).read(), None
    except urllib.error.HTTPError as e:
        return None, 'storage %s' % e.code
    except urllib.error.URLError as e:
        return None, 'storage unreachable: %s' % e.reason


def drive_sha(name):
    def gws(*a):
        p = subprocess.run(['gws', *a], capture_output=True, text=True, timeout=110)
        if p.returncode != 0: raise RuntimeError((p.stderr or p.stdout)[:160])
        return json.loads(p.stdout)
    q = "name = '%s' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false" % FOLDER
    folders = gws('drive', 'files', 'list', '--params', json.dumps({'q': q, 'fields': 'files(id)'})).get('files', [])
    if not folders: return None
    files = gws('drive', 'files', 'list', '--params', json.dumps({'q': "'%s' in parents and name = '%s' and trashed = false" % (folders[0]['id'], name),
                                                                  'fields': 'files(id,appProperties)'})).get('files', [])
    return (files[0].get('appProperties') or {}).get('sha256') if files else None


def evaluate(r, now, blob=None, fetch_err=None, drive=None, folder=offsite_certs.OFFSITE, pending=None):
    """Pure check of one backup_runs row plus the fetched encrypted object. Returns (problems, details)."""
    problems, det = [], {}
    pending = PENDING_IN_FUNCTION if pending is None else pending
    fin = r.get('finished_at')
    age_h = (now - datetime.datetime.fromisoformat(fin)).total_seconds() / 3600 if fin else None
    if fin is None: problems.append('newest run has not finished')
    elif age_h > 26: problems.append('newest run is %.0f h old' % age_h)
    if r.get('error'): problems.append('error: ' + str(r['error'])[:160])
    if r.get('verified') is not True: problems.append('restore test failed: ' + json.dumps(r.get('mismatches'))[:160])
    enc, want = r.get('enc_file'), r.get('enc_sha256')
    if not enc or not want:
        problems.append('no encrypted off-project copy recorded for this run')
    elif blob is None:
        problems.append('encrypted copy %s not readable in %s: %s' % (enc, BUCKET, fetch_err))
    else:
        got = hashlib.sha256(blob).hexdigest()
        det['enc_sha256_match'] = got == want
        if got != want: problems.append('encrypted copy sha256 does not match backup_runs.enc_sha256')
        try:
            rc = offsite_certs.check_recipients(blob, folder)
        except ValueError as e:
            rc = {'ok': False, 'error': str(e)}
        waiting = [m for m in rc.get('missing', []) if m in pending]
        if waiting and not rc.get('unknown') and not rc.get('error') and len(waiting) == len(rc.get('missing', [])) and rc.get('recipients'):
            rc = dict(rc, ok=True, waiting_for_function_deploy=waiting)
        stale = [n for n in pending if n not in rc.get('missing', []) and n in [os.path.basename(p) for p in offsite_certs.recipient_files(folder)[0]]]
        if stale and rc.get('ok'):
            rc = dict(rc, note='%s now in the encrypted file: remove from PENDING_IN_FUNCTION' % stale)
        det['recipients'] = rc
        if not rc.get('ok'):
            problems.append('CMS recipients do not match the certificate files: %s' % json.dumps(
                {k: rc.get(k) for k in ('recipients', 'expected', 'missing', 'unknown', 'error') if rc.get(k)})[:240])
    if drive is not None:
        det['drive_sha256_match'] = drive == want
        if drive != want: problems.append('Drive copy of %s missing or sha256 differs' % enc)
    det['staging_copy'] = r.get('offsite')  # informational only since S1 R3; not a backup
    return problems, det


def main(argv):
    from ari_db import rpc
    runs = rpc('ari_worker_backup_status') or []
    if not runs:
        print(json.dumps({'ok': False, 'problems': ['no backup run recorded']})); return 1
    r = runs[0]
    blob, err = fetch_offsite(r['enc_file']) if r.get('enc_file') else (None, 'none recorded')
    drive = None
    if '--drive' in argv:
        try:
            drive = drive_sha(r.get('enc_file') or '') or ''
        except Exception as e:  # report, do not crash the nightly check
            drive = 'error: %s' % str(e)[:80]
    problems, det = evaluate(r, datetime.datetime.now(datetime.timezone.utc), blob, err, drive)
    out = {'ok': not problems, 'file': r.get('file'), 'enc_file': r.get('enc_file'), 'finished_at': r.get('finished_at'),
           'tables': r.get('tables'), 'rows': r.get('rows'), 'verified': r.get('verified'), **det, 'problems': problems}
    print(json.dumps(out))
    return 0 if not problems else 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
