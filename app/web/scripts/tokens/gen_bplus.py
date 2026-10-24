#!/usr/bin/env python3
"""B+ tokens (S2, Oct 24 2026): generate src/b/tokens.css from tokens/bplus.json and check contrast in both themes.

  python3 scripts/tokens/gen_bplus.py            write src/b/tokens.css
  python3 scripts/tokens/gen_bplus.py --check    exit 1 when the file is stale or a pair misses its contrast floor

Dark applies with [data-theme="dark"] on <html> (src/b/theme.ts sets it from the system setting and the local hour).
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'tokens', 'bplus.json')
OUT = os.path.join(ROOT, 'src', 'b', 'tokens.css')


def _lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lum(h):
    h = h.lstrip('#')
    return .2126 * _lin(int(h[0:2], 16)) + .7152 * _lin(int(h[2:4], 16)) + .0722 * _lin(int(h[4:6], 16))


def ratio(a, b):
    x, y = sorted([lum(a), lum(b)])
    return (y + .05) / (x + .05)


def generate(t):
    pal = t['palette']
    L = ['/* GENERATED from tokens/bplus.json by scripts/tokens/gen_bplus.py. Do not edit by hand. */', ':root {', '  color-scheme: light;']
    for k, v in pal.items(): L.append(f'  --p-{k}: {v};')
    for k, v in t['theme']['light'].items(): L.append(f'  --{k}: var(--p-{v});')
    L.append('  --font: ' + ', '.join(f'"{f}"' if ' ' in f else f for f in t['font']['family']) + ';')
    for k, v in t['fontSize'].items(): L.append(f'  --fs-{k}: {v};')
    for k, v in t['space'].items(): L.append(f'  --s-{k}: {v};')
    for k, v in t['radius'].items(): L.append(f'  --r-{k}: {v};')
    L.append(f'  --tap: {t["tap"]};')
    for k, v in t['motion'].items():
        if k.startswith('$'): continue
        L.append(f'  --{"ease" if k.startswith("ease") else "dur"}-{k.replace("ease-", "")}: {v};')
    L.append('}')
    L.append(':root[data-theme="dark"] {\n  color-scheme: dark;')
    for k, v in t['theme']['dark'].items(): L.append(f'  --{k}: var(--p-{v});')
    L.append('}')
    durs = ' '.join(f'--dur-{k}: 1ms;' for k in t['motion'] if not k.startswith(('$', 'ease')))
    L.append('@media (prefers-reduced-motion: reduce) {\n  :root { ' + durs + ' }\n}')
    return '\n'.join(L) + '\n'


def check(t):
    fails, low = [], (99, '')
    for theme, roles in t['theme'].items():
        col = lambda r: t['palette'][roles[r]]
        for a, b in t['textPairs']:
            v = ratio(col(a), col(b)); low = min(low, (v, f'{theme} {a} on {b}'))
            if v < 4.5: fails.append(f'{theme} {a} on {b} {v:.2f}:1 < 4.5')
        for a, b in t['boundaryPairs']:
            v = ratio(col(a), col(b))
            if v < 3: fails.append(f'{theme} {a} on {b} {v:.2f}:1 < 3')
    green = [k for k, v in t['palette'].items() if _is_green(v)]
    if green: fails.append(f'green in palette: {green}')
    return fails, low


def _is_green(h):
    r, g, b = (int(h.lstrip('#')[i:i + 2], 16) for i in (0, 2, 4))
    return g > r + 24 and g > b + 24


if __name__ == '__main__':
    t = json.load(open(SRC))
    css = generate(t)
    if '--check' in sys.argv:
        fails, low = check(t)
        if not (os.path.exists(OUT) and open(OUT).read() == css): fails.append('src/b/tokens.css is stale: run npm run tokens:b')
        print(f'B+ contrast: tightest text {low[0]:.2f}:1 ({low[1]})')
        for f in fails: print('FAIL', f)
        print('bplus: PASS' if not fails else f'bplus: {len(fails)} FAIL'); sys.exit(1 if fails else 0)
    open(OUT, 'w').write(css); print('wrote src/b/tokens.css')
