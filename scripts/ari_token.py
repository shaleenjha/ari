#!/usr/bin/env python3
"""ari_token.py: the worker's 1-hour database token from the ari-worker-token broker (S1 R7, design D).

OFF BY DEFAULT. Nothing changes until R7 step c switches it on, by EITHER the flag file work/state/ari_worker_broker.on
(no scheduled task edit needed; undo = delete the file) OR env ARI_WORKER_BROKER=1. Env ARI_WORKER_BROKER=0 forces it off.
While it is off, ari_db.py, daily_report.py, sync_sheet_supabase.py, backup_check.py and offsite_drive.py behave exactly as
before (the proxy injects the static token).

When ON:
- bearer() returns a cached token from the token file while it has more than MIN_LEFT seconds left; otherwise it asks the
  broker for a new one (POST https://<ref>.functions.supabase.co/ari-worker-token), checks its shape and writes it to the
  token file (0600, atomic rename, file lock so two scripts never fetch at once).
- bearer(force=True) is the 401 re-fetch: ari_db.request calls it once when PostgREST answers 401.
- The broker caller secret is never read here. In Hark the proxy injects header x-ari-worker-caller on the functions host
  only. Outside Hark / tests: ARI_WORKER_CALLER_FILE (a file holding the caller secret).
- One retry on a network error or 5xx. A refusal (403: kill switch, out of window, rate cap) is final for this run: the
  broker has already logged it and pushed a generic alert to Owner.

Env: ARI_WORKER_BROKER=1, ARI_SB_URL (project URL; broker host is derived from its ref), ARI_BROKER_URL (override),
ARI_SB_JWT_FILE (token file; default work/state/ari_worker_token.jwt), ARI_WORKER_CALLER_FILE (outside Hark only).
CLI: python3 scripts/ari_token.py ensure   -> prints "token ok, N min left" (never the token itself)
     python3 scripts/ari_token.py ensure --whoami   -> also asks the database (rpc/ari_worker_whoami, through the proxy)
       which token it really received: prints role / sub / has_session / ttl; with env ARI_WORKER_UID set, exit 1 unless
       sub = ARI_WORKER_UID and has_session is true (runbook step c PASS)
"""
import base64, json, os, re, sys, tempfile, time, urllib.error, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FILE = os.path.join(ROOT, 'work', 'state', 'ari_worker_token.jwt')
FLAG_FILE = os.path.join(ROOT, 'work', 'state', 'ari_worker_broker.on')
MIN_LEFT = 600            # refetch when fewer than 10 minutes are left
EXPECT_ROLE = 'ari_worker'
EXPECT_TTL = 3600         # the broker only hands out 1-hour tokens
TIMEOUT = 20


class BrokerError(SystemExit):
    """Raised as SystemExit so a worker script stops the same way ari_db stops on an HTTP error."""


def enabled():
    v = os.environ.get('ARI_WORKER_BROKER')
    if v in ('0', '1'):
        return v == '1'
    return os.path.exists(FLAG_FILE)


def token_file():
    return os.environ.get('ARI_SB_JWT_FILE') or DEFAULT_FILE


def broker_url():
    if os.environ.get('ARI_BROKER_URL'):
        return os.environ['ARI_BROKER_URL']
    sb = os.environ.get('ARI_SB_URL') or 'https://rbkrqlzlblquvgmuohro.supabase.co'
    m = re.match(r'https://([a-z0-9]{20})\.supabase\.co/?$', sb)
    if not m:
        raise BrokerError('ERR broker: cannot derive the functions host from ARI_SB_URL; set ARI_BROKER_URL')
    return 'https://%s.functions.supabase.co/ari-worker-token' % m.group(1)


def _b64json(part):
    return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))


def claims(tok):
    """Header and payload of a JWT, unverified (PostgREST verifies; this only checks shape and expiry)."""
    parts = (tok or '').strip().split('.')
    if len(parts) != 3:
        raise ValueError('not a JWT')
    return _b64json(parts[0]), _b64json(parts[1])


def check(tok, now=None):
    """Seconds left on a broker token, or ValueError if it is not one (wrong alg, role, lifetime, or expired)."""
    now = time.time() if now is None else now
    h, p = claims(tok)
    if h.get('alg') != 'ES256':
        raise ValueError('alg %s, expected ES256' % h.get('alg'))
    if p.get('role') != EXPECT_ROLE:
        raise ValueError('role %s, expected %s' % (p.get('role'), EXPECT_ROLE))
    try:
        exp, iat = int(p.get('exp') or 0), int(p.get('iat') or 0)
    except (TypeError, ValueError):
        raise ValueError('bad exp/iat claim')
    if exp - iat > EXPECT_TTL + 60:
        raise ValueError('lifetime %ss, expected <= %ss' % (exp - iat, EXPECT_TTL))
    if exp <= now:
        raise ValueError('expired')
    return exp - now


