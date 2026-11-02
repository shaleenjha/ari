#!/usr/bin/env python3
"""S2 package checks (work/s2-package/ari-s2-design/_build/verify.py) ported to the app. Run by npm run lint:tokens, which
npm run lint:design and the anti-slop-static CI job run first. Exit 1 on any FAIL.
  1 contrast from src/ui/tokens.css: text-1/2/3, accent, friction, done >= 4.5:1 on canvas and surface-1..3 (text-3 on
    surface-3 is banned, not checked); border and focus >= 3:1 (border not on surface-3); ink on key, pressed, done >= 4.5
  2 src/ui/tokens.css is exactly what tokens/tokens.json generates (scripts/tokens/gen_css.py)
  3 4 px grid on every space and size dimension (stroke excepted); radii only 8, 12, 16, 20, 28, 9999
  4 no raw hex anywhere in src/ (CSS, TS/TSX incl. template literals, SVG fill/stroke) except src/ui/tokens.css, src/b/tokens.css (B+, checked by gen_bplus.py) and tests;
    public/brand/ is the only exempt asset folder (it is outside src/)
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gen_css import ROOT, SRC, OUT, generate

fails = []
css = open(OUT).read(); V = dict(re.findall(r'--([a-z0-9-]+):\s*(#[0-9A-Fa-f]{6});', css))
lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
L = lambda h: sum(w * lin(int(h[i:i + 2], 16) / 255) for w, i in ((.2126, 1), (.7152, 3), (.0722, 5)))
def cr(a, b): x, y = sorted([L(V[a]), L(V[b])]); return (y + .05) / (x + .05)
surf = ['canvas', 'surface-1', 'surface-2', 'surface-3']; low = (99, '')
for f in ['text-1', 'text-2', 'text-3', 'accent', 'friction', 'done']:
    for s in surf:
        if (f, s) == ('text-3', 'surface-3'): continue
        v = cr(f, s); low = min(low, (v, f'{f} on {s}'))
        if v < 4.5: fails.append(f'contrast {f}/{s} {v:.2f}')
for f in ['border', 'focus']:
    for s in surf:
        if (f, s) == ('border', 'surface-3'): continue
        if cr(f, s) < 3: fails.append(f'boundary {f}/{s} {cr(f, s):.2f}')
for k in ('accent', 'accent-pressed', 'done'):
    if cr('on-accent', k) < 4.5: fails.append(f'ink on {k} {cr("on-accent", k):.2f}')
print(f'1 contrast: tightest text {low[0]:.2f}:1 ({low[1]})')
t = json.load(open(SRC))
if generate(t) != css: fails.append('tokens.css does not match tokens.json (npm run tokens)')
print('2 tokens.css == gen(tokens.json)')
off = [k for g in ('space', 'size') for k, v in t[g].items() if v['$type'] == 'dimension' and float(v['$value'][:-2]) % 4 and k != 'stroke']
rad = [k for k, v in t['radius'].items() if float(v['$value'][:-2]) not in (8, 12, 16, 20, 28, 9999)]
if off or rad: fails.append(f'grid {off} radius {rad}')
print('3 4px grid, radius set')
HEX = re.compile(r'#[0-9A-Fa-f]{3,8}\b')
for d, _, fs in os.walk(os.path.join(ROOT, 'src')):
    for n in fs:
        p = os.path.join(d, n); rel = os.path.relpath(p, ROOT)
        if rel in (os.path.join('src', 'ui', 'tokens.css'), os.path.join('src', 'b', 'tokens.css')) or re.search(r'\.test\.tsx?$', n) or not n.endswith(('.css', '.ts', '.tsx', '.svg')): continue
        for i, line in enumerate(open(p, encoding='utf8'), 1):
            if HEX.search(line): fails.append(f'raw hex {rel}:{i} {HEX.search(line).group()}')
print('4 no raw hex in src/')
for f in fails: print('FAIL', f)
print('verify: PASS' if not fails else f'verify: {len(fails)} FAIL'); sys.exit(1 if fails else 0)
