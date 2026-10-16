# Ari nightly backup (fix #2, Oct 16 2026): pg_dump of the "ari" Supabase database (schema public, schema + data)
# into work/backups/ari_<UTC stamp>.dump (custom format) plus a manifest with exact row counts per table.
# No stored DB password: each run gives the dedicated role ari_backup (read-only: pg_read_all_data + BYPASSRLS so pg_dump sees every row)
# a fresh random password through the Supabase Management API (PAT injected by the Hark proxy), dumps, then sets the role NOLOGIN again.
# usage: python3 scripts/db_backup.py            -> dump + manifest, keeps the newest 14 dumps
#        python3 scripts/db_backup.py restore-test [dump]  -> restore into a throwaway local Postgres 17 and compare row counts
# Needs /usr/lib/postgresql/17/bin (sudo apt-get install -y postgresql-17 on a fresh sandbox; the script installs it if missing).
import os, sys, json, glob, secrets, subprocess, datetime, time, shutil
REF = 'rbkrqlzlblquvgmuohro'
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT = os.path.join(ROOT, 'work', 'backups')
BIN = '/usr/lib/postgresql/17/bin'
HOST, PORT = 'aws-0-ap-south-1.pooler.supabase.com', '5432'  # Supavisor session mode
KEEP = 14

def mgmt(sql):
    r = subprocess.run(['curl', '-s', '-X', 'POST', f'https://api.supabase.com/v1/projects/{REF}/database/query',
                        '-H', 'Content-Type: application/json', '--data', json.dumps({'query': sql})], capture_output=True, text=True)
    try: d = json.loads(r.stdout)
    except Exception: raise SystemExit('mgmt api: ' + r.stdout[:500])
    if isinstance(d, dict) and d.get('message'): raise SystemExit('mgmt api: ' + d['message'][:500])
    return d

def ensure_pg():
    if os.path.exists(BIN + '/pg_dump'): return
    subprocess.run('sudo apt-get update -q >/dev/null 2>&1; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q postgresql-17 >/dev/null 2>&1', shell=True)
    if not os.path.exists(BIN + '/pg_dump'): raise SystemExit('could not install postgresql-17')

COUNT_SQL = ("select string_agg(format('select %L t, count(*) n from public.%I', c.relname, c.relname), ' union all ' order by c.relname) q "
             "from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')")

def remote_counts():
    q = mgmt(COUNT_SQL)[0]['q']
    return {r['t']: int(r['n']) for r in mgmt(q)}

def dump():
    ensure_pg(); os.makedirs(OUT, exist_ok=True); os.chmod(OUT, 0o700)
    stamp = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None).strftime('%Y%m%d_%H%MZ')
    f = os.path.join(OUT, f'ari_{stamp}.dump')
    pw = secrets.token_urlsafe(32)
    mgmt("do $$ begin if not exists (select 1 from pg_roles where rolname = 'ari_backup') then create role ari_backup nologin; end if; end $$; "
         "grant pg_read_all_data to ari_backup; "
         f"alter role ari_backup login bypassrls connection limit 2 valid until '{(datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)+datetime.timedelta(minutes=30)).isoformat()}Z' password '{pw}';")
    try:
        time.sleep(2)
        before = remote_counts()
        env = dict(os.environ, PGPASSWORD=pw, PGSSLMODE='require', PGCONNECT_TIMEOUT='20')
        r = None
        for attempt in range(3):
            r = subprocess.run([BIN + '/pg_dump', '-h', HOST, '-p', PORT, '-U', f'ari_backup.{REF}', '-d', 'postgres', '-n', 'public',
                                '-Fc', '-Z', '6', '--no-owner', '--no-privileges', '-f', f], env=env, capture_output=True, text=True, timeout=600)
            if r.returncode == 0: break
            time.sleep(5 * (attempt + 1))
        if r.returncode != 0: raise SystemExit('pg_dump failed: ' + r.stderr[-800:])
        after = remote_counts()
    finally:
        mgmt("alter role ari_backup nologin password null;")
    os.chmod(f, 0o600)
    man = {'file': os.path.basename(f), 'taken_utc': stamp, 'bytes': os.path.getsize(f), 'schema': 'public',
           'counts_before': before, 'counts_after': after,
           'changed_during_dump': sorted(t for t in after if after.get(t) != before.get(t))}
    json.dump(man, open(f[:-5] + '.json', 'w'), indent=1); os.chmod(f[:-5] + '.json', 0o600)
    dumps = sorted(glob.glob(os.path.join(OUT, 'ari_*.dump')))
    for old in dumps[:-KEEP]:
        for p in (old, old[:-5] + '.json'):
            try: os.remove(p)
            except FileNotFoundError: pass
    print(json.dumps({'ok': True, 'file': f, 'bytes': man['bytes'], 'tables': len(after), 'rows': sum(after.values()), 'changed_during_dump': man['changed_during_dump'], 'kept': min(len(dumps), KEEP)}))
    return f

