# Ari restore drill for the in-Supabase backups (v18.6). MAINTENANCE ONLY: needs the Management API token bound,
# which normal Hark runs no longer have. Never run from the worker or a scheduled task.
# usage: python3 scripts/restore_drill.py [object name]   (default: newest object in bucket ari-backups, prod)
# Steps: reads the newest backup object with the project's service key (fetched from the Management API into memory,
# never printed or written), builds the schema in a throwaway local Postgres 17 from the newest pg_dump schema in
# work/backups (or native/supabase/baseline), loads every public table from the JSON with json_populate_recordset, and
# compares row counts with the backup manifest. Result: work/backups/drill_<object>.json (counts only, no rows).
import os, sys, json, glob, gzip, shutil, subprocess, urllib.request
REF = 'rbkrqlzlblquvgmuohro'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'work', 'backups')
BIN = '/usr/lib/postgresql/17/bin'
sys.path.insert(0, os.path.dirname(__file__))
from db_backup import STUB, ensure_pg

def svc_key():
    r = subprocess.run(['curl', '-s', f'https://api.supabase.com/v1/projects/{REF}/api-keys?reveal=true'], capture_output=True, text=True)
    k = json.loads(r.stdout)
    if not isinstance(k, list): raise SystemExit('maintenance token not bound (expected outside maintenance sessions)')
    return [x for x in k if x.get('name') == 'service_role'][0]['api_key']

def http(method, path, key, body=None):
    req = urllib.request.Request(f'https://{REF}.supabase.co/storage/v1/{path}', method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'apikey': key, 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json'})
    # direct (no sandbox proxy): the proxy would swap the Authorization header for the ari_worker key on this host
    with urllib.request.build_opener(urllib.request.ProxyHandler({})).open(req, timeout=120) as r: return r.read()

def main(name=None):
    ensure_pg(); key = svc_key()
    if not name:
        objs = json.loads(http('POST', 'object/list/ari-backups', key, {'prefix': '', 'limit': 1000}))
        name = sorted(o['name'] for o in objs if o['name'].startswith('ari_'))[-1]
    data = json.loads(gzip.decompress(http('GET', f'object/ari-backups/{name}', key)))
    del key
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

if __name__ == '__main__': main(sys.argv[1] if len(sys.argv) > 1 else None)
