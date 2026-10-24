import { expect, test, type Page } from '@playwright/test';
import { MAX_CLS, TODAY_MAX_CLS } from '../scripts/design-lint/rules.mjs';
import { meter, slotDrift, slots } from './meter';

// Design lint, layout stability (Victor + Hark spec, v18.14.4): from placeholders to loaded data, Today, Replies and Report
// shift by at most MAX_CLS. Synthetic data, every mock response held by ?delay=, so the placeholders really render.
// Two meters, both must pass: the browser's own layout-shift entries (Chromium; WebKit has none) and a frame-by-frame
// meter that runs in every engine. The frame meter follows the CLS definition for one frame: elements that were on screen
// in the last frame and moved; impact = their old and new boxes, unioned, as a share of the viewport (grid sampled);
// distance = the largest move over the larger viewport side; score = impact x distance, summed over frames.

const DELAY = 700;

const SCREENS = [
  { name: 'Today', hash: '#/', loaded: 'queue', box: 'section' },
  { name: 'Replies', hash: '#/replies', loaded: 'replies', box: null },
  { name: 'Report', hash: '#/report', loaded: 'report', box: 'dl' },
] as const;

async function measure(page: Page, hash: string, loaded: string, box: string | null) {
  await page.goto('about:blank');
  await page.goto(`/?delay=${DELAY}${hash}`);
  await expect(page.getByTestId('skeleton')).toBeVisible();
  const skel = await page.evaluate(slots);
  const before = box ? await page.locator(`main ${box}`).first().evaluate((e) => e.getBoundingClientRect().height) : null;
  await expect(page.getByTestId(loaded)).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  const after = box ? await page.locator(`main ${box}`).first().evaluate((e) => e.getBoundingClientRect().height) : null;
  const cls = await page.evaluate(() => (window as unknown as { __cls: { native: number; frame: number; moves: string[] } }).__cls);
  return { ...cls, before, after, skel, data: await page.evaluate(slots) };
}

for (const s of SCREENS) {
  const budget = s.name === 'Today' ? TODAY_MAX_CLS : MAX_CLS;
  test(`@design ${s.name}: layout shift from placeholders to data ≤ ${budget}`, async ({ page }, info) => {
    await page.addInitScript(meter);
    // First visit on this device: placeholders use the defaults.
    const cold = await measure(page, s.hash, s.loaded, null);
    // Next visit: placeholders take the shape of the last loaded screen, so the box keeps its height.
    const warm = await measure(page, s.hash, s.loaded, s.box);
    info.annotations.push({ type: 'cls', description: `${s.name} ${info.project.name}: cold native ${cold.native.toFixed(4)} frame ${cold.frame.toFixed(4)}; warm native ${warm.native.toFixed(4)} frame ${warm.frame.toFixed(4)}; box ${warm.before} -> ${warm.after}` });
    console.log(`CLS ${s.name} ${info.project.name}: cold native=${cold.native.toFixed(4)} frame=${cold.frame.toFixed(4)} | warm native=${warm.native.toFixed(4)} frame=${warm.frame.toFixed(4)} box ${warm.before}->${warm.after} ${warm.moves.join('; ')}`);
    for (const m of [cold, warm]) {
      expect(m.native, `native layout shift ${m.moves.join('; ')}`).toBeLessThanOrEqual(budget);
      expect(m.frame, `frame layout shift ${m.moves.join('; ')}`).toBeLessThanOrEqual(budget);
      expect(slotDrift(m.skel, m.data), 'slots that move from placeholders to data').toEqual([]);
    }
    // Today, next visit: the known shape puts Today's 15, the Up next heading and the first row where the data lands.
    if (s.name === 'Today') expect(Object.keys(warm.skel).sort()).toEqual(['row0', 'today15', 'upnext']);
    if (s.box) expect(Math.abs(warm.after! - warm.before!), `${s.box} height placeholders vs data`).toBeLessThanOrEqual(2);
  });
}
