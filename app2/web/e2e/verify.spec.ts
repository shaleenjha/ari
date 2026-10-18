import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { MAX_CLS } from '../scripts/design-lint/rules.mjs';
import { meter } from './meter';

// verify-mobile (v18.15.0): Victor's machine review before Owner's glass check. WebKit iPhone 14 (webkit-390) and Chromium
// Pixel 7 (chromium-412). Synthetic fixture data only (mock build, ?delay= holds every fixture response so the skeleton
// shows). Per screen: skeleton + populated screenshots, CLS (budget MAX_CLS, both engines), LCP (Chromium with CDP
// network + CPU throttling, gate < 1.2 s; WebKit report-only when the browser has the API), uncaught page errors +
// console errors (gate 0). Rows go to test-results/verify-mobile/rows; scripts/verify-summary.mjs builds the table.
// Run with `npm run verify:mobile`; excluded from `npm run e2e` and the design lint.

const OUT = join(process.cwd(), 'test-results', 'verify-mobile');
const LCP_GATE_MS = 1200;
const DEVICES: Record<string, string> = { 'webkit-390': 'webkit-iphone14', 'chromium-412': 'chromium-pixel7' };
const SCREENS = [
  { name: 'Today', slug: 'today', hash: '#/', loaded: 'queue' },
  { name: 'Replies', slug: 'replies', hash: '#/replies', loaded: 'replies' },
  { name: 'Report', slug: 'report', hash: '#/report', loaded: 'report' },
] as const;
const HOLD = 1500;

function lcpProbe() {
  const w = window as unknown as { __lcp: number | null };
  w.__lcp = null;
  try {
    if (!PerformanceObserver.supportedEntryTypes?.includes('largest-contentful-paint')) return;
    w.__lcp = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__lcp = Math.max(w.__lcp ?? 0, e.startTime); })
      .observe({ type: 'largest-contentful-paint', buffered: true });
  } catch { w.__lcp = null; }
}

for (const s of SCREENS) {
  test(`@verify ${s.name}: screenshots, CLS, LCP, errors`, async ({ page, browserName }, info) => {
    const device = DEVICES[info.project.name];
    test.skip(!device, 'verify-mobile runs on webkit-390 (iPhone 14) and chromium-412 (Pixel 7) only');
    mkdirSync(join(OUT, 'rows'), { recursive: true });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.addInitScript(meter);
    await page.addInitScript(lcpProbe);

    // 1. Skeleton (fixture held), then populated. CLS measured across that swap.
    await page.goto(`/?delay=${HOLD}${s.hash}`);
    await expect(page.getByTestId('skeleton')).toBeVisible();
    const shots: [string, string] = [`${device}-${s.slug}-skeleton.png`, `${device}-${s.slug}-populated.png`];
    await page.screenshot({ path: join(OUT, shots[0]) });
    await expect(page.getByTestId(s.loaded)).toBeVisible({ timeout: 10_000 });
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(OUT, shots[1]) });
    const c = await page.evaluate(() => (window as unknown as { __cls: { native: number; frame: number } }).__cls);
    const cls = Math.max(c.native, c.frame);

    // 2. LCP: a fresh load with no hold. Chromium throttled over CDP (4x CPU, 40 ms RTT, 10/5 Mbps).
    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: (10 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 });
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    }
    await page.goto('about:blank');
    await page.goto(`/${s.hash}`);
    await expect(page.getByTestId(s.loaded)).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);
    const lcpRaw = await page.evaluate(() => (window as unknown as { __lcp: number | null }).__lcp);
    const lcp = lcpRaw ? Math.round(lcpRaw) : null;

    const gated = browserName === 'chromium';
    const pass = cls <= MAX_CLS && errors.length === 0 && (!gated || (lcp != null && lcp < LCP_GATE_MS));
    const row = { screen: s.name, engine: device, cls: Number(cls.toFixed(4)), clsBudget: MAX_CLS, lcpMs: lcp, lcpGated: gated, lcpGateMs: LCP_GATE_MS,
      consoleErrors: errors.length, errors: errors.slice(0, 10), screenshots: shots, pass };
    writeFileSync(join(OUT, 'rows', `${s.slug}-${device}.json`), JSON.stringify(row, null, 2));
    console.log(`verify ${s.name} ${device}: CLS ${row.cls} LCP ${lcp ?? 'n/a'} errors ${errors.length} ${pass ? 'pass' : 'FAIL'}`);

    expect(errors, 'uncaught page errors + console errors').toEqual([]);
    expect(cls, 'CLS skeleton -> populated').toBeLessThanOrEqual(MAX_CLS);
    if (gated) { expect(lcp, 'LCP (Chromium, throttled)').not.toBeNull(); expect(lcp!).toBeLessThan(LCP_GATE_MS); }
  });
}
