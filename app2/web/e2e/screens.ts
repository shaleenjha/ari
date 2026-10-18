import { expect, type Page } from '@playwright/test';

// Screens the design lint walks (e2e/design.spec.ts, e2e/mobile.spec.ts). Synthetic data only.

export type Scenario = { name: string; path: string; ready: (p: Page) => Promise<void> };

export const SCREENS: Scenario[] = [
  { name: 'Today', path: '/', ready: async (p) => { await expect(p.getByTestId('queue').locator('li').first()).toBeVisible(); await expect(p.getByTestId('tidy-up')).toBeVisible(); } },
  { name: 'Today, Tidy up open', path: '/', ready: async (p) => {
    await expect(p.getByTestId('tidy-up')).toBeVisible();
    await p.getByTestId('tidy-up').getByRole('button', { name: /Tidy up/ }).click();
    await expect(p.getByTestId('finding-f-1')).toBeVisible();
  } },
  { name: 'Today, merge confirm', path: '/', ready: async (p) => {
    await p.getByTestId('tidy-up').getByRole('button', { name: /Tidy up/ }).click();
    await p.getByTestId('finding-f-2').getByRole('button', { name: 'Merge' }).click();
    await expect(p.getByRole('group', { name: 'Which one stays?' })).toBeVisible();
  } },
  { name: "Today's 15", path: '/#/today15', ready: async (p) => { await expect(p.getByTestId('today15').locator('li').first()).toBeVisible(); } },
  { name: 'Replies', path: '/#/replies', ready: async (p) => { await expect(p.getByTestId('replies').locator('li').first()).toBeVisible(); } },
  { name: 'Replies, draft open', path: '/#/replies', ready: async (p) => {
    await p.getByTestId('replies').getByRole('button', { name: 'Draft an answer' }).first().click();
    await expect(p.getByTestId('draft-r-1').locator('textarea')).not.toHaveValue('');
  } },
  { name: 'Replies, Not now', path: '/#/replies', ready: async (p) => {
    await p.getByTestId('replies').getByRole('button', { name: 'Not now' }).first().click();
    await expect(p.getByTestId('toast')).toBeVisible();
    await expect(p.getByTestId('not-now').locator('li').first()).toBeVisible();
  } },
  // Phase 1 read-only UI over synthetic rows (?ro=1): write controls aria-disabled, one pill, toast on tap.
  { name: 'Today, read-only', path: '/?ro=1#/', ready: async (p) => {
    await expect(p.getByTestId('ro-pill')).toBeVisible();
    await p.getByTestId('tidy-up').getByRole('button', { name: /Tidy up/ }).click();
    await expect(p.getByTestId('finding-f-1').getByRole('button').first()).toHaveAttribute('aria-disabled', 'true');
  } },
  { name: 'Replies, read-only', path: '/?ro=1#/replies', ready: async (p) => {
    await expect(p.getByTestId('replies').getByRole('button', { name: 'Draft an answer' }).first()).toHaveAttribute('aria-disabled', 'true');
  } },
  { name: 'Report', path: '/#/report', ready: async (p) => { await expect(p.getByTestId('report')).toBeVisible(); } },
  ...['acc-1', 'acc-2', 'acc-3'].map((id): Scenario => ({ name: `Account room ${id}`, path: `/#/account/${id}`, ready: async (p) => { await expect(p.locator('#h-acc')).toBeVisible(); } })),
];

/**
 * Load a screen fresh and wait until it is ready. Goes through about:blank first: the app routes on the hash, and a
 * goto that only changes the hash is a same-document navigation that would keep the previous state.
 */
export async function open(page: Page, s: Scenario) {
  await page.goto('about:blank');
  await page.goto(s.path);
  await s.ready(page);
  await page.evaluate(() => document.fonts.ready);
}
