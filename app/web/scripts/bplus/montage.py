#!/usr/bin/env python3
"""B+ montage: one PNG per device from scripts/bplus/shots.mjs output. Rows: light, dark. Columns: the 8 states.
  python3 scripts/bplus/montage.py [shots dir]
"""
import glob, os, sys
from PIL import Image, ImageDraw

D = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), '..', '..', '..', '..', 'work', 'app2-shell-shots')
W = 360
for dev in ('iphone14', 'pixel7'):
    rows = []
    for theme in ('light', 'dark'):
        fs = sorted(glob.glob(os.path.join(D, f'{dev}-{theme}-*.png')))
        rows.append([(os.path.basename(f), Image.open(f).convert('RGB')) for f in fs])
    cols = max(len(r) for r in rows)
    h = max(int(im.height * W / im.width) for r in rows for _, im in r)
    out = Image.new('RGB', (cols * (W + 16) + 16, len(rows) * (h + 44) + 16), (200, 200, 200))
    dr = ImageDraw.Draw(out)
    for ri, r in enumerate(rows):
        for ci, (name, im) in enumerate(r):
            x = 16 + ci * (W + 16); y = 16 + ri * (h + 44)
            dr.text((x, y), name.replace('.png', ''), fill=(20, 20, 30))
            out.paste(im.resize((W, int(im.height * W / im.width))), (x, y + 20))
    p = os.path.join(D, f'montage-{dev}.png'); out.save(p); print('wrote', p, out.size)
