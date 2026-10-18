import { expect, test } from '@playwright/test';

// Phase 1 read-only UI, over synthetic rows (?ro=1). Live mode renders the same way once signed in.
const TOAST = 'Read-only preview. Actions arrive in Phase 2.';

test('one quiet Read-only pill; write controls are aria-disabled (not native disabled) and a tap only shows the toast', async ({ page }) => {
  await page.goto('/?ro=1#/replies');
  await expect(page.getByTestId('ro-pill')).toHaveText('Read-only');
  await expect(page.getByTestId('ro-pill')).toHaveCount(1);
  const draft = page.getByTestId('replies').getByRole('button', { name: 'Draft an answer' }).first();
  await expect(draft).toHaveAttribute('aria-disabled', 'true');
  await expect(draft).not.toHaveAttribute('disabled');     // no native disabled: it stays focusable and tappable
  // Playwright will not click an aria-disabled control on its own; a person can, so send the click straight to it.
  await draft.dispatchEvent('click');
  await expect(page.getByTestId('ro-toast')).toHaveText(TOAST);
  await expect(page.locator('[data-testid^="draft-"]')).toHaveCount(0);
  await page.getByTestId('replies').getByRole('button', { name: 'Not now' }).first().dispatchEvent('click');
  await expect(page.getByTestId('not-now')).toHaveCount(0);
  await expect(page.getByText(/coming soon/i)).toHaveCount(0);
});

test("Today's 15 and Tidy up refuse quietly; nothing changes", async ({ page }) => {
  await page.goto('/?ro=1#/today15');
  const mark = page.getByTestId('today15').getByRole('button', { name: 'Mark sent' }).first();
  await expect(mark).toHaveAttribute('aria-disabled', 'true');
  await mark.dispatchEvent('click');
  await expect(page.getByTestId('ro-toast')).toBeVisible();
  await expect(page.getByTestId('today15').getByRole('button', { name: 'Sent', exact: true })).toHaveCount(0);
  await page.goto('about:blank');
  await page.goto('/?ro=1#/');
  await page.getByTestId('tidy-up').getByRole('button', { name: /Tidy up/ }).click();
  await page.getByTestId('finding-f-2').getByRole('button', { name: 'Merge' }).dispatchEvent('click');
  await expect(page.getByRole('group', { name: 'Which one stays?' })).toHaveCount(0);
  await expect(page.getByTestId('tidy-count')).toHaveText('3 to check');
  await expect(page.getByTestId('ro-toast')).toBeVisible();
  await expect(page.getByTestId('ro-toast')).toHaveCount(0, { timeout: 5000 });   // it goes away on its own
});

test('mock mode keeps every action working and shows no pill', async ({ page }) => {
  await page.goto('/#/replies');
  await expect(page.getByTestId('replies').locator('li').first()).toBeVisible();
  await expect(page.getByTestId('ro-pill')).toHaveCount(0);
  const draft = page.getByTestId('replies').getByRole('button', { name: 'Draft an answer' }).first();
  await expect(draft).not.toHaveAttribute('aria-disabled', 'true');
  await draft.click();
  await expect(page.getByTestId('draft-r-1')).toBeVisible();
});