STUB = """
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls; create role authenticator nologin;
create role supabase_admin nologin; create role supabase_realtime_admin nologin; create role dashboard_user nologin; create role pgsodium_keyiduser nologin;
create schema if not exists auth; create schema if not exists extensions; create schema if not exists realtime; create schema if not exists vault;
create schema if not exists net; create schema if not exists pgmq; create schema if not exists cron;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.role() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
create or replace function auth.email() returns text language sql stable as $$ select nullif(current_setting('request.jwt.claim.email', true), '') $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
create table if not exists auth.users (id uuid primary key, email text);
create extension if not exists pgcrypto schema extensions; create extension if not exists "uuid-ossp" schema extensions; create extension if not exists pg_trgm schema extensions;
"""

def restore_test(f=None):
    ensure_pg()
    f = f or sorted(glob.glob(os.path.join(OUT, 'ari_*.dump')))[-1]
    man = json.load(open(f[:-5] + '.json'))
    d = '/tmp/ari_restore_pg'; shutil.rmtree(d, ignore_errors=True)
    run = lambda *a, **k: subprocess.run(list(a), capture_output=True, text=True, **k)
    r = run(BIN + '/initdb', '-D', d, '-U', 'postgres', '--auth=trust')
    if r.returncode: raise SystemExit('initdb: ' + r.stderr[-400:])
    r = run(BIN + '/pg_ctl', '-D', d, '-o', '-k /tmp -p 54331 -c listen_addresses=', '-l', '/tmp/ari_restore_pg.log', '-w', 'start')
    if r.returncode: raise SystemExit('pg_ctl: ' + r.stderr[-400:])
    try:
        psql = lambda sql: run(BIN + '/psql', '-h', '/tmp', '-p', '54331', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=0', '-Atc', sql)
        psql(STUB)
        r = run(BIN + '/pg_restore', '-h', '/tmp', '-p', '54331', '-U', 'postgres', '-d', 'postgres', '--no-owner', '--no-privileges', f)
        errs = [l for l in r.stderr.splitlines() if 'error' in l.lower()]
        q = psql(COUNT_SQL).stdout.strip()
        local = {}
        for line in psql(q).stdout.strip().splitlines():
            t, n = line.split('|'); local[t] = int(n)
        exp = man['counts_after']
        cmp = {t: {'remote': exp.get(t), 'restored': local.get(t)} for t in sorted(set(exp) | set(local))}
        bad = {t: v for t, v in cmp.items() if v['remote'] != v['restored'] and t not in man.get('changed_during_dump', [])}
        res = {'dump': os.path.basename(f), 'tables_remote': len(exp), 'tables_restored': len(local), 'rows_remote': sum(exp.values()),
               'rows_restored': sum(local.values()), 'mismatches': bad, 'restore_errors': errs[:15], 'per_table': cmp}
        out = f[:-5] + '.restore.json'; json.dump(res, open(out, 'w'), indent=1); os.chmod(out, 0o600)
        print(json.dumps({k: res[k] for k in res if k != 'per_table'}, indent=1))
        return res
    finally:
        run(BIN + '/pg_ctl', '-D', d, '-m', 'fast', 'stop'); shutil.rmtree(d, ignore_errors=True)

if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'restore-test': restore_test(sys.argv[2] if len(sys.argv) > 2 else None)
    else: dump()
