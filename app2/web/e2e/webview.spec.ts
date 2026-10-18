import { expect, test } from '@playwright/test';

// The page is never blank: link viewers get a calm "open in your browser" screen, and a failed script load still shows text
// on the dark background. Synthetic data only.

test('link viewer screen: heading, 48px open and copy buttons, Chrome intent on Android', async ({ page, browserName }) => {
  await page.goto('/?embed=1#/');
  const s = page.getByTestId('open-in-browser');
  await expect(s.getByRole('heading', { name: 'Sign-in needs your browser.' })).toBeVisible();
  const open = s.getByTestId('open-external');
  const copy = s.getByRole('button', { name: 'Copy link' });
  for (const el of [open, copy]) expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  // Local preview is http, so the button is the plain link; https builds get intent:// (Android) or x-safari-https (iOS).
  await expect(open).toHaveAttribute('href', /^http:\/\/localhost:\d+\/\?embed=1$/);
  if (browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await copy.click();
  await expect(page.getByTestId('copy-status')).toContainText(/Link copied|Copy this link/);
});

test('storage blocked by the viewer: the app still renders', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    for (const k of ['localStorage', 'sessionStorage']) Object.defineProperty(window, k, { get() { throw new DOMException('denied', 'SecurityError'); } });
  });
  await page.goto('/?embed=1#/');
  await expect(page.getByTestId('open-in-browser')).toBeVisible();
  await page.goto('/#/');
  await expect(page.getByTestId('queue')).toBeVisible();
  expect(errors).toEqual([]);
});

test('script fails to load: static text on the dark background, never a blank white page', async ({ page }) => {
  await page.route(/\/assets\/.*\.js$/, (r) => r.fulfill({ status: 404, body: '' }));
  await page.goto('/');
  await expect(page.getByTestId('boot')).toContainText('If this stays, open this link in Chrome or Safari.');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(5, 5, 5)');
});

test('normal browser: no link viewer screen', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByTestId('queue')).toBeVisible();
  await expect(page.getByTestId('open-in-browser')).toHaveCount(0);
});
