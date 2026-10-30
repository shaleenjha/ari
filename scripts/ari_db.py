# Kyte v18.5: the worker's only database client. PostgREST with named RPCs and table reads; no raw SQL.
# In Hark the sandbox proxy injects "Authorization: Bearer <ari_worker JWT>" for the ari project host (binding
# "supabase-ari-bearer", vault "ari worker key (role ari_worker)"). Role ari_worker can run only the functions and
# table operations granted in native/supabase/migrations/0018_least_privilege_worker.sql.
# Outside Hark / tests: ARI_SB_URL, ARI_SB_APIKEY (publishable key) and ARI_SB_JWT_FILE (a file holding the JWT).
# S1 R7 (design D): with ARI_WORKER_BROKER=1 the bearer comes from scripts/ari_token.py (1-hour ES256 token from the
# ari-worker-token broker, cached in the token file) and a 401 re-fetches it once. Off by default: behaviour unchanged.
import os, json, time, urllib.request, urllib.error
import ari_token
SB_URL = os.environ.get('ARI_SB_URL') or 'https://rbkrqlzlblquvgmuohro.supabase.co'
SB_PUBLISHABLE = os.environ.get('ARI_SB_APIKEY') or 'sb_publishable_jC4J7_kj6zUiAB6_zs6_NQ_6D1gMVxl'

def headers(actor='hark', extra=None, force=False):
    h = {'apikey': SB_PUBLISHABLE, 'Content-Type': 'application/json', 'x-ari-actor': actor}
    if ari_token.enabled():
        h.update(ari_token.auth_header(force=force))
    else:
        f = os.environ.get('ARI_SB_JWT_FILE')
        if f: h['Authorization'] = 'Bearer ' + open(f).read().strip()
    if extra: h.update(extra)
    return h

def request(method, path, body=None, actor='hark', extra=None, timeout=60):
    data = json.dumps(body).encode() if body is not None else None
    refetched = False
    attempt = 0
    while attempt < 3:
        req = urllib.request.Request(SB_URL + '/rest/v1/' + path, data=data, method=method, headers=headers(actor, extra))
        try:
            with _open(req, timeout=timeout) as r:
                t = r.read().decode()
                return json.loads(t) if t else None
        except urllib.error.HTTPError as e:
            msg = e.read().decode()[:800]
            if e.code == 401 and ari_token.enabled() and not refetched:
                refetched = True
                ari_token.bearer(force=True)   # R7: token expired or revoked mid-run: one fresh token, one retry
                continue
            if e.code >= 500 and attempt < 2: attempt += 1; time.sleep(2 * attempt); continue
            raise SystemExit('ERR %s %s %s' % (e.code, path.split('?')[0], msg))
        except urllib.error.URLError:
            if attempt < 2: attempt += 1; time.sleep(2 * attempt); continue
            raise

def _open(req, timeout):  # seam for tests
    return urllib.request.urlopen(req, timeout=timeout)

def rpc(fn, args=None, actor='hark'):
    return request('POST', 'rpc/' + fn, args or {}, actor)

def get(path, actor='hark'):
    out, off = [], 0
    sep = '&' if '?' in path else '?'
    while True:
        page = request('GET', path + sep + 'limit=1000&offset=%d' % off, actor=actor) or []
        out += page
        if len(page) < 1000: return out
        off += 1000
