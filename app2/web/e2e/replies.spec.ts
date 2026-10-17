import { expect, test, type Page } from '@playwright/test';

// Replies actions and the current-tab scroll to top. Synthetic data only.

// Record what "Copy and open LinkedIn" copies and opens, instead of leaving the app. `copyFails` makes the clipboard refuse.
const stubOutbound = (page: Page, copyFails = false) => page.addInitScript((fail) => {
  const w = window as unknown as { __copied?: string; __opened?: string[] };
  w.__opened = [];
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: (t: string) => (fail ? Promise.reject(new Error('denied')) : (w.__copied = t, Promise.resolve())) } });
  HTMLAnchorElement.prototype.click = function () { w.__opened!.push(this.href); };
}, copyFails);

test('Draft an answer opens Ari\'s draft; Copy and open LinkedIn copies it and opens the inbox', async ({ page, browserName }) => {
  await stubOutbound(page);
  await page.goto('/#/replies');
  await page.getByRole('button', { name: 'Draft an answer' }).click();
  const box = page.getByTestId('draft-r-1').locator('textarea');
  await expect(box).toHaveValue(/^Thanks Jamie\./);
  await expect(page.getByTestId('draft-r-1')).toContainText("Ari's draft");
  await box.fill('Thanks Jamie. Short answer: yes, it fits your stack.');
  await page.getByRole('button', { name: 'Copy and open LinkedIn' }).click();
  await expect(page.getByRole('status')).toHaveText('Copied. Opening LinkedIn.');
  const out = await page.evaluate(() => { const w = window as unknown as { __copied: string; __opened: string[] }; return { __copied: w.__copied, __opened: w.__opened }; });
  expect(out.__copied).toBe('Thanks Jamie. Short answer: yes, it fits your stack.');
  expect(out.__opened).toEqual([browserName === 'chromium' // Pixel 7 UA: Android intent. iPhone UA: universal link.
    ? 'intent://www.linkedin.com/messaging/#Intent;scheme=https;package=com.linkedin.android;S.browser_fallback_url=https%3A%2F%2Fwww.linkedin.com%2Fmessaging%2F;end'
    : 'https://www.linkedin.com/messaging/']);
  await page.getByRole('button', { name: 'Hide draft' }).click();
  await expect(page.getByRole('button', { name: 'Draft an answer' })).toBeVisible();
});

test('Copy failure selects the text and does not open LinkedIn', async ({ page }) => {
  await stubOutbound(page, true);
  await page.goto('/#/replies');
  await page.getByRole('button', { name: 'Draft an answer' }).click();
  await expect(page.getByTestId('draft-r-1').locator('textarea')).not.toHaveValue('');
  await page.getByRole('button', { name: 'Copy and open LinkedIn' }).click();
  await expect(page.getByRole('status')).toHaveText('Copy failed. Text selected.');
  const sel = await page.evaluate(() => { const t = document.activeElement as HTMLTextAreaElement; return t.tagName === 'TEXTAREA' && t.selectionEnd - t.selectionStart === t.value.length; });
  expect(sel).toBe(true);
  expect(await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).toEqual([]);
});

test('Not now moves the reply out of Replies and the Today pin; Undo and Move back return it', async ({ page }) => {
  await page.goto('/#/replies');
  const rows = page.getByTestId('replies').locator('li');
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(rows).toHaveCount(0);
  await expect(page.getByText('No new replies.')).toBeVisible();
  await expect(page.getByTestId('toast')).toContainText('Moved to Not now.');
  await page.getByTestId('toast').getByRole('button', { name: 'Undo' }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId('toast')).toHaveCount(0);

  await page.getByRole('button', { name: 'Not now' }).click();
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByTestId('reply-pin')).toHaveCount(0);
  await page.getByRole('link', { name: 'Replies' }).click();
  await expect(page.getByTestId('not-now').locator('li')).toHaveCount(1);
  await page.getByRole('button', { name: 'Move back to replies' }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId('not-now')).toHaveCount(0);
});

test('Not now Undo window closes after 10 s; Move back still works', async ({ page }) => {
  await page.clock.install();
  await page.goto('/#/replies');
  await page.getByRole('button', { name: 'Not now' }).click();
  await expect(page.getByTestId('toast')).toBeVisible();
  await page.clock.runFor(10_001);
  await expect(page.getByTestId('toast')).toHaveCount(0);
  await page.getByRole('button', { name: 'Move back to replies' }).click();
  await expect(page.getByTestId('replies').locator('li')).toHaveCount(1);
});

// Tall content (test only) so the screen really scrolls; the app scrolls the window today.
const tall = (page: Page) => page.addStyleTag({ content: 'main.screen { padding-bottom: 3000px !important; }' });
const y = (page: Page) => page.evaluate(() => scrollY);

for (const [path, tab, heading] of [['/#/replies', 'Replies', 'h-rep'], ['/#/report', 'Report', 'h-rep2'], ['/', 'Today', 'h-today']] as const) {
  test(`current tab "${tab}" scrolls the screen to the top and focuses its heading`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('main h1')).toBeVisible();
    await tall(page);
    await page.evaluate(() => scrollTo(0, 1200));
    expect(await y(page)).toBeGreaterThan(1000);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: tab }).click();
    await expect.poll(() => y(page)).toBe(0);
    expect(page.url()).toContain(path === '/' ? '/' : path);
    await expect(page.locator('main h1')).toBeFocused();
    void heading;
  });
}

test('current tab jumps instantly under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/#/replies');
  await tall(page);
  await page.evaluate(() => scrollTo(0, 1500));
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Replies' }).click();
  expect(await y(page)).toBe(0); // no polling: an instant jump is done by the time the click returns
});

test('current tab already at the top still answers: heading takes focus', async ({ page }) => {
  await page.goto('/#/report');
  await expect(page.getByTestId('report')).toBeVisible();
  expect(await y(page)).toBe(0);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Report' }).click();
  await expect(page.locator('main h1')).toBeFocused();
  expect(page.url()).toMatch(/#\/report$/);
});

test('a tab that is not current still navigates', async ({ page }) => {
  await page.goto('/#/replies');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Report' }).click();
  await expect(page).toHaveURL(/#\/report$/);
  await expect(page.getByTestId('report')).toBeVisible();
});
