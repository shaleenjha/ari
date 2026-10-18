#!/usr/bin/env python3
"""S2 tokens (v18.17.0): generate src/ui/tokens.css from design/tokens.json. Same generator as the S2 design package
(_build/gen_css.py), so the output is byte-identical to the package tokens.css.

  python3 scripts/tokens/gen_css.py            write src/ui/tokens.css
  python3 scripts/tokens/gen_css.py --check    exit 1 when src/ui/tokens.css is not what tokens.json generates
"""
import json, os, sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, 'design', 'tokens.json')
OUT = os.path.join(ROOT, 'src', 'ui', 'tokens.css')


def generate(t):
    L = ['/* GENERATED from tokens.json by gen_css.py. Do not edit by hand. */', ':root {\n  color-scheme: dark;\n  --u: 1rem;']
    for k, v in t['color'].items(): L.append(f'  --{k}: {v["$value"]};')
    L.append('  --font: ' + ', '.join(f'"{f}"' if ' ' in f else f for f in t['font']['family']['$value']) + ';')
    for k, v in t['font']['role'].items():
        x = v['$value']; fs = float(x['fontSize'][:-3]); lh = float(x['lineHeight'][:-3])
        L.append(f'  --fs-{k}: calc(var(--u) * {fs:g}); --lh-{k}: calc(var(--u) * {lh:g}); --fw-{k}: {x["fontWeight"]}; --ls-{k}: {x["letterSpacing"]};')
    for grp in ('space', 'size', 'radius'):
        for k, v in t[grp].items():
            pre = 'r-' if grp == 'radius' else ''
            L.append(f'  --{pre}{k}: {v["$value"]};')
    for k, v in t['motion']['spring'].items():
        L.append(f'  --spring-{k}: {v["$value"]["timingFunction"]};'); L.append(f'  --dur-{k}: {v["$value"]["duration"]};')
    for k, v in t['motion']['duration'].items(): L.append(f'  --dur-{k}: {v["$value"]};')
    for k, v in t['motion']['easing'].items(): L.append(f'  --ease-{k}: cubic-bezier({", ".join("%g" % x for x in v["$value"])});')
    L.append('}')
    fb = ' '.join(f'--spring-{k}: var(--ease-{"emphasized-decelerate" if "spatial" in k or "expressive" in k else "standard"});' for k in t['motion']['spring'])
    L.append('@supports not (transition-timing-function: linear(0, 1)) {\n  :root { ' + fb + ' }\n}')
    L.append('@supports (font: -apple-system-body) {\n  html { font: -apple-system-body; }\n  :root { --u: calc(1rem * 16 / 17); }\n}')
    L.append('@media (prefers-reduced-motion: reduce) {\n  :root { ' + ' '.join(f'--dur-{k}: {"0ms" if "spatial" in k or "expressive" in k else "100ms"};' for k in t['motion']['spring']) + ' }\n}')
    return '\n'.join(L) + '\n'


if __name__ == '__main__':
    css = generate(json.load(open(SRC)))
    if '--check' in sys.argv:
        ok = os.path.exists(OUT) and open(OUT).read() == css
        print('tokens.css matches tokens.json' if ok else 'tokens.css is stale: run npm run tokens')
        sys.exit(0 if ok else 1)
    open(OUT, 'w').write(css); print('wrote src/ui/tokens.css')
