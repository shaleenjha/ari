#!/usr/bin/env python3
"""Offsite backup recipients (S1 R3, Oct 19 2026): one place that knows which certificates an encrypted backup must open for.

The nightly export is encrypted with openssl CMS (AES-256-CBC, key wrapped per recipient). Every certificate file
native/supabase/offsite/ari-offsite-recipient*.pem that holds a real certificate is a recipient, so a second key holder
(Owner's own cert, ari-offsite-recipient-shal.pem) is added by dropping the file in and committing it. A file without a
"BEGIN CERTIFICATE" block is a placeholder and is ignored (listed as such, never an error).

Only public certificates live here. Private keys stay in the Hark vault (and Owner's own copy); nothing in this module
reads or writes one, except decrypt(), which takes a key file path the operator supplies and never copies it.
"""
import os, re, glob, subprocess, tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OFFSITE = os.path.join(ROOT, 'native', 'supabase', 'offsite')
PATTERN = 'ari-offsite-recipient*.pem'


def recipient_files(folder=OFFSITE):
    """(certs, placeholders): sorted paths of real certificates and of placeholder files."""
    certs, holders = [], []
    for p in sorted(glob.glob(os.path.join(folder, PATTERN))):
        (certs if '-----BEGIN CERTIFICATE-----' in open(p, encoding='utf-8', errors='replace').read() else holders).append(p)
    return certs, holders


def _norm_serial(s):
    s = s.strip().lower()
    s = s[2:] if s.startswith('0x') else s
    return s.lstrip('0') or '0'


def _norm_name(s):
    return re.sub(r'\s+', ' ', s.strip()).replace(' = ', '=')


def cert_id(path):
    """(issuer, serial) of a certificate, normalised to match what `openssl cms -cmsout -print` shows."""
    out = subprocess.run(['openssl', 'x509', '-in', path, '-noout', '-issuer', '-serial'], capture_output=True, text=True, check=True).stdout
    issuer = re.search(r'^issuer=\s*(.*)$', out, re.M).group(1)
    serial = re.search(r'^serial=\s*(.*)$', out, re.M).group(1)
    return _norm_name(issuer), _norm_serial(serial)


def cms_recipients(der: bytes):
    """[(issuer, serial)] of every recipient in a DER CMS EnvelopedData blob (key transport or key agreement)."""
    with tempfile.NamedTemporaryFile(suffix='.cms') as f:
        f.write(der); f.flush()
        r = subprocess.run(['openssl', 'cms', '-cmsout', '-print', '-inform', 'DER', '-in', f.name], capture_output=True, text=True)
    if r.returncode != 0:
        raise ValueError('not a readable CMS blob: ' + r.stderr.strip()[:160])
    return [(_norm_name(m.group(1)), _norm_serial(m.group(2)))
            for m in re.finditer(r'issuer:\s*(.+?)\n\s*serialNumber:\s*(\S+)', r.stdout)]


def check_recipients(der: bytes, folder=OFFSITE):
    """Compare a blob's recipients with the certificate files. Returns a dict; 'ok' is True only on an exact match."""
    certs, holders = recipient_files(folder)
    want = {cert_id(p): os.path.basename(p) for p in certs}
    got = cms_recipients(der)
    missing = [n for k, n in want.items() if k not in got]
    unknown = ['%s serial %s' % k for k in got if k not in want]
    return {'ok': bool(got) and not missing and not unknown, 'recipients': len(got), 'expected': len(want),
            'missing': missing, 'unknown': unknown, 'placeholders': [os.path.basename(p) for p in holders]}


def encrypt(plain: bytes, folder=OFFSITE) -> bytes:
    certs, _ = recipient_files(folder)
    if not certs:
        raise SystemExit('FAIL no offsite recipient certificate in ' + folder)
    with tempfile.TemporaryDirectory() as d:
        i, o = os.path.join(d, 'in'), os.path.join(d, 'out')
        open(i, 'wb').write(plain)
        subprocess.run(['openssl', 'cms', '-encrypt', '-binary', '-aes-256-cbc', '-outform', 'DER', '-in', i, '-out', o, *certs],
                       check=True, capture_output=True)
        return open(o, 'rb').read()


def decrypt(der: bytes, key_file: str) -> bytes:
    """Decrypt with one recipient's private key (any recipient works). The key file stays where the operator put it."""
    with tempfile.TemporaryDirectory() as d:
        i, o = os.path.join(d, 'in.cms'), os.path.join(d, 'out')
        open(i, 'wb').write(der)
        r = subprocess.run(['openssl', 'cms', '-decrypt', '-binary', '-inform', 'DER', '-in', i, '-inkey', key_file, '-out', o],
                           capture_output=True, text=True)
        if r.returncode != 0:
            raise SystemExit('FAIL decrypt: this key is not a recipient of the file, or the file is damaged (%s)' % r.stderr.strip()[:120])
        return open(o, 'rb').read()
