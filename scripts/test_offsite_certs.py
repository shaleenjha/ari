# S1 R3 tests: multi-recipient offsite encryption, the nightly recipient check, and .cms restore input.
# Uses THROWAWAY certificates generated here at run time; no real key is ever involved or committed.
import os, sys, json, gzip, hashlib, shutil, datetime, tempfile, subprocess, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import offsite_certs, backup_check


def mkcert(d, name, cn):
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-384', '-nodes',
                    '-keyout', os.path.join(d, name + '.key'), '-out', os.path.join(d, name + '.pem'), '-days', '2',
                    '-subj', '/CN=' + cn], check=True, capture_output=True)
    return os.path.join(d, name + '.pem'), os.path.join(d, name + '.key')


class T(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix='ari-offsite-test-')
        cls.keys = os.path.join(cls.tmp, 'keys'); os.makedirs(cls.keys)
        cls.folder = os.path.join(cls.tmp, 'offsite'); os.makedirs(cls.folder)
        a, cls.ka = mkcert(cls.keys, 'a', 'throwaway vault')
        b, cls.kb = mkcert(cls.keys, 'b', 'throwaway - Owner')
        c, cls.kc = mkcert(cls.keys, 'c', 'throwaway stranger')
        shutil.copy(a, os.path.join(cls.folder, 'ari-offsite-recipient.pem'))
        shutil.copy(b, os.path.join(cls.folder, 'ari-offsite-recipient-shal.pem'))
        cls.c = c
        cls.plain = gzip.compress(json.dumps({'public.t': [{'id': 1}], 'auth.users': []}).encode())
        cls.blob = offsite_certs.encrypt(cls.plain, cls.folder)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_both_keys_open_it(self):
        self.assertEqual(offsite_certs.decrypt(self.blob, self.ka), self.plain)
        self.assertEqual(offsite_certs.decrypt(self.blob, self.kb), self.plain)
        with self.assertRaises(SystemExit):
            offsite_certs.decrypt(self.blob, self.kc)

    def test_recipients_match(self):
        r = offsite_certs.check_recipients(self.blob, self.folder)
        self.assertTrue(r['ok']); self.assertEqual((r['recipients'], r['expected']), (2, 2))

    def test_placeholder_ignored(self):
        d = tempfile.mkdtemp(dir=self.tmp)
        shutil.copy(os.path.join(self.folder, 'ari-offsite-recipient.pem'), d)
        open(os.path.join(d, 'ari-offsite-recipient-shal.pem'), 'w').write('placeholder\n')
        certs, holders = offsite_certs.recipient_files(d)
        self.assertEqual(len(certs), 1); self.assertEqual(len(holders), 1)

    def run_row(self, blob, **kw):
        row = {'finished_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'verified': True, 'error': None,
               'enc_file': 'ari_x.json.gz.cms', 'enc_sha256': hashlib.sha256(blob).hexdigest(), 'offsite': False}
        row.update(kw)
        return backup_check.evaluate(row, datetime.datetime.now(datetime.timezone.utc), blob, None, None, self.folder, pending=set())

    def test_check_ok_and_staging_ignored(self):
        problems, det = self.run_row(self.blob)
        self.assertEqual(problems, []); self.assertFalse(det['staging_copy'])

    def test_check_sha_mismatch(self):
        problems, _ = self.run_row(self.blob, enc_sha256='0' * 64)
        self.assertTrue(any('sha256' in p for p in problems))

    def test_check_missing_recipient_fails_unless_pending(self):
        one = offsite_certs.encrypt(self.plain, self._only_vault())
        problems, _ = self.run_row(one)
        self.assertTrue(any('recipients' in p for p in problems))
        row = {'finished_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'verified': True,
               'enc_file': 'x.cms', 'enc_sha256': hashlib.sha256(one).hexdigest()}
        problems, det = backup_check.evaluate(row, datetime.datetime.now(datetime.timezone.utc), one, None, None, self.folder,
                                              pending={'ari-offsite-recipient-shal.pem'})
        self.assertEqual(problems, []); self.assertEqual(det['recipients']['waiting_for_function_deploy'], ['ari-offsite-recipient-shal.pem'])

    def test_check_unknown_recipient_fails(self):
        d = tempfile.mkdtemp(dir=self.tmp)
        shutil.copy(os.path.join(self.folder, 'ari-offsite-recipient.pem'), d)
        shutil.copy(self.c, os.path.join(d, 'ari-offsite-recipient-x.pem'))
        odd = offsite_certs.encrypt(self.plain, d)
        problems, _ = self.run_row(odd)
        self.assertTrue(any('unknown' in p for p in problems))

    def test_check_no_encrypted_copy(self):
        problems, _ = self.run_row(self.blob, enc_file=None)
        self.assertTrue(any('no encrypted' in p for p in problems))

    def test_restore_drill_reads_cms(self):
        import restore_drill
        data, name = restore_drill.load(self.blob, 'ari_x.json.gz.cms', self.kb)
        self.assertEqual(name, 'ari_x.json.gz'); self.assertEqual(data['public.t'], [{'id': 1}])
        with self.assertRaises(SystemExit):
            restore_drill.load(self.blob, 'ari_x.json.gz.cms', None)

    def _only_vault(self):
        d = tempfile.mkdtemp(dir=self.tmp)
        shutil.copy(os.path.join(self.folder, 'ari-offsite-recipient.pem'), d)
        return d


if __name__ == '__main__':
    unittest.main()
