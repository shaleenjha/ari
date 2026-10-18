import { expect, test } from '@playwright/test';

// S2 (v18.17.0) airplane-mode cold load: once the service worker has installed, a reload with no network still paints the
// shell in Instrument Sans with the S2 icons. The font is precached by public/sw.js; the sprite is inlined in the cached
// index.html (vite.config.ts), so it needs no request. Mock build (synthetic rows in the bundle). Chromium Pixel 7 only:
// Playwright's WebKit does not run service workers.
test.beforeEach(({}, info) => {
  test.skip(info.project.name !== 'chromium-412', 'offline shell: Chromium Pixel 7 (service workers)');
});

test('airplane mode cold load: Instrument Sans and the icon sprite render from the cache', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('queue')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  // The first load is not controlled yet; reload once online so the worker serves and caches the shell and assets.
  await page.reload();
  await expect(page.getByTestId('queue')).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const cached = await page.evaluate(async () => {
    const keys = await caches.keys();
    const c = await caches.open(keys.find((k) => k.startsWith('ari-app2-shell-'))!);
    return { keys, font: !!(await c.match('/fonts/instrument-sans-latin-wght.woff2')), shell: !!(await c.match('/')) };
  });
  expect(cached.keys).toContain('ari-app2-shell-v8');
  expect(cached.font, 'font precached').toBe(true);
  expect(cached.shell, 'shell cached').toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('queue')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => document.fonts.ready);
  const r = await page.evaluate(() => {
    const use = document.querySelector('nav .ic use');
    const box = document.querySelector('nav .ic')!.getBoundingClientRect();
    return {
      font: [...document.fonts].some((f) => f.family.replace(/['"]/g, '') === 'Instrument Sans' && f.status === 'loaded'),
      symbols: document.querySelectorAll('#ari-sprite symbol').length,
      href: use?.getAttribute('href'),
      resolved: !!document.querySelector(use?.getAttribute('href') ?? '#none'),
      w: box.width, h: box.height,
    };
  });
  expect(r.font, 'Instrument Sans loaded offline').toBe(true);
  expect(r.symbols, 'sprite inlined').toBe(19);
  expect(r.resolved, `${r.href} resolves`).toBe(true);
  expect([r.w, r.h]).toEqual([24, 24]);
  await context.setOffline(false);
});
