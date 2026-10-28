#!/usr/bin/env python3
"""Repo leak scan: the hard gate that keeps real data out of this repo.

Runs in two places with the same rules:
  * CI (.github/workflows/ci.yml, job repo-scan) over the checked-out repo:   python3 scripts/repo_scan.py
  * scripts/git_export.py over every exported file, before anything is committed (plus a private real-name
    list that never leaves the private workspace).

What it flags (exit 1 on any finding):
  secret     key and token shapes (Supabase secret/management keys, JWTs, GitHub/Vercel/Anthropic/Google keys,
             private keys, Apps Script and Sheet URLs, CRM record ids)
  email      any address outside example.com/.org/.net, *.example, *.test, users.noreply.github.com and
             LinkedIn's own sender domains, except the public contact address and two lookalike test fixtures
  phone      international numbers (+CC ...) and 10-digit Indian mobile numbers
  linkedin   linkedin.com/in/<slug> profile links unless the slug is visibly synthetic (ends -example, -synth or
             -synthetic, or starts sample-, zz-, test-, synthetic) or is one of the fixture slugs listed below
  name       words whose salted SHA-256 is on the blocked list. The list holds hashes only, so this file names
             no real person or company; git_export.py adds the full private list on top.

Fixtures and demo data must use the synthetic workspace (scripts/seller_config.py DEFAULT, app fixtures):
invented company names and clearly fake people.
"""
import os, re, sys, hashlib, subprocess

ALLOW = [r'sb_publishable_[A-Za-z0-9_]+', r'[a-z]{20}\.supabase\.co', r'BNOi3VJ08tMJ[A-Za-z0-9_-]+']
SECRET = {
    'sb_secret': r'sb_secret_[A-Za-z0-9_]{8,}',
    'jwt': r'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}',
    'github_token': r'\bgh[pousr]_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}',
    'supabase_mgmt': r'\bsbp_[a-f0-9]{30,}',
    'vercel_token': r'\bvercel_[A-Za-z0-9]{20,}',
    'anthropic_key': r'\bsk-ant-(?!SYNTHETIC)[A-Za-z0-9_-]{20,}',
    'openai_key': r'\bsk-(?:proj-)?[A-Za-z0-9]{32,}',
    'google_key': r'\bAIza[0-9A-Za-z_-]{30,}|\bGOCSPX-[A-Za-z0-9_-]{10,}',
    'private_key': r'-----BEGIN [A-Z ]*PRIVATE KEY',
    'vapid_private_value': r'"d"\s*:\s*"[A-Za-z0-9_-]{40,}"',
    'crm_id': r'\b00[1-9Q][A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b',
    'apps_script': r'script\.google\.com/macros/s/',
    'sheet_url': r'docs\.google\.com/spreadsheets/d/[A-Za-z0-9_-]{20,}',
}
EMAIL_RX = re.compile(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}')
EMAIL_OK = re.compile(r'@((?:[a-z0-9-]+\.)*example(?:\.(?:com|org|net))?|(?:[a-z0-9-]+\.)*linkedin\.com|users\.noreply\.github\.com'
                      r'|(?:[a-z0-9-]+\.)*test)$|^[a-z0-9.-]+@[0-9.]+$', re.I)
EMAIL_FIXTURES = {'a@notlinkedin.com', 'invitations@linkedin.com.evil.io', 'owner@example.com'}  # lookalike fixtures; public contact address
PHONE_RX = re.compile(r'(?<![\w.+/-])\+(?:1|44|91|61|49|33)[ .-]?\(?\d{2,4}\)?[ .-]?\d{3,4}[ .-]?\d{3,5}(?![\w-])'
                      r'|(?<![\w.+/:-])(?:\+?91[ -]?)?[6-9]\d{9}(?![\w-])')
LI_RX = re.compile(r'linkedin\.com/(?:comm/)?in/([A-Za-z0-9_%-]*)', re.I)
LI_SYNTH = re.compile(r'(-example|-synth|-synthetic)(-[a-z0-9]{1,8})?$|^(sample-|zz-|test-|synthetic)', re.I)
# Fixture slugs in the Gmail parser, import and SQL tests (all invented).
LI_FIXTURES = {'', 'abc', 'x', 't', 'name', 'name.', 'demo-', 'person-', 'alex-doe-4b2a19', 'jamie-poe-77', 'sam-roe',
               'some-one', 'jane-doe-123', 'jordan-example-123', 'check-person-0038', 'someone-else-0038',
               'new-person-synthetic', 'has-url-synthetic'}
