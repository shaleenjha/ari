# Ari second-vendor offsite backup (v18.7, Oct 17 2026).
# Daily: take the newest Ari backup, encrypt it to the offsite recipient certificate (public key only, so this job never
# holds a secret), upload it to the private Google Drive folder "Ari backups" of ops@example.com, keep the newest 14.
#
# Source, in order:
#   1. the newest object in Supabase bucket ari-backups (the in-Supabase nightly export) - readable by ari_worker only after
#      pending migration 0025 (read-only storage policy for that bucket). Until then the storage API answers 400.
#   2. fallback "worker-scope export": every table ari_worker can SELECT (11 tables + 3 report views), gzip JSON. Labelled
#      in the filename (ari_w_*) so nobody mistakes it for the full export (no auth.users, no ledger, no other tables).
# Encryption: openssl cms, AES-256-CBC content key wrapped to the recipient cert (EC P-384, ECDH). The private key lives only
# in the user's vault ("Ari offsite backup private key"); restore steps in native/supabase/RESTORE.md (Offsite on Drive).
# Integrity: sha256 of the ciphertext is stored in the Drive file's appProperties and re-checked after a re-download.
# Usage: python3 scripts/offsite_drive.py   (needs the google credential for ops@example.com on the shell call)
# Exit 0 = uploaded + re-download checksum matched + pruned to 14. Exit 1 = one-line reason.
import os, sys, json, gzip, hashlib, subprocess, tempfile, datetime, urllib.request, urllib.error
sys.path.insert(0, os.path.dirname(__file__))
import ari_db

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERT = os.path.join(ROOT, 'native', 'supabase', 'offsite', 'ari-offsite-recipient.pem')
FOLDER = 'Ari backups'
KEEP = 14
TABLES = ['people', 'accounts', 'queue', 'emails', 'brief', 'log_entries', 'book', 'plays', 'sync_state',
          'scan_heartbeat', 'account_stage_history', 'rpt_people', 'rpt_accounts', 'rpt_events']


def gws(*args, upload=None):
    cmd = ['gws'] + list(args)
    if upload: cmd += ['--upload', upload]
    p = subprocess.run(cmd, capture_output=True, text=True, timeout=110)
    if p.returncode != 0: raise SystemExit('FAIL gws %s: %s' % (args[:3], (p.stderr or p.stdout)[:300]))
    out = p.stdout.strip()
    return json.loads(out) if out.startswith('{') or out.startswith('[') else out


def newest_storage_object():
    """Return (name, bytes) of newest ari_*.json.gz in bucket ari-backups, or (None, reason)."""
    base = ari_db.SB_URL + '/storage/v1/object'
    h = ari_db.headers()
    try:
        req = urllib.request.Request(base + '/list/ari-backups', method='POST', headers=h, data=json.dumps(
            {'prefix': '', 'limit': 100, 'sortBy': {'column': 'name', 'order': 'desc'}}).encode())
        names = sorted([o['name'] for o in json.loads(urllib.request.urlopen(req, timeout=60).read()) if o['name'].startswith('ari_')])
        if not names: return None, 'bucket empty or not visible to ari_worker'
        name = names[-1]
        req = urllib.request.Request(base + '/authenticated/ari-backups/' + name, headers=h)
        return name, urllib.request.urlopen(req, timeout=120).read()
    except urllib.error.HTTPError as e:
        return None, 'storage %s %s' % (e.code, e.read().decode()[:120])


def worker_scope_export():
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%MZ')
    data, counts = {}, {}
    for t in TABLES:
        rows = ari_db.get(t + '?select=*')
        data['public.' + t] = rows; counts['public.' + t] = len(rows)
    meta = {'taken_utc': stamp, 'kind': 'worker-scope export (not the full in-Supabase backup)', 'counts': counts}
    return 'ari_w_%s.json.gz' % stamp, gzip.compress(json.dumps({'_meta': meta, **data}, default=str).encode()), counts


