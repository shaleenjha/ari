import { expect, test, type Page } from '@playwright/test';
import { MAX_CLS } from '../scripts/design-lint/rules.mjs';

// Design lint, layout stability (Victor + Hark spec, v18.14.4): from placeholders to loaded data, Today, Replies and Report
// shift by at most MAX_CLS. Synthetic data, every mock response held by ?delay=, so the placeholders really render.
// Two meters, both must pass: the browser's own layout-shift entries (Chromium; WebKit has none) and a frame-by-frame
// meter that runs in every engine. The frame meter follows the CLS definition for one frame: elements that were on screen
// in the last frame and moved; impact = their old and new boxes, unioned, as a share of the viewport (grid sampled);
// distance = the largest move over the larger viewport side; score = impact x distance, summed over frames.

const DELAY = 700;

function meter() {
  const w = window as unknown as { __cls: { native: number; frame: number; moves: string[] } };
  w.__cls = { native: 0, frame: 0, moves: [] };
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.__cls.native += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  } catch { /* no Layout Instability API (WebKit) */ }
  const prev = new WeakMap<Element, DOMRect>();
  const tick = () => {
    const vw = innerWidth; const vh = innerHeight; const boxes: [number, number, number, number][] = []; let far = 0;
    for (const el of document.querySelectorAll('#root *')) {
      const r = el.getBoundingClientRect();
      if (!r.width && !r.height) continue;
      const abs = new DOMRect(r.x + scrollX, r.y + scrollY, r.width, r.height);
      const p = prev.get(el);
      prev.set(el, abs);
      if (!p || (Math.abs(p.x - abs.x) < 0.5 && Math.abs(p.y - abs.y) < 0.5)) continue;
      far = Math.max(far, Math.abs(p.x - abs.x), Math.abs(p.y - abs.y));
      for (const b of [p, abs]) boxes.push([b.x - scrollX, b.y - scrollY, b.right - scrollX, b.bottom - scrollY]);
      if (w.__cls.moves.length < 10) w.__cls.moves.push(`${el.tagName.toLowerCase()}.${(el as HTMLElement).className} ${Math.round(abs.y - p.y)}px`);
    }
    if (boxes.length) {
      const N = 40; let hit = 0;
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const x = (i + 0.5) * vw / N; const y = (j + 0.5) * vh / N;
        if (boxes.some(([a, b, c, d]) => x >= a && x <= c && y >= b && y <= d)) hit++;
      }
      w.__cls.frame += (hit / (N * N)) * (far / Math.max(vw, vh));
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const SCREENS = [
  { name: 'Today', hash: '#/', loaded: 'queue', box: 'section' },
  { name: 'Replies', hash: '#/replies', loaded: 'replies', box: null },
  { name: 'Report', hash: '#/report', loaded: 'report', box: 'dl' },
] as const;

async function measure(page: Page, hash: string, loaded: string, box: string | null) {
  await page.goto('about:blank');
  await page.goto(`/?delay=${DELAY}${hash}`);
  await expect(page.getByTestId('skeleton')).toBeVisible();
  const before = box ? await page.locator(`main ${box}`).first().evaluate((e) => e.getBoundingClientRect().height) : null;
  await expect(page.getByTestId(loaded)).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const after = box ? await page.locator(`main ${box}`).first().evaluate((e) => e.getBoundingClientRect().height) : null;
  const cls = await page.evaluate(() => (window as unknown as { __cls: { native: number; frame: number; moves: string[] } }).__cls);
  return { ...cls, before, after };
}

for (const s of SCREENS) {
  test(`@design ${s.name}: layout shift from placeholders to data ≤ ${MAX_CLS}`, async ({ page }, info) => {
    await page.addInitScript(meter);
    // First visit on this device: placeholders use the defaults.
    const cold = await measure(page, s.hash, s.loaded, null);
    // Next visit: placeholders take the shape of the last loaded screen, so the box keeps its height.
    const warm = await measure(page, s.hash, s.loaded, s.box);
    info.annotations.push({ type: 'cls', description: `${s.name} ${info.project.name}: cold native ${cold.native.toFixed(4)} frame ${cold.frame.toFixed(4)}; warm native ${warm.native.toFixed(4)} frame ${warm.frame.toFixed(4)}; box ${warm.before} -> ${warm.after}` });
    console.log(`CLS ${s.name} ${info.project.name}: cold native=${cold.native.toFixed(4)} frame=${cold.frame.toFixed(4)} | warm native=${warm.native.toFixed(4)} frame=${warm.frame.toFixed(4)} box ${warm.before}->${warm.after} ${warm.moves.join('; ')}`);
    for (const m of [cold, warm]) {
      expect(m.native, `native layout shift ${m.moves.join('; ')}`).toBeLessThanOrEqual(MAX_CLS);
      expect(m.frame, `frame layout shift ${m.moves.join('; ')}`).toBeLessThanOrEqual(MAX_CLS);
    }
    if (s.box) expect(Math.abs(warm.after! - warm.before!), `${s.box} height placeholders vs data`).toBeLessThanOrEqual(2);
  });
}
