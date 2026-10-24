#!/usr/bin/env python3
"""B+ icons (S2, Oct 24 2026): build src/b/icons/tabler.svg, a sprite of Tabler outline icons (MIT), from an unpacked
@tabler/icons package. Symbols are named tb-<icon>. Vite inlines the sprite into b.html (vite.config.ts), so
<use href="#tb-..."> resolves on the first paint and offline. Stroke width lives in the sprite, never in CSS or JSX.

  npm pack @tabler/icons && tar xzf tabler-icons-*.tgz
  python3 scripts/icons/build_tabler.py <path to package/icons/outline>
"""
import os, re, sys

ICONS = ['cards', 'layout-dashboard', 'building', 'chart-bar', 'chevron-down', 'chevron-left', 'chevron-right', 'copy',
         'brand-linkedin', 'check', 'x', 'arrow-back-up', 'message-circle', 'clock', 'send', 'user-plus', 'crown',
         'hourglass', 'search', 'bulb', 'player-play', 'mail', 'bell', 'shield-lock', 'download', 'trash', 'info-circle',
         'lock', 'file-text', 'lifebuoy', 'refresh', 'plus', 'minus', 'logout', 'device-mobile', 'brand-google',
         'calendar', 'users', 'arrow-up', 'arrow-down', 'equal', 'alert-circle', 'player-stop', 'list-check', 'user']
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'src', 'b', 'icons', 'tabler.svg')

def main(src):
    parts = ['<svg xmlns="http://www.w3.org/2000/svg">']
    for n in ICONS:
        svg = open(os.path.join(src, f'{n}.svg'), encoding='utf8').read()
        body = re.search(r'>\s*(.*)</svg>', svg, re.S).group(1)
        body = re.sub(r'<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*/>', '', body)
        body = ' '.join(body.split())
        parts.append(f'<symbol id="tb-{n}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" '
                     f'stroke-linecap="round" stroke-linejoin="round">{body}</symbol>')
    parts.append('</svg>')
    open(OUT, 'w').write('\n'.join(parts) + '\n')
    print(f'wrote {len(ICONS)} icons to src/b/icons/tabler.svg')

if __name__ == '__main__':
    main(sys.argv[1])
