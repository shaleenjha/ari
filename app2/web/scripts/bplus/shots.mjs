#!/usr/bin/env node
// B+ shell screenshots (demo data): 8 states x light and dark x iPhone 14 and Pixel 7 sizes, plus a layout check per shot
// (horizontal overflow, clipped text). Needs a running preview: BASE=http://localhost:4173 (default).
// Writes PNGs and shots.json to OUT (default ../../work/app2-shell-shots relative to app2/web). Chromium only; set
// PW_CHROMIUM_PATH on hosts without Playwright's browser. iPhone 14 is emulated in Chromium (390x844 at 3x).
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://localhost:4173';
const OUT = resolve(process.env.OUT ?? '../../work/app2-shell-shots');
const DEVICES = [
  { name: 'iphone14', viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 },
  { name: 'pixel7', viewport: { width: 412, height: 915 }, deviceScaleFactor: 2.625 },
];
const STATES = [
  { key: '1-stack', hash: '#/stack' },
  { key: '2-pass-open', hash: '#/stack?pass=dm1' },
  { key: '3-sent-it', hash: '#/stack?pass=dm1', act: async (p) => { await p.getByTestId('copy-open').click(); await p.getByTestId('sent-it').waitFor(); } },
  { key: '4-desk', hash: '#/desk' },
  { key: '5-motion', hash: '#/motion/halvenquist' },
  { key: '6-accounts', hash: '#/stack?sheet=accounts' },
  { key: '7-account', hash: '#/account' },
  { key: '8-signin', hash: '#/signin' },
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {});
const report = [];
for (const d of DEVICES) for (const theme of ['light', 'dark']) {
  const ctx = await browser.newContext({ viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, isMobile: true, hasTouch: true, colorScheme: theme });
  await ctx.addInitScript(() => { window.open = () => null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => undefined } }); });
  for (const s of STATES) {
    const page = await ctx.newPage();
    await page.goto(`${BASE}/b.html?theme=${theme}${s.hash}`);
    await page.waitForSelector('.app, .signin');
    await page.evaluate(() => document.fonts.ready);
    if (s.act) await s.act(page);
    await page.waitForTimeout(400);
    const issues = await page.evaluate(() => {
      const out = [];
      if (document.documentElement.scrollWidth > innerWidth + 1) out.push(`page scrolls sideways: ${document.documentElement.scrollWidth} > ${innerWidth}`);
      for (const el of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(el);
        if (!el.childNodes.length || ![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || el.closest('.vh')) continue;
        if (r.right > innerWidth + 1 || r.left < -1) out.push(`off screen: "${el.textContent.trim().slice(0, 30)}"`);
        if (el.scrollWidth > el.clientWidth + 1 && cs.overflow !== 'visible' && cs.textOverflow !== 'ellipsis') out.push(`clipped: "${el.textContent.trim().slice(0, 30)}"`);
      }
      return out;
    });
    const file = `${d.name}-${theme}-${s.key}.png`;
    await page.screenshot({ path: resolve(OUT, file) });
    report.push({ file, issues });
    await page.close();
  }
  await ctx.close();
}
await browser.close();
writeFileSync(resolve(OUT, 'shots.json'), JSON.stringify(report, null, 2));
const bad = report.filter((r) => r.issues.length);
console.log(`${report.length} shots in ${OUT}; ${bad.length} with layout issues`);
for (const b of bad) console.log(b.file, b.issues);
