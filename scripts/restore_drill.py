# Kyte restore drill for the in-Supabase backups (v18.6; .cms support S1 R3, Oct 19 2026).
# usage:
#   python3 scripts/restore_drill.py [object]                 MAINTENANCE ONLY (ARI_MAINT=1 + Management token): newest object
#                                                             in bucket ari-backups, or the named one; a name ending .cms is read
#                                                             from bucket ari-offsite and decrypted (needs --key)
#   python3 scripts/restore_drill.py --file F [--key K]       a local copy, e.g. the Drive file: F is .json.gz or .json.gz.cms
# --key K (or env ARI_OFFSITE_KEY_FILE): path to ONE recipient's private key (PEM, chmod 600): the Hark vault key or Owner's.
# The key is only passed to openssl; it is never printed, copied or written. Shred it afterwards (RESTORE.md).
# Steps: builds the schema in a throwaway local Postgres 17 from the newest pg_dump schema in work/backups (or
# native/supabase/baseline), loads every public table from the JSON with json_populate_recordset, and compares row counts
# with the backup. Result: work/backups/drill_<object>.json (counts only, no rows).
import os, sys, json, glob, gzip, shutil, subprocess, urllib.request
REF = os.environ.get('ARI_PROJECT_REF') or 'rbkrqlzlblquvgmuohro'  # R7 staging drill: ARI_PROJECT_REF=ljojwhnfgfreokqspobg
# v18.7.1: maintenance-only. Refuses to touch the Management API unless a maintenance session opts in explicitly
# (ARI_MAINT=1) with a fresh short-lived token. No scheduled or worker run sets it.
# --file mode reads a local copy and needs no token, so it is allowed outside maintenance sessions.
if __name__ == '__main__' and '--file' not in sys.argv and os.environ.get('ARI_MAINT') != '1':
    raise SystemExit('maintenance only: set ARI_MAINT=1 in a maintenance session with a fresh short-lived token (or use --file)')
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'work', 'backups')
BIN = '/usr/lib/postgresql/17/bin'
sys.path.insert(0, os.path.dirname(__file__))
from db_backup import STUB, ensure_pg
import offsite_certs

MAINT_KEY = os.environ.get('ARI_MAINT_KEY_NAME') or 'ari_maint'

def pick_key(keys, name=MAINT_KEY, allow_legacy=False):
    """S1 R7: the named secret key (default ari_maint, type secret), never the legacy service_role JWT unless
    ARI_ALLOW_LEGACY_KEY=1 (only until R7 step b creates ari_maint)."""
    if not isinstance(keys, list): raise SystemExit('maintenance token not bound (expected outside maintenance sessions)')
    for x in keys:
        if x.get('type') == 'secret' and x.get('name') == name and str(x.get('api_key', '')).startswith('sb_secret_'):
            return x['api_key']
    if allow_legacy:
        for x in keys:
            if x.get('name') == 'service_role' and x.get('api_key'): return x['api_key']
    raise SystemExit('no secret key named %s (create it in R7 step b, or set ARI_ALLOW_LEGACY_KEY=1 before the disable)' % name)

def svc_key():
    r = subprocess.run(['curl', '-s', f'https://api.supabase.com/v1/projects/{REF}/api-keys?reveal=true'], capture_output=True, text=True)
    return pick_key(json.loads(r.stdout), allow_legacy=os.environ.get('ARI_ALLOW_LEGACY_KEY') == '1')

def key_headers(key):
    # an sb_secret_ key is not a JWT: apikey header only (the gateway mints the internal token). The legacy JWT keeps Bearer.
    h = {'apikey': key, 'Content-Type': 'application/json'}
    if not key.startswith('sb_secret_'): h['Authorization'] = 'Bearer ' + key
    return h

def http(method, path, key, body=None):
    req = urllib.request.Request(f'https://{REF}.supabase.co/storage/v1/{path}', method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=key_headers(key))
    # direct (no sandbox proxy): the proxy would swap the Authorization header for the ari_worker key on this host
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=120) as r: return r.read()

def load(raw, name, key_file):
    """Backup bytes -> dict. A .cms object is decrypted with one recipient's private key first."""
    if name.endswith('.cms'):
        if not key_file: raise SystemExit('%s is encrypted: pass --key <private key file> (or ARI_OFFSITE_KEY_FILE)' % name)
        raw = offsite_certs.decrypt(raw, key_file)
        name = name[:-4]
    return json.loads(gzip.decompress(raw)), name

