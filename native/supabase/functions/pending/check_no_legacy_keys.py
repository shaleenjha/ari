#!/usr/bin/env python3
"""S1 R7 guard (CI): no pending edge function reads the legacy SUPABASE_SERVICE_ROLE_KEY or sends its secret key as a
Bearer token. // comments are ignored only when // starts the line or follows whitespace (so https:// lines are still
scanned). "Bearer ${...}" is caught for ANY variable name the file assigns from secretKey() (or secretKey() inline);
OAuth / Expo access tokens stay allowed. Exit 1 with the offending lines. --self-test checks the rules on samples."""
import os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
LEGACY = re.compile(r'Deno\.env\.get\(\s*["\']SUPABASE_SERVICE_ROLE_KEY')
COMMENT = re.compile(r'(^|\s)//.*$')


def scan(src):
    """-> list of (line_no, line) that break the rules."""
    code_lines = [COMMENT.sub('', l) for l in src.splitlines()]
    keys = set(re.findall(r'\b(\w+)\s*=\s*secretKey\(', '\n'.join(code_lines)))
    bearer = re.compile(r'Bearer\s*\$\{\s*(secretKey\(%s)' % ''.join('|%s\\b' % re.escape(k) for k in sorted(keys)))
    out = []
    for i, (line, code) in enumerate(zip(src.splitlines(), code_lines), 1):
        if LEGACY.search(code) or bearer.search(code): out.append((i, line.strip()))
    return out


def self_test():
    cases = [  # (source, expected number of hits)
        ("const key = secretKey('a');\nfetch(u, { headers: { apikey: key } });", 0),
        ("const key = secretKey('a');\nconst h = { Authorization: `Bearer ${key}` };", 1),
        ("const sk = secretKey('a');\nfetch('https://x.supabase.co/rest', { headers: { Authorization: `Bearer ${sk}` } });", 1),
        ("const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); // https://x", 1),
        ("// const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');", 0),
        ("  const h = `Bearer ${key}`; // const key = secretKey('a')", 0),
        ("const key = secretKey('a');\nconst auth = { Authorization: `Bearer ${tj.access_token}` };", 0),
        ("const h = `Bearer ${secretKey('a')}`;", 1),
    ]
    bad = [(s, n, len(scan(s))) for s, n in cases if len(scan(s)) != n]
    for s, n, got in bad: print('SELF-TEST FAIL (want %d, got %d): %r' % (n, got, s))
    print('self-test: %d/%d passed' % (len(cases) - len(bad), len(cases)))
    return not bad


if __name__ == '__main__':
    if '--self-test' in sys.argv: sys.exit(0 if self_test() else 1)
    bad, n = [], 0
    for d in sorted(os.listdir(HERE)):
        f = os.path.join(HERE, d, 'index.ts')
        if not os.path.isfile(f): continue
        n += 1; src = open(f).read()
        bad += ['%s/index.ts:%d: %s' % (d, i, l) for i, l in scan(src)]
        if 'secretKey(' not in src: bad.append('%s/index.ts: does not use secretKey()' % d)
    print('\n'.join(bad) if bad else 'pending functions: named secret keys only, apikey header only (%d checked)' % n)
    sys.exit(1 if bad else 0)