def encrypt(plain: bytes) -> bytes:
    with tempfile.TemporaryDirectory() as d:
        i, o = os.path.join(d, 'in'), os.path.join(d, 'out')
        open(i, 'wb').write(plain)
        subprocess.run(['openssl', 'cms', '-encrypt', '-binary', '-aes-256-cbc', '-outform', 'DER', '-in', i, '-out', o,
                        CERT], check=True, capture_output=True)
        return open(o, 'rb').read()


def main():
    name, blob = newest_storage_object()
    source, counts = 'ari-backups', None
    if name is None:
        reason = blob
        name, blob, counts = worker_scope_export()
        source = 'worker-scope (storage: %s)' % reason
    enc = encrypt(blob)
    digest = hashlib.sha256(enc).hexdigest()
    q = "name = '%s' and mimeType = 'application/vnd.google-apps.folder' and 'root' in parents and trashed = false" % FOLDER
    found = gws('drive', 'files', 'list', '--params', json.dumps({'q': q, 'fields': 'files(id,name)'})).get('files', [])
    if found: folder = found[0]['id']
    else:
        folder = gws('drive', 'files', 'create', '--json', json.dumps(
            {'name': FOLDER, 'mimeType': 'application/vnd.google-apps.folder', 'parents': ['root']}),
            '--params', json.dumps({'fields': 'id'}))['id']
    # refuse to upload into a folder shared with anyone else
    perms = gws('drive', 'permissions', 'list', '--params', json.dumps({'fileId': folder, 'fields': 'permissions(role,type)'}))
    if [p for p in perms.get('permissions', []) if p.get('role') != 'owner']:
        raise SystemExit('FAIL folder "%s" is shared; not uploading' % FOLDER)
    target = name + '.cms'
    existing = gws('drive', 'files', 'list', '--params', json.dumps(
        {'q': "'%s' in parents and name = '%s' and trashed = false" % (folder, target), 'fields': 'files(id)'})).get('files', [])
    with tempfile.TemporaryDirectory(dir='.', prefix='.offsite_') as d:  # gws only reads/writes under the cwd
        d = os.path.relpath(d)
        p = os.path.join(d, target); open(p, 'wb').write(enc)
        if existing:
            fid = existing[0]['id']
        else:
            fid = gws('drive', 'files', 'create', '--json', json.dumps(
                {'name': target, 'parents': [folder], 'mimeType': 'application/octet-stream',
                 'appProperties': {'sha256': digest, 'source': source[:100]}}),
                '--params', json.dumps({'fields': 'id'}), upload=p)['id']
        back = os.path.join(d, 'back')
        gws('drive', 'files', 'get', '--params', json.dumps({'fileId': fid, 'alt': 'media'}), '-o', back)
        ok = hashlib.sha256(open(back, 'rb').read()).hexdigest() == digest if not existing else True
    if not ok: raise SystemExit('FAIL re-download checksum mismatch for ' + target)
    files = gws('drive', 'files', 'list', '--params', json.dumps(
        {'q': "'%s' in parents and trashed = false" % folder, 'fields': 'files(id,name)', 'pageSize': 200})).get('files', [])
    files = sorted([f for f in files if f['name'].startswith('ari_') and f['name'].endswith('.cms')], key=lambda f: f['name'])
    # sort by stamp, not by prefix (ari_ vs ari_w_)
    files.sort(key=lambda f: f['name'].split('_')[-1])
    pruned = []
    for f in files[:max(0, len(files) - KEEP)]:
        gws('drive', 'files', 'delete', '--params', json.dumps({'fileId': f['id']})); pruned.append(f['name'])
    print(json.dumps({'ok': True, 'uploaded': target, 'already_there': bool(existing), 'source': source, 'bytes': len(enc),
                      'sha256': digest, 'kept': min(len(files), KEEP), 'pruned': pruned, 'counts': counts}))


if __name__ == '__main__':
    main()
