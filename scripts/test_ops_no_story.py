#!/usr/bin/env python3
# v18.14.11 (Owner Oct 30 2026): "the whole bit about how the app was built, scrap that. From onboarding too."
# web/ops.html must not render the build story anywhere: About, onboarding, chat, What's new.
# Usage: python3 scripts/test_ops_no_story.py [path/to/ops.html]
import os, re, sys, json, subprocess
P = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'web', 'ops.html')
s = open(P, encoding='utf8').read()
fails = []
def check(cond, msg):
    print(('PASS ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)
for bad in ['How I was made', 'I remember how I was made', 'my About page', 'The full story lives', 'Kyte’s memory', 'Nice to meet you, again', 'You just don’t know me in this form']:
    check(bad not in s, 'no "%s" anywhere in ops.html' % bad)
m = re.search(r"const STEPS=\[([^\]]*)\]", s)
check(m is not None and "'memory'" not in m.group(1), 'onboarding STEPS has no memory step')
check("k==='memory'" not in s, 'no onboarding memory view')
check(re.search(r"\btimeline:\[\],", s) is not None, 'ARI_MEM.timeline is an empty list (object kept for old readers)')
check('ARI_MEM.timeline' not in s, 'nothing reads ARI_MEM.timeline')
# chat: run memAnswer itself
a = s.index('function memAnswer(low){'); b = s.index('const _v14r=window.ariV14&&ariV14.respond;')
js = s[a:b] + r"""
const qs={'how were you made':'D','how was this app built':'D','tell me your story':'D','why do you look like a pebble':'D','show me your tricks':'D',
 'who are you':'W','what can you do':'W','can you send it for me':'S','what is the next move':''};
const out={};for(const q in qs)out[q]=memAnswer(q);console.log(JSON.stringify(out));"""
r = subprocess.run(['node', '-e', 'const window={ARI_MEM:{}};' + js], capture_output=True, text=True)
check(r.returncode == 0, 'memAnswer runs on its own (no timeline needed)' + (': ' + r.stderr[:200] if r.returncode else ''))
if r.returncode == 0:
    out = json.loads(r.stdout)
    D = "I can't help with that here."
    for q in ['how were you made', 'how was this app built', 'tell me your story', 'why do you look like a pebble', 'show me your tricks']:
        check(out[q] == D, 'chat "%s" gets the decline' % q)
    check(out['who are you'].startswith('I’m Kyte.') and 'I prepare, you send.' in out['who are you'] and len(out['who are you']) < 140, 'chat "who are you" is one plain line about what Kyte does')
    check(out['what can you do'] == out['who are you'], 'chat "what can you do" gets the same line')
    check('never' in out['can you send it for me'].lower() or 'you tap send' in out['can you send it for me'], 'chat "send it for me" still says you send')
    check(out['what is the next move'] == '', 'ordinary questions still go to Kyte (no local answer)')
    check(not any(w in v for v in out.values() for w in ['pebble', 'ring', 'mouth', 'squash', 'became Kyte', 'Den']), 'no story words in any local answer')
print('\n%d FAILED' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
