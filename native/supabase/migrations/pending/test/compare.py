#!/usr/bin/env python3
"""Compares the probes and schema dumps written by run_local.sh. Exit 1 on any regression."""
import json, sys, os, difflib
d = sys.argv[1]
load = lambda n: json.load(open(os.path.join(d, n)))
base = load('probe_before.json')
bad = 0
for n in ['probe_after_0033.json', 'probe_after_0034.json', 'probe_after_0035.json', 'probe_after_reapply.json', 'probe_after_rollback.json']:
    cur = load(n)
    diffs = [(k, base.get(k), cur.get(k)) for k in sorted(set(base) | set(cur)) if base.get(k) != cur.get(k)]
    tables = sum(1 for k in base if '|T|' in k); fns = sum(1 for k in base if '|F|' in k)
    oks = {r: sum(1 for k, v in cur.items() if k.startswith(r + '|F|') and v.startswith('OK')) for r in ['owner', 'ari_worker']}
    print(f'{n}: {tables} relation reads + {fns} function calls compared over owner/stranger/ari_worker/anon; '
          f'OK calls owner {oks["owner"]}, ari_worker {oks["ari_worker"]}; differences {len(diffs)}')
    for k, a, b in diffs[:40]: print(f'   {k}\n      before: {a}\n      now:    {b}')
    bad += len(diffs)
rd = lambda n: [l for l in open(os.path.join(d, n)).read().splitlines() if not l.startswith(('\\restrict', '\\unrestrict'))]  # pg_dump 17.6+ random keys
a = rd('schema_before.sql'); b = rd('schema_after_rollback.sql')
sd = [l for l in difflib.unified_diff(a, b, lineterm='', n=0) if not l.startswith(('---', '+++', '@@'))]
print(f'schema + policies after rollback vs before: {len(sd)} differing lines'); [print('   ' + l) for l in sd[:30]]
bad += len(sd)
print('COMPARE: CLEAN' if bad == 0 else f'COMPARE: {bad} difference(s)')
sys.exit(1 if bad else 0)
