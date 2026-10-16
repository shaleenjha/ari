import { expect, test } from '@playwright/test';

// Keep-list shells at 360 / 412 px in Chromium + WebKit, synthetic data only.
test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  (page as unknown as { _errs: string[] })._errs = errors;
});

const noHorizontalScroll = async (page: import('@playwright/test').Page) => {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
};

test('Today shows reply pin, Today\'s 15 link and queue', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();
  await expect(page.getByTestId('reply-pin')).toContainText('1 new reply');
  await expect(page.getByTestId('queue').locator('li')).toHaveCount(3);
  await noHorizontalScroll(page);
});

test("Today's 15 caps per account and marks sent", async ({ page }) => {
  await page.goto('/#/today15');
  const rows = page.getByTestId('today15').locator('li');
  await expect(rows).toHaveCount(9);
  await rows.first().getByRole('button', { name: 'Mark sent' }).click();
  await expect(rows.first().getByRole('button')).toHaveText('Sent');
  await noHorizontalScroll(page);
});

test('Replies list and Account room with labelled brief', async ({ page }) => {
  await page.goto('/#/replies');
  await expect(page.getByTestId('replies').locator('li')).toHaveCount(1);
  await page.goto('/#/account/acc-1');
  await expect(page.getByRole('heading', { name: 'Ostrevanthe Co' })).toBeVisible();
  await expect(page.getByTestId('brief')).toContainText('Verified');
  await expect(page.getByTestId('acc-tasks')).toContainText('AE');
  await noHorizontalScroll(page);
});

test('Report leads with Ari meetings; tabs are 44px+ tap targets', async ({ page }) => {
  await page.goto('/#/report');
  await expect(page.getByTestId('report').locator('.stat').first()).toContainText('Meetings from Ari');
  for (const t of await page.getByRole('navigation', { name: 'Main' }).getByRole('link').all()) {
    const b = await t.boundingBox();
    expect(b!.height).toBeGreaterThanOrEqual(44);
  }
  expect((page as unknown as { _errs: string[] })._errs).toEqual([]);
});
