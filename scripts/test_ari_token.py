#!/usr/bin/env python3
"""S1 R7: worker token fetch, cache and 401 re-fetch (scripts/ari_token.py + ari_db / sync / daily_report wiring).
Offline: every HTTP call is mocked. Synthetic tokens only (unsigned; nothing here verifies signatures)."""
import base64, io, json, os, sys, tempfile, time, unittest, urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ari_token as T

NOW = 1_800_000_000


def b64(o):
    return base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip('=')


def tok(alg='ES256', role='ari_worker', iat=NOW, ttl=3600, tag='a'):
    return '%s.%s.sig%s' % (b64({'alg': alg, 'kid': 'k1'}), b64({'role': role, 'iat': iat, 'exp': iat + ttl, 'sub': 'u'}), tag)


class Resp(io.BytesIO):
    def __init__(self, body, status=200):
        super().__init__(json.dumps(body).encode() if not isinstance(body, bytes) else body); self.status = status
    def __enter__(self): return self
    def __exit__(self, *a): self.close()


def http_error(code, body=b'{}'):
    return urllib.error.HTTPError('u', code, 'x', {}, io.BytesIO(body))


class Broker:
    """Scripted broker: a list of results (token string, HTTPError, URLError)."""
    def __init__(self, *results):
        self.results, self.calls = list(results), []
    def __call__(self, req, timeout=None):
        self.calls.append(req)
        r = self.results.pop(0)
        if isinstance(r, BaseException): raise r
        return Resp({'access_token': r, 'expires_at': NOW + 3600})