def fetch(name):
    key = svc_key()
    try:
        bucket = 'ari-offsite' if (name or '').endswith('.cms') else 'ari-backups'
        if not name:
            objs = json.loads(http('POST', 'object/list/ari-backups', key, {'prefix': '', 'limit': 1000}))
            name = sorted(o['name'] for o in objs if o['name'].startswith('ari_'))[-1]
        return http('GET', f'object/{bucket}/{name}', key), name
    finally:
        del key

def main(name=None, file=None, key_file=None):
    ensure_pg()
    raw, name = (open(file, 'rb').read(), os.path.basename(file)) if file else fetch(name)
    data, name = load(raw, name, key_file)
    dumps = sorted(glob.glob(os.path.join(OUT, 'ari_*.dump')))
    d = '/tmp/ari_drill_pg'; shutil.rmtree(d, ignore_errors=True)
    run = lambda *a: subprocess.run(list(a), capture_output=True, text=True)
    run(BIN + '/initdb', '-D', d, '-U', 'postgres', '--auth=trust')
    run(BIN + '/pg_ctl', '-D', d, '-o', '-k /tmp -p 54332 -c listen_addresses=', '-l', '/tmp/ari_drill_pg.log', '-w', 'start')
    psql = lambda sql, inp=None: subprocess.run([BIN + '/psql', '-h', '/tmp', '-p', '54332', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=0', '-c', sql] if inp is None else
                                                [BIN + '/psql', '-h', '/tmp', '-p', '54332', '-U', 'postgres', '-d', 'postgres', '-Atq', '-v', 'ON_ERROR_STOP=0'], input=inp, capture_output=True, text=True)
    try:
        psql(STUB)
        if dumps:  # schema from the newest pg_dump
            r = run(BIN + '/pg_restore', '-h', '/tmp', '-p', '54332', '-U', 'postgres', '-d', 'postgres', '--schema-only', '--no-owner', '--no-privileges', dumps[-1])
        psql("alter table if exists public.backup_runs owner to postgres")
        psql("create table if not exists public.backup_runs (id bigserial primary key, started_at timestamptz, finished_at timestamptz, file text, bytes int, sha256 text, tables int, rows int, counts jsonb, verified boolean, mismatches jsonb, offsite boolean, offsite_error text, error text)")
        psql("set session_replication_role = replica")
        res = {}
        for k, rows in data.items():
            if not k.startswith('public.'): continue
            t = k.split('.', 1)[1]
            body = json.dumps(rows).replace('$ari$', '')
            cols = psql(f"select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='{t}' and is_generated='NEVER'").stdout.strip()
            # generated columns are recomputed; identity ids keep their backed-up values (OVERRIDING SYSTEM VALUE)
            r = psql(None, f"set session_replication_role = replica; insert into public.\"{t}\" ({cols}) overriding system value select {cols} from json_populate_recordset(null::public.\"{t}\", $ari${body}$ari$::json);")
            n = psql(f'select count(*) from public."{t}"').stdout.strip()
            res[k] = {'backup': len(rows), 'restored': int(n) if n.isdigit() else None, 'err': (r.stderr.strip()[:160] or None)}
        bad = {k: v for k, v in res.items() if v['backup'] != v['restored']}
        out = {'object': name, 'schema_from': os.path.basename(dumps[-1]) if dumps else None, 'tables': len(res),
               'rows_backup': sum(v['backup'] for v in res.values()), 'rows_restored': sum((v['restored'] or 0) for v in res.values()),
               'mismatches': bad, 'auth_users_in_backup': len(data.get('auth.users', [])), 'auth_identities_in_backup': len(data.get('auth.identities', [])),
               'ledger_rows_in_backup': len(data.get('supabase_migrations.schema_migrations', []))}
        f = os.path.join(OUT, 'drill_' + name.replace('.json.gz', '') + '.json'); json.dump(out, open(f, 'w'), indent=1); os.chmod(f, 0o600)
        print(json.dumps(out, indent=1))
    finally:
        run(BIN + '/pg_ctl', '-D', d, '-m', 'fast', 'stop'); shutil.rmtree(d, ignore_errors=True)

if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('object', nargs='?'); ap.add_argument('--file'); ap.add_argument('--key', default=os.environ.get('ARI_OFFSITE_KEY_FILE'))
    a = ap.parse_args()
    main(a.object, a.file, a.key)
