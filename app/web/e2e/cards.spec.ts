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
  await expect(page.getByTestId('tidy-count')).toHaveText('0 to check');
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

// v18.17.2: each option is a clean block at any phone text size: at least 48 tall (min-height, not a fixed height), the
// name on one line, company · role on the next, and every line 8 px or more clear of the drawn outline (4 px inset).
test('Who is this?: option buttons hold their padding at 100% and 130% text size', async ({ page }) => {
  await page.goto('/');
  const card = page.getByTestId('who-ev-1');
  await expect(card.getByRole('button')).toHaveCount(3);
  for (const scale of [1, 1.3]) {
    await page.evaluate((k) => { document.documentElement.style.fontSize = `${16 * k}px`; }, scale);
    const bad = await card.evaluate((c) => {
      const out: string[] = [];
      for (const b of c.querySelectorAll<HTMLButtonElement>('button')) {
        const r = b.getBoundingClientRect();
        if (r.height < 48) out.push(`${b.textContent} height ${r.height}`);
        const range = document.createRange(); range.selectNodeContents(b);
        for (const t of range.getClientRects()) {
          if (t.top - (r.top + 4) < 7.5 || (r.bottom - 4) - t.bottom < 7.5) out.push(`${b.textContent} line ${Math.round(t.top - r.top)}..${Math.round(r.bottom - t.bottom)} from edge`);
          if (t.left - r.left < 12 || r.right - t.right < 0) out.push(`${b.textContent} line ${Math.round(t.left - r.left)} from left`);
        }
        const name = b.querySelector('b');
        if (name) {
          const lh = parseFloat(getComputedStyle(name).lineHeight);
          if (name.getBoundingClientRect().height > lh * 1.05) out.push(`${name.textContent} wraps`);
        }
      }
      return out;
    });
    expect(bad, `text size ${scale * 100}%`).toEqual([]);
  }
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
