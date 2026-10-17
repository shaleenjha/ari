import { expect, test, type Page } from '@playwright/test';

// "Tidy up" and "Who is this?" on Today, over the typed REST layer + in-memory PostgREST mock. 360 / 412 px, Chromium + WebKit.
const noHorizontalScroll = async (page: Page) => {
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
};
const tapTargets = async (page: Page, sel: string) => {
  for (const b of await page.locator(sel).all()) { const box = await b.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); }
};

test('Tidy up: link, tick, merge with a keep choice, dismiss', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  const card = page.getByTestId('tidy-up');
  await expect(page.getByTestId('tidy-count')).toHaveText('3 to check');
  await card.getByRole('button', { name: /Tidy up/ }).click();
  await tapTargets(page, '[data-testid="tidy-up"] button');
  await page.getByTestId('finding-f-3').getByRole('button', { name: 'Link to Brennuvia Labs' }).click();
  await expect(page.getByTestId('finding-f-3')).toContainText('Fixed');
  await page.getByTestId('finding-f-1').getByRole('button', { name: 'Tick invite sent' }).click();
  await expect(page.getByTestId('finding-f-1')).toContainText('Fixed');
  // merge asks which account stays before anything changes
  await page.getByTestId('finding-f-2').getByRole('button', { name: 'Merge' }).click();
  const group = page.getByRole('group', { name: 'Which one stays?' });
  await expect(group).toBeVisible();
  await group.getByRole('button', { name: 'Cancel' }).click();
  await expect(group).toHaveCount(0);
  await page.getByTestId('finding-f-2').getByRole('button', { name: 'Merge' }).click();
  await page.getByRole('group', { name: 'Which one stays?' }).getByRole('button', { name: 'Keep Ostrevanthe Co', exact: true }).click();
  await expect(page.getByTestId('finding-f-2')).toContainText('Merged into Ostrevanthe Co');
  await expect(page.getByTestId('tidy-count')).toHaveText('All tidy');
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

test('Tidy up: Not an issue dismisses one finding', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('tidy-up').getByRole('button', { name: /Tidy up/ }).click();
  await page.getByTestId('finding-f-1').getByRole('button', { name: 'Not an issue' }).click();
  await expect(page.getByTestId('finding-f-1')).toContainText('Dismissed');
  await expect(page.getByTestId('tidy-count')).toHaveText('2 to check');
});

test('Who is this?: one tap links the accept to the right person', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('who-ev-1');
  await expect(card).toContainText('Jordan Leesynth accepted your invite');
  await expect(card.getByRole('button')).toHaveCount(3);
  await tapTargets(page, '[data-testid="who-ev-1"] button');
  await card.getByRole('button', { name: /Jordan Leesynth · Ostrevanthe Co/ }).click();
  await expect(card.getByRole('status')).toHaveText('Linked to Jordan Leesynth at Ostrevanthe Co');
  await expect(card.getByRole('button')).toHaveCount(0);
  await noHorizontalScroll(page);
});

test('Who is this?: None of these', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('who-ev-1').getByRole('button', { name: 'None of these' }).click();
  await expect(page.getByTestId('who-ev-1').getByRole('status')).toHaveText('Marked as none of these');
});

test('workspace B canary never renders on Today, Today\'s 15 or Replies', async ({ page }) => {
  for (const path of ['/', '/#/today15', '/#/replies']) {
    await page.goto(path);
    await expect(page.locator('main')).not.toContainText('CANARY');
  }
});
