import { expect, test } from '@playwright/test';

// v18.14.4: Report tiles as a description list, skip link, the read-only line, fixed placeholders and the font fallback.
// Synthetic data only.

test('Report tiles are a <dl>: each tile is a dt label and a dd value, value shown first', async ({ page }) => {
  await page.goto('/#/report');
  const dl = page.getByTestId('report');
  await expect(dl).toHaveJSProperty('tagName', 'DL');
  await expect(dl.locator('dt')).toHaveText(['01Meetings from Ari', '02Replies', '03Accepts', '04Connects', '05Accept to DM1 · goal 4 h']);
  await expect(dl.locator('dd')).toHaveCount(5);
  const tile = dl.locator('.stat').last();
  const dd = await tile.locator('dd').boundingBox(); const dt = await tile.locator('dt').boundingBox();
  expect(dd!.y).toBeLessThan(dt!.y);
});

test('skip link: no size until focused, then a 48px target that moves focus to the screen', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'WebKit only tabs to links with the Option key; the link is still focusable there');
  await page.goto('/#/');
  await expect(page.getByTestId('queue')).toBeVisible();
  const skip = page.getByTestId('skip-link');
  expect((await skip.boundingBox())?.height ?? 0).toBe(0);
  await page.keyboard.press('Tab');
  await expect(skip).toBeFocused();
  const b = await skip.boundingBox();
  expect(b!.height).toBeGreaterThanOrEqual(48);
  await expect(skip).toHaveText('Skip to content');
  await page.keyboard.press('Enter');
  await expect(page.locator('main#main')).toBeFocused();
  expect(page.url()).not.toContain('#main');
});

test('read-only: one quiet line under the pill; the toast is unchanged', async ({ page }) => {
  await page.goto('/?ro=1#/replies');
  await expect(page.getByTestId('ro-line')).toHaveText('Preview · actions off');
  await expect(page.getByTestId('ro-line')).toHaveCount(1);
  await page.getByTestId('replies').getByRole('button', { name: 'Not now' }).first().dispatchEvent('click');
  await expect(page.getByTestId('ro-toast')).toHaveText('Read-only preview');
  await page.goto('/#/replies');
  await expect(page.getByTestId('replies')).toBeVisible();
  await expect(page.getByTestId('ro-line')).toHaveCount(0);
});

test('placeholders: Today rows at the real row height, no loading text, static under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?delay=3000#/');
  const sk = page.getByTestId('skeleton');
  await expect(sk).toBeVisible();
  await expect(page.getByText('Loading your queue…')).toHaveCount(0);
  await expect(sk.locator('li.row')).toHaveCount(5);                       // nothing cached yet: 5
  const anim = await sk.locator('.bar').first().evaluate((e) => getComputedStyle(e).animationName);
  expect(anim).toBe('none');
  const bg = await sk.locator('.bar').first().evaluate((e) => getComputedStyle(e).backgroundImage);
  expect(bg).toBe('none');
  const skelRow = await sk.locator('li.row').first().evaluate((e) => e.getBoundingClientRect().height);
  await expect(page.getByTestId('queue')).toBeVisible({ timeout: 10_000 });
  const realRow = await page.getByTestId('queue').locator('li.row').first().evaluate((e) => e.getBoundingClientRect().height);
  expect(Math.abs(skelRow - realRow)).toBeLessThanOrEqual(0.5);
  expect(realRow).toBeGreaterThanOrEqual(56);
  // Next visit: as many placeholder rows as the queue had.
  const n = await page.getByTestId('queue').locator('li').count();
  await page.goto('about:blank');
  await page.goto('/?delay=3000#/');
  await expect(page.getByTestId('skeleton').locator('li.row')).toHaveCount(n);
});

test('Replies: the draft box holds six lines while the draft loads (S2: no visible draft label)', async ({ page }) => {
  await page.goto('/#/replies');
  await page.getByTestId('replies').getByRole('button', { name: 'Draft an answer' }).first().click();
  const box = page.getByTestId('draft-r-1');
  expect((await box.locator('textarea').boundingBox())!.height).toBeGreaterThanOrEqual(144);
  await expect(box.locator('.draft > span.sr-only')).toHaveCount(1);
});

test('font: Instrument Sans first, metric-matched fallbacks next, and the fallback faces carry the overrides', async ({ page }) => {
  await page.goto('/#/');
  const fam = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
  // Chromium quotes family names with spaces, WebKit does not: compare without quotes.
  expect(fam.replace(/["']/g, '')).toMatch(/^Instrument Sans, IS Fallback A, IS Fallback R, /);
  // Read the shipped stylesheet itself: the CSSOM drops descriptors an engine does not support (WebKit lacks the overrides,
  // so there it falls back to size-adjust alone or to the next family).
  const css = await page.evaluate(async () => {
    const hrefs = [...document.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet]')].map((l) => l.href);
    const inline = [...document.querySelectorAll('style')].map((s) => s.textContent ?? '');
    return [...inline, ...(await Promise.all(hrefs.map(async (h) => (await fetch(h)).text())))].join('\n');
  });
  const fb = css.match(/@font-face\s*\{[^}]*font-family:\s*["']?IS Fallback A["']?\s*;[^}]*\}/)?.[0] ?? '';
  expect(fb, 'IS Fallback A face').not.toBe('');
  for (const k of ['size-adjust', 'ascent-override', 'descent-override', 'line-gap-override']) expect(fb).toContain(k);
  expect(await page.locator('link[rel=preload][href="/fonts/instrument-sans-latin-wght.woff2"]').count()).toBe(1);
});
