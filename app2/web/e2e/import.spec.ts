import { expect, test } from '@playwright/test';
import { SAMPLE_CSV } from '../src/data/fixtures/importPlans';

// Import a CSV over the synthetic import plans (mock mode). The approve key never writes: it stays aria-disabled and only
// says so. 360 / 390 / 412 px, Chromium + WebKit.
const csv = (text: string) => ({ name: 'leads.csv', mimeType: 'text/csv', buffer: Buffer.from(text) });

test('Import: pick a CSV, see the plan, change a fix, the label follows, approve writes nothing', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
  const writes: string[] = []; page.on('request', (r) => { if (!['GET', 'HEAD'].includes(r.method())) writes.push(`${r.method()} ${r.url()}`); });
  await page.goto('/#/report');
  await page.getByTestId('import-link').click();
  await expect(page.locator('#h-imp')).toHaveText('Import');
  await page.getByTestId('import-file').setInputFiles(csv(SAMPLE_CSV));
  await expect(page.getByTestId('import-plan')).toBeVisible();
  await expect(page.getByTestId('import-facts')).toContainText('6 rows to check');
  await expect(page.getByTestId('import-adds')).toContainText('2 ready to add');
  const approve = page.getByTestId('import-approve');
  await expect(approve).toHaveText('Add 3, skip 1 duplicate, use 1 found profile, park 2');
  await expect(approve).toHaveAttribute('aria-disabled', 'true');
  // found profile: confidence and source shown quietly, no Search link while the profile is chosen
  await expect(page.getByTestId('flag-3-source')).toHaveText('92% match · web search (Same name and company)');
  await expect(page.getByTestId('flag-3-search')).toHaveCount(0);
  // parked row: Search opens a new tab
  const search = page.getByTestId('flag-5-search');
  await expect(search).toHaveAttribute('target', '_blank');
  await expect(search).toHaveAttribute('href', /google\.com\/search/);
  // pick one of the two possible profiles: the label recomputes, the Search link goes
  await page.getByTestId('flag-4').getByRole('radio', { name: 'VP Engineering at Clovardine Labs' }).check();
  await expect(approve).toHaveText('Add 4, skip 1 duplicate, use 2 found profiles, park 1');
  await expect(page.getByTestId('flag-4-search')).toHaveCount(0);
  await expect(page.getByTestId('flag-4').getByRole('radio', { checked: true })).toHaveCount(1);
  // aria-disabled on purpose (it explains instead of writing); Playwright refuses aria-disabled clicks, so force it
  await approve.click({ force: true });
  await expect(page.getByTestId('import-off')).toContainText('Nothing was added');
  expect(writes).toEqual([]);
  // every option and the key are 48 px or more
  for (const el of await page.locator('[data-testid="import-plan"] label, [data-testid="import-plan"] a, [data-testid="import-plan"] button').all()) {
    expect((await el.boundingBox())!.height).toBeGreaterThanOrEqual(48);
  }
  const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  expect(sw).toBeLessThanOrEqual(cw);
  expect(errors).toEqual([]);
});

test('Import: a file over 100 rows says it checks the first 100; a file without a company column says why', async ({ page }) => {
  await page.goto('/#/import');
  const body = Array.from({ length: 120 }, (_, i) => `Person ${i},Company ${i},,,https://www.linkedin.com/in/person-${i}-example`).join('\n');
  await page.getByTestId('import-file').setInputFiles(csv(`name,company,title,location,linkedin\n${body}`));
  await expect(page.getByTestId('import-capped')).toHaveText('The file has 120 rows. Ari checks the first 100. Put the rest in another file.');
  await expect(page.getByTestId('import-approve')).toHaveText('Add 100');
  await page.getByTestId('import-file').setInputFiles(csv('name,title\nA Person,Director'));
  await expect(page.getByTestId('import-error')).toContainText('This file needs a name column and a company column.');
});