def _read_cached():
    try:
        with open(token_file()) as f:
            return f.read().strip()
    except OSError:
        return ''


def _write(tok):
    path = token_file()
    d = os.path.dirname(path)
    os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.tok.')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(tok)
        os.replace(tmp, path)
    except BaseException:
        try: os.unlink(tmp)
        except OSError: pass
        raise


def _headers():
    h = {'Content-Type': 'application/json', 'x-ari-actor': 'worker'}
    cf = os.environ.get('ARI_WORKER_CALLER_FILE')
    if cf:  # outside Hark only; in Hark the proxy injects this header on the functions host
        with open(cf) as f:
            h['x-ari-worker-caller'] = f.read().strip()
    return h


def _fetch(opener=None, sleep=time.sleep):
    url = broker_url()
    op = opener or urllib.request.urlopen
    last = None
    for attempt in range(2):  # one retry
        req = urllib.request.Request(url, data=b'{}', method='POST', headers=_headers())
        try:
            with op(req, timeout=TIMEOUT) as r:
                body = json.loads(r.read().decode() or '{}')
            tok = body.get('access_token') or ''
            check(tok)
            return tok
        except urllib.error.HTTPError as e:
            msg = ''
            try: msg = e.read().decode()[:200]
            except Exception: pass
            if e.code >= 500 and attempt == 0:
                last = 'HTTP %s' % e.code; sleep(2); continue
            raise BrokerError('ERR broker %s %s' % (e.code, msg))
        except (urllib.error.URLError, OSError) as e:
            last = str(getattr(e, 'reason', e))[:120]
            if attempt == 0:
                sleep(2); continue
        except ValueError as e:
            raise BrokerError('ERR broker returned a bad token: %s' % e)
    raise BrokerError('ERR broker unreachable: %s' % last)


class _Lock:
    def __init__(self, path):
        self.path = path + '.lock'
        self.f = None

    def __enter__(self):
        import fcntl
        os.makedirs(os.path.dirname(self.path), exist_ok=True)
        self.f = open(self.path, 'w')
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        import fcntl
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def bearer(force=False, opener=None, now=None, sleep=time.sleep):
    """A valid worker token (string). force=True skips the cache (the 401 re-fetch)."""
    if not force:
        tok = _read_cached()
        try:
            if tok and check(tok, now) > MIN_LEFT:
                return tok
        except ValueError:
            pass
    with _Lock(token_file()):
        if not force:  # another script may have refreshed it while we waited for the lock
            tok = _read_cached()
            try:
                if tok and check(tok, now) > MIN_LEFT:
                    return tok
            except ValueError:
                pass
        tok = _fetch(opener, sleep)
        _write(tok)
        return tok


def auth_header(force=False):
    """{'Authorization': 'Bearer ...'} when the broker is on; {} when it is off (unchanged behaviour)."""
    if not enabled():
        return {}
    return {'Authorization': 'Bearer ' + bearer(force=force)}


def whoami():
    """What the database saw: {'role', 'sub', 'has_session', 'ttl'} (claims only, never the token)."""
    import ari_db
    return ari_db.rpc('ari_worker_whoami', actor='worker') or {}


def main(argv):
    if argv[1:] not in (['ensure'], ['ensure', '--whoami']):
        print('usage: python3 scripts/ari_token.py ensure [--whoami]'); return 2
    if not enabled():
        print('broker off (no flag file, ARI_WORKER_BROKER not 1): nothing to do')
    else:
        left = check(bearer())
        print('token ok, %d min left' % (left // 60))
    if '--whoami' not in argv:
        return 0
    w = whoami()
    print('whoami: role=%s sub=%s has_session=%s ttl=%s' % (w.get('role'), w.get('sub'), w.get('has_session'), w.get('ttl')))
    uid = os.environ.get('ARI_WORKER_UID')
    if uid:
        ok = w.get('sub') == uid and w.get('has_session') is True
        print('step c: %s' % ('PASS (the database received the broker token)' if ok else 'FAIL (not the broker token)'))
        return 0 if ok else 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