SALT = 'ari-scan:'
BLOCKED = {'acaa810eb49fd5325a81', '79433741d826fad58c8c', '408e8276e94d38feba3d', '9f1950aa79a048ee6ed1',
           '59d958c3a919be31d413', 'afecc6a438d99d24f184', '1f505d342ff0c18e83a2', '0a2cdcbe1d639008f938',
           '00ae7a9f74308d6c810e', '00efc1eb106f687e8fee'}
TOKEN_RX = re.compile(r'[A-Z]?[a-z]+|[A-Z]+(?![a-z])')
DATA_URI = re.compile(r'data:[a-z]+/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+')
NAME_EXEMPT = {'LICENSE'}                         # carries the owner's name by design
GENERATED = ('package-lock.json',)                # registry metadata: secrets only
VENDORED = ('web/ari-supabase.js',)               # third-party library: secrets only
BINARY = ('.png', '.woff2', '.woff', '.jpg', '.jpeg', '.ico', '.gif', '.webp', '.pdf')


def _h(word):
    return hashlib.sha256((SALT + word).encode()).hexdigest()[:20]


def strip_data(text):
    """Base64 data URIs (inlined fonts and images) are not text: leave them out of every check."""
    return DATA_URI.sub('data:', text)


def scan_text(path, text):
    """[(path, kind, match)] for one file. path is repo-relative with forward slashes."""
    out = []
    t = strip_data(text)
    scan = re.sub('|'.join(ALLOW), '', t)
    for k, p in SECRET.items():
        for m in set(re.findall(p, scan)):
            out.append((path, k, m if isinstance(m, str) else m[0]))
    if path.endswith(GENERATED) or path in VENDORED:
        return out
    for m in set(EMAIL_RX.findall(scan)):
        if m in EMAIL_FIXTURES or EMAIL_OK.search(m) or re.search(r'@\d|\.(png|js|css|woff2|svg|jpg)$', m, re.I):
            continue
        out.append((path, 'email', m))
    for m in set(x.group(0) for x in PHONE_RX.finditer(scan)):
        out.append((path, 'phone', m))
    for slug in set(LI_RX.findall(scan)):
        s = slug.rstrip('/').lower()
        if s in LI_FIXTURES or LI_SYNTH.search(s):
            continue
        out.append((path, 'linkedin', 'linkedin.com/in/' + slug))
    if os.path.basename(path) not in NAME_EXEMPT:
        seen = set()
        for tok in TOKEN_RX.findall(t):
            w = tok.lower()
            if w in seen:
                continue
            seen.add(w)
            if _h(w) in BLOCKED:
                out.append((path, 'name', tok))
    return out


def repo_files(root):
    try:
        names = subprocess.run(['git', 'ls-files', '-z'], cwd=root, capture_output=True, check=True).stdout.decode().split('\0')
        names = [n for n in names if n]
    except (OSError, subprocess.CalledProcessError):
        names = []
        for dp, dns, fns in os.walk(root):
            dns[:] = [d for d in dns if d not in ('.git', 'node_modules', 'dist', 'test-results')]
            names += [os.path.relpath(os.path.join(dp, f), root) for f in fns]
    return sorted(n.replace(os.sep, '/') for n in names)


def main(argv):
    root = os.path.abspath(argv[1] if len(argv) > 1 else os.path.join(os.path.dirname(__file__), '..'))
    problems, n = [], 0
    for rel in repo_files(root):
        if rel.lower().endswith(BINARY):
            continue
        p = os.path.join(root, rel)
        if not os.path.isfile(p):
            continue
        try:
            text = open(p, encoding='utf-8').read()
        except UnicodeDecodeError:
            continue
        n += 1
        problems += scan_text(rel, text)
    print('repo scan: %d files' % n)
    if problems:
        print('REPO SCAN FAILED, %d findings:' % len(problems))
        for p in sorted(set(problems)):
            print('  ', *p)
        return 1
    print('repo scan clean')
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