class Base(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp()
        self.env = mock.patch.dict(os.environ, {'ARI_WORKER_BROKER': '1', 'ARI_SB_JWT_FILE': os.path.join(self.d, 'state', 'tok.jwt'),
                                                'ARI_SB_URL': 'https://abcdefghijklmnopqrst.supabase.co'}, clear=False)
        self.env.start()
        for k in ('ARI_BROKER_URL', 'ARI_WORKER_CALLER_FILE'): os.environ.pop(k, None)
    def tearDown(self):
        self.env.stop()


class TestCheck(Base):
    def test_good(self):
        self.assertEqual(T.check(tok(), now=NOW), 3600)
    def test_rejects_hs256_wrong_role_long_and_expired(self):
        for t in (tok(alg='HS256'), tok(role='authenticated'), tok(role='service_role'), tok(ttl=86400), 'x.y'):
            with self.assertRaises(ValueError): T.check(t, now=NOW)
        with self.assertRaises(ValueError): T.check(tok(), now=NOW + 3601)


class TestBearer(Base):
    def test_off_means_no_header_and_no_call(self):
        os.environ['ARI_WORKER_BROKER'] = '0'
        self.assertEqual(T.auth_header(), {})
        self.assertFalse(T.enabled())

    def test_flag_file_switch(self):
        flag = os.path.join(self.d, 'broker.on')
        with mock.patch.object(T, 'FLAG_FILE', flag):
            os.environ.pop('ARI_WORKER_BROKER')
            self.assertFalse(T.enabled())
            open(flag, 'w').close()
            self.assertTrue(T.enabled())
            os.environ['ARI_WORKER_BROKER'] = '0'   # env 0 beats the file (emergency off)
            self.assertFalse(T.enabled())

    def test_broker_url_from_project_url(self):
        self.assertEqual(T.broker_url(), 'https://abcdefghijklmnopqrst.functions.supabase.co/ari-worker-token')
        os.environ['ARI_SB_URL'] = 'https://custom.example.com'
        with self.assertRaises(SystemExit): T.broker_url()
        os.environ['ARI_BROKER_URL'] = 'https://x/ari-worker-token'
        self.assertEqual(T.broker_url(), 'https://x/ari-worker-token')

    def test_fetch_writes_0600_file_then_caches(self):
        b = Broker(tok(tag='1'))
        self.assertEqual(T.bearer(opener=b, now=NOW), tok(tag='1'))
        f = os.environ['ARI_SB_JWT_FILE']
        self.assertEqual(oct(os.stat(f).st_mode & 0o777), '0o600')
        self.assertEqual(open(f).read(), tok(tag='1'))
        self.assertEqual(T.bearer(opener=b, now=NOW + 60), tok(tag='1'))  # cached, no second call
        self.assertEqual(len(b.calls), 1)
        req = b.calls[0]
        self.assertEqual(req.get_method(), 'POST')
        self.assertEqual(req.full_url, 'https://abcdefghijklmnopqrst.functions.supabase.co/ari-worker-token')
        self.assertNotIn('x-ari-worker-caller', {k.lower() for k in req.headers})  # proxy injects it in Hark
        self.assertNotIn('authorization', {k.lower() for k in req.headers})

    def test_refetch_when_under_ten_minutes_left(self):
        b = Broker(tok(tag='1'), tok(iat=NOW + 3100, tag='2'))
        T.bearer(opener=b, now=NOW)
        self.assertEqual(T.bearer(opener=b, now=NOW + 3100), tok(iat=NOW + 3100, tag='2'))
        self.assertEqual(len(b.calls), 2)

    def test_force_skips_cache(self):
        b = Broker(tok(tag='1'), tok(tag='2'))
        T.bearer(opener=b, now=NOW)
        self.assertEqual(T.bearer(force=True, opener=b, now=NOW), tok(tag='2'))

    def test_bad_cached_file_is_replaced(self):
        f = os.environ['ARI_SB_JWT_FILE']; os.makedirs(os.path.dirname(f)); open(f, 'w').write(tok(alg='HS256'))
        b = Broker(tok(tag='1'))
        self.assertEqual(T.bearer(opener=b, now=NOW), tok(tag='1'))

    def test_one_retry_on_5xx_and_network(self):
        b = Broker(http_error(503), tok(tag='1'))
        self.assertEqual(T.bearer(opener=b, now=NOW, sleep=lambda s: None), tok(tag='1'))
        b = Broker(urllib.error.URLError('down'), tok(tag='2'))
        self.assertEqual(T.bearer(force=True, opener=b, now=NOW, sleep=lambda s: None), tok(tag='2'))
        b = Broker(http_error(503), http_error(503))
        with self.assertRaises(SystemExit): T.bearer(force=True, opener=b, now=NOW, sleep=lambda s: None)

    def test_refusal_is_final_and_file_untouched(self):
        b = Broker(tok(tag='1')); T.bearer(opener=b, now=NOW)
        b = Broker(http_error(403, b'{"error":"refused","reason":"rate"}'))
        with self.assertRaises(SystemExit) as c: T.bearer(force=True, opener=b, now=NOW, sleep=lambda s: None)
        self.assertIn('403', str(c.exception)); self.assertIn('rate', str(c.exception))
        self.assertEqual(len(b.calls), 1)
        self.assertEqual(open(os.environ['ARI_SB_JWT_FILE']).read(), tok(tag='1'))

    def test_broker_handing_out_wrong_token_is_refused(self):
        for bad in (tok(role='service_role'), tok(alg='HS256'), tok(ttl=7 * 86400)):
            with self.assertRaises(SystemExit): T.bearer(force=True, opener=Broker(bad), now=NOW)
        self.assertFalse(os.path.exists(os.environ['ARI_SB_JWT_FILE']))

    def test_caller_file_outside_hark(self):
        cf = os.path.join(self.d, 'caller'); open(cf, 'w').write('s3cret\n'); os.environ['ARI_WORKER_CALLER_FILE'] = cf
        b = Broker(tok()); T.bearer(opener=b, now=NOW)
        self.assertEqual(b.calls[0].get_header('X-ari-worker-caller'), 's3cret')

    def test_cli_never_prints_token(self):
        b = Broker(tok(iat=int(time.time())))
        with mock.patch('urllib.request.urlopen', b), mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(T.main(['x', 'ensure']), 0)
        self.assertIn('token ok', out.getvalue()); self.assertNotIn('sig', out.getvalue())


    def test_cli_whoami_prints_claims_and_judges_step_c(self):
        import ari_db
        good = {'role': 'ari_worker', 'sub': 'uid-1', 'has_session': True, 'ttl': 3600}
        static = {'role': 'ari_worker', 'sub': None, 'has_session': False, 'ttl': 315360000}
        os.environ['ARI_WORKER_BROKER'] = '0'
        for w, uid, rc in ((good, 'uid-1', 0), (static, 'uid-1', 1), (static, None, 0)):
            if uid: os.environ['ARI_WORKER_UID'] = uid
            else: os.environ.pop('ARI_WORKER_UID', None)
            with mock.patch.object(ari_db, 'rpc', return_value=w) as rpc, mock.patch('sys.stdout', new_callable=io.StringIO) as out:
                self.assertEqual(T.main(['x', 'ensure', '--whoami']), rc)
            rpc.assert_called_once_with('ari_worker_whoami', actor='worker')
            self.assertIn('sub=%s' % w['sub'], out.getvalue())
        os.environ.pop('ARI_WORKER_UID', None)


class TestAriDb(Base):
    """ari_db.request: unchanged when off; with the broker, one fresh token and one retry on 401."""
    def setUp(self):
        super().setUp()
        import importlib, ari_db; self.db = importlib.reload(ari_db)

    def run_requests(self, responses):
        seen = []
        def fake_open(req, timeout):
            seen.append(dict((k.lower(), v) for k, v in req.header_items()))
            r = responses.pop(0)
            if isinstance(r, BaseException): raise r
            return Resp(r)
        return seen, fake_open

    def test_off_uses_jwt_file_exactly_as_before(self):
        os.environ['ARI_WORKER_BROKER'] = '0'
        f = os.environ['ARI_SB_JWT_FILE']; os.makedirs(os.path.dirname(f)); open(f, 'w').write('static.jwt.x')
        seen, fo = self.run_requests([[{'ok': 1}]])
        with mock.patch.object(self.db, '_open', fo), mock.patch.object(T, 'bearer', side_effect=AssertionError('broker called')):
            self.assertEqual(self.db.request('GET', 'people'), [{'ok': 1}])
        self.assertEqual(seen[0]['authorization'], 'Bearer static.jwt.x')

    def test_off_401_is_not_retried(self):
        os.environ['ARI_WORKER_BROKER'] = '0'; os.environ.pop('ARI_SB_JWT_FILE')  # as in Hark: the proxy injects the bearer
        seen, fo = self.run_requests([http_error(401)])
        with mock.patch.object(self.db, '_open', fo):
            with self.assertRaises(SystemExit): self.db.request('GET', 'people')
        self.assertEqual(len(seen), 1)

    def test_on_401_refetches_once_and_retries(self):
        tokens = iter([tok(tag='old'), tok(tag='new')])
        state = {'cur': None}
        def fake_bearer(force=False, **k):
            if force or state['cur'] is None: state['cur'] = next(tokens)
            return state['cur']
        seen, fo = self.run_requests([http_error(401), {'ok': 2}])
        with mock.patch.object(self.db, '_open', fo), mock.patch.object(T, 'bearer', side_effect=fake_bearer):
            self.assertEqual(self.db.request('POST', 'rpc/x', {}), {'ok': 2})
        self.assertEqual(seen[0]['authorization'], 'Bearer ' + tok(tag='old'))
        self.assertEqual(seen[1]['authorization'], 'Bearer ' + tok(tag='new'))

    def test_on_second_401_stops(self):
        seen, fo = self.run_requests([http_error(401), http_error(401)])
        with mock.patch.object(self.db, '_open', fo), mock.patch.object(T, 'bearer', return_value=tok()):
            with self.assertRaises(SystemExit) as c: self.db.request('GET', 'people')
        self.assertIn('401', str(c.exception)); self.assertEqual(len(seen), 2)

    def test_on_5xx_retries_still_work(self):
        seen, fo = self.run_requests([http_error(502), http_error(502), {'ok': 3}])
        with mock.patch.object(self.db, '_open', fo), mock.patch.object(T, 'bearer', return_value=tok()), mock.patch('time.sleep'):
            self.assertEqual(self.db.request('GET', 'people'), {'ok': 3})
        self.assertEqual(len(seen), 3)

    def test_publishable_apikey_always_sent(self):
        seen, fo = self.run_requests([{'ok': 1}])
        with mock.patch.object(self.db, '_open', fo), mock.patch.object(T, 'bearer', return_value=tok()):
            self.db.request('GET', 'people')
        self.assertTrue(seen[0]['apikey'].startswith('sb_publishable_'))


class TestSync(Base):
    def test_sync_sb_refetches_once_on_401(self):
        import importlib, sync_sheet_supabase as S; S = importlib.reload(S)
        calls = []
        def fake_open(req, timeout=None):
            calls.append(req.get_header('Authorization'))
            if len(calls) == 1: raise http_error(401)
            return Resp([{'k': 1}])
        n = {'i': 0}
        def fake_bearer(force=False, **k):
            if force: n['i'] += 1
            return tok(tag=str(n['i']))
        with mock.patch('urllib.request.urlopen', fake_open), mock.patch.object(T, 'bearer', side_effect=fake_bearer):
            self.assertEqual(S.sb('GET', 'brief?select=key'), [{'k': 1}])
        self.assertEqual(calls, ['Bearer ' + tok(tag='0'), 'Bearer ' + tok(tag='1')])

    def test_sync_off_unchanged(self):
        os.environ['ARI_WORKER_BROKER'] = '0'; os.environ.pop('ARI_SB_JWT_FILE')
        import importlib, sync_sheet_supabase as S; S = importlib.reload(S)
        calls = []
        def fake_open(req, timeout=None):
            calls.append(req.get_header('Authorization')); raise http_error(401)
        with mock.patch('urllib.request.urlopen', fake_open), mock.patch.object(T, 'bearer', side_effect=AssertionError):
            with self.assertRaises(RuntimeError): S.sb('GET', 'brief')
        self.assertEqual(calls, [None])  # no Authorization from the script: the proxy adds it, as today


class TestDailyReport(Base):
    def test_daily_report_uses_broker_when_on(self):
        import importlib, daily_report as D; D = importlib.reload(D)
        got = []
        def fake_open(req, timeout=None):
            got.append(req.get_header('Authorization')); return Resp([])
        with mock.patch('urllib.request.urlopen', fake_open), mock.patch.object(T, 'bearer', return_value=tok(tag='d')):
            D.sb('people?select=id')
        self.assertEqual(got, ['Bearer ' + tok(tag='d')])

    def test_daily_report_refetches_once_on_401(self):
        import importlib, daily_report as D; D = importlib.reload(D)
        got, n = [], {'i': 0}
        def fake_open(req, timeout=None):
            got.append(req.get_header('Authorization'))
            if len(got) == 1: raise http_error(401)
            return Resp([{'k': 1}])
        def fake_bearer(force=False, **k):
            if force: n['i'] += 1
            return tok(tag=str(n['i']))
        with mock.patch('urllib.request.urlopen', fake_open), mock.patch.object(T, 'bearer', side_effect=fake_bearer):
            self.assertEqual(D.sb('people?select=id'), [{'k': 1}])
        self.assertEqual(got, ['Bearer ' + tok(tag='0'), 'Bearer ' + tok(tag='1')])

    def test_daily_report_second_401_stops(self):
        import importlib, daily_report as D; D = importlib.reload(D)
        def fake_open(req, timeout=None): raise http_error(401)
        with mock.patch('urllib.request.urlopen', fake_open), mock.patch.object(T, 'bearer', return_value=tok()):
            with self.assertRaises(urllib.error.HTTPError): D.sb('people')


class TestRestoreDrillKey(unittest.TestCase):
    def test_picks_named_secret_key_apikey_only(self):
        sys.argv = ['x', '--file', 'y']
        import restore_drill as R
        keys = [{'name': 'service_role', 'type': 'legacy', 'api_key': 'eyJlegacy'},
                {'name': 'ari_maint', 'type': 'secret', 'api_key': 'sb_secret_abc'}]
        self.assertEqual(R.pick_key(keys), 'sb_secret_abc')
        self.assertEqual(R.key_headers('sb_secret_abc'), {'apikey': 'sb_secret_abc', 'Content-Type': 'application/json'})
        with self.assertRaises(SystemExit): R.pick_key(keys[:1])
        self.assertEqual(R.pick_key(keys[:1], allow_legacy=True), 'eyJlegacy')
        self.assertIn('Authorization', R.key_headers('eyJlegacy'))


if __name__ == '__main__':
    unittest.main(verbosity=1)
