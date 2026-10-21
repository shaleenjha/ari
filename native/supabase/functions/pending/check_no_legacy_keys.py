#!/usr/bin/env python3
"""S1 R7 guard (CI): no pending edge function reads the legacy SUPABASE_SERVICE_ROLE_KEY or sends its secret key as a
Bearer token. Comments are ignored. Exit 1 with the offending lines."""
import os, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
BAD = [re.compile(r'Deno\.env\.get\(\s*["\']SUPABASE_SERVICE_ROLE_KEY'), re.compile(r'Authorization:\s*`Bearer \$\{key\}`')]
bad = []
for d in sorted(os.listdir(HERE)):
    f = os.path.join(HERE, d, 'index.ts')
    if not os.path.isfile(f): continue
    for i, line in enumerate(open(f), 1):
        code = line.split('//', 1)[0]
        if any(p.search(code) for p in BAD): bad.append('%s/index.ts:%d: %s' % (d, i, line.strip()))
    if 'secretKey(' not in open(f).read(): bad.append('%s/index.ts: does not use secretKey()' % d)
print('\n'.join(bad) if bad else 'pending functions: named secret keys only, apikey header only (%d checked)' % len([d for d in os.listdir(HERE) if os.path.isfile(os.path.join(HERE, d, 'index.ts'))]))
sys.exit(1 if bad else 0)
