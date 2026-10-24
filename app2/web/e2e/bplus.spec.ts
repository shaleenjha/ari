import { expect, test, type Page } from '@playwright/test';
import { CONTRAST_EXEMPT, MIN_TAP, checkText, contrast, requiredRatio } from '../scripts/design-lint/rules.mjs';

// B+ shell (b.html, Owner's lock Oct 24 2026). Demo data only. Behaviour runs in `npm run e2e`; the @design checks
// (tap size, contrast in light and dark, banned copy, no green) run in `npm run lint:design`.

const go = async (page: Page, hash: string, theme: 'light' | 'dark' = 'light') => {
  await page.addInitScript(() => {
    window.open = () => null;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => undefined } });
  });
  await page.goto(`/b.html?theme=${theme}${hash}`);
  await expect(page.locator('.app, .signin').first()).toBeVisible();
};

test('Stack: open a pass, copy, Sent it? Yes flies it away with Undo', async ({ page }) => {
  await go(page, '#/stack');
  await expect(page.getByTestId('workload')).toHaveText('13 things to send, about 17 minutes');
  await page.getByTestId('pass-dm1').click();
  await expect(page.getByTestId('pass-open')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Maya Sampleton');
  await page.getByTestId('copy-open').click();
  const ask = page.getByTestId('sent-it');
  await expect(ask.getByRole('heading', { name: 'Sent it?' })).toBeVisible();
  await ask.getByRole('button', { name: 'Not yet' }).click();
  await expect(ask).toHaveCount(0);
  await page.getByTestId('copy-open').click();
  await page.getByRole('button', { name: 'Yes, sent' }).click();
  await expect(page.getByTestId('toast')).toContainText('DM1 to Maya marked sent. DM2 comes up in 4 days.');
  await expect(page.getByTestId('workload')).toHaveText('12 things to send, about 15 minutes');
  await page.getByTestId('toast').getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('workload')).toHaveText('13 things to send, about 17 minutes');
});

test('Stack: Connect has no note, Waiting has nothing to send, Escape closes a pass', async ({ page }) => {
  await go(page, '#/stack?pass=connect');
  await expect(page.getByTestId('copy-open')).toHaveText('Open LinkedIn');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('workload')).toBeVisible();
  await page.getByTestId('pass-waiting').click();
  await expect(page.getByTestId('pass-open')).toContainText('Nothing to send here.');
  await expect(page.getByTestId('copy-open')).toHaveCount(0);
});

test('Places: the pill and a sideways swipe switch Stack and Desk', async ({ page }) => {
  await go(page, '#/stack');
  await page.getByRole('navigation', { name: 'Places' }).getByRole('button', { name: 'Desk' }).click();
  await expect(page.getByRole('heading', { name: 'Desk', level: 1 })).toBeVisible();
  // A sideways swipe (pointer events, as a finger sends them): right to left does nothing on Desk, left to right goes to Stack.
  const main = page.locator('main.place');
  const swipe = async (x0: number, x1: number) => {
    await main.dispatchEvent('pointerdown', { clientX: x0, clientY: 300, bubbles: true, pointerId: 1, isPrimary: true });
    await main.dispatchEvent('pointerup', { clientX: x1, clientY: 310, bubbles: true, pointerId: 1, isPrimary: true });
  };
  await swipe(340, 40);
  await expect(page.getByRole('heading', { name: 'Desk', level: 1 })).toBeVisible();
  await swipe(40, 340);
  await expect(page.getByTestId('workload')).toBeVisible();
});

test('Desk: start a motion, Ask Ari splits text into tasks, Ari suggests Do it', async ({ page }) => {
  await go(page, '#/desk');
  await page.getByTestId('motion-tolvessine').getByRole('button', { name: 'Start motion' }).click();
  await expect(page.getByTestId('running')).toContainText('Motion, Tolvessine Pharma');
  await page.getByLabel('Ask Ari').fill('research Kelvarrow Labs and then draft DM2 for Daniel. Withdraw old invites');
  await page.getByRole('button', { name: 'Split into tasks' }).click();
  await expect(page.getByTestId('tasks').locator('li')).toHaveCount(3);
  await page.getByRole('button', { name: 'Do it' }).first().click();
  await expect(page.getByTestId('toast')).toContainText('6 invites added');
});

test('Motion detail: plan shows today, close needs a second tap', async ({ page }) => {
  await go(page, '#/motion/halvenquist');
  await expect(page.locator('.plan [aria-current="step"]')).toContainText('Day 5');
  await page.getByRole('button', { name: 'Close motion' }).click();
  await page.getByRole('group').getByRole('button', { name: 'Close motion' }).click();
  await expect(page.getByTestId('motion-detail')).toContainText('Closed');
});

test('Sheets: Accounts search filters by person or company; Report compares weeks', async ({ page }) => {
  await go(page, '#/stack');
  await page.getByRole('button', { name: 'Accounts' }).click();
  const sheet = page.getByTestId('accounts-sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByLabel('Search accounts and people').fill('kelvarrow');
  await expect(sheet.locator('.acct')).toHaveCount(1);
  await page.keyboard.press('Escape'); // the first Escape clears the search field, the second closes the sheet
  await expect(sheet.getByLabel('Search accounts and people')).toHaveValue('');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await page.getByRole('button', { name: 'Report' }).click();
  await expect(page.getByTestId('report-sheet')).toContainText('DM2 A/B');
});

test('Account page: switches, steppers, Gmail disconnect asks first', async ({ page }) => {
  await go(page, '#/account');
  const accepts = page.getByRole('switch', { name: 'Accepts' });
  await expect(accepts).toHaveAttribute('aria-checked', 'true');
  await accepts.click();
  await expect(accepts).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'More, Daily connects' }).click();
  await expect(page.getByRole('group', { name: 'Daily connects' })).toContainText('16 a day');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('group', { name: 'Disconnect' }).getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByTestId('account-page')).toContainText('Not connected');
  await expect(page.getByTestId('account-page')).toContainText('Built by Owner');
});

test('Sign-in: one Continue with Google button', async ({ page }) => {
  await go(page, '#/signin');
  await expect(page.getByRole('button')).toHaveCount(1);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByTestId('workload')).toBeVisible();
});

const SCREENS: { name: string; hash: string; act?: (p: Page) => Promise<void> }[] = [
  { name: 'Stack', hash: '#/stack' },
  { name: 'Open pass', hash: '#/stack?pass=dm1', act: async (p) => { await p.getByTestId('copy-open').click(); await expect(p.getByTestId('sent-it')).toBeVisible(); } },
  { name: 'Desk', hash: '#/desk' },
  { name: 'Motion detail', hash: '#/motion/halvenquist' },
  { name: 'Accounts', hash: '#/stack?sheet=accounts' },
  { name: 'Report', hash: '#/stack?sheet=report' },
  { name: 'Account page', hash: '#/account' },
  { name: 'Sign-in', hash: '#/signin' },
];

for (const theme of ['light', 'dark'] as const) for (const s of SCREENS) {
  test(`@design B+ ${s.name} (${theme}): tap size, contrast, copy, no green`, async ({ page }) => {
    await go(page, s.hash, theme);
    if (s.act) await s.act(page);
    await page.waitForTimeout(450);
    const r = await page.evaluate(({ min, exempt }) => {
      const parse = (c: string) => { const m = c.match(/rgba?\(([^)]+)\)/); const p = m ? m[1]!.split(/[ ,/]+/).filter(Boolean).map(Number) : [0, 0, 0, 0]; return [p[0]!, p[1]!, p[2]!, p[3] ?? 1]; };
      const over = (t: number[], u: number[]) => [0, 1, 2].map((i) => t[i]! * t[3]! + u[i]! * (1 - t[3]!));
      const bgOf = (el: Element) => {
        const chain: number[][] = [];
        for (let e: Element | null = el; e; e = e.parentElement) { const c = parse(getComputedStyle(e).backgroundColor); if (c[3]! > 0) { chain.push(c); if (c[3] === 1) break; } }
        let base = [255, 255, 255];
        for (const c of chain.reverse()) base = over(c, base);
        return base;
      };
      const small: string[] = [];
      const top = document.querySelector('dialog[open]') ?? document;
      for (const el of top.querySelectorAll<HTMLElement>('button, a[href], [role=button], [role=switch], input, textarea, summary')) {
        const b = el.getBoundingClientRect();
        if (b.width === 0 || b.height === 0) continue;
        if (b.width + 0.5 < min || b.height + 0.5 < min) small.push(`${el.tagName} "${(el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 30)}" ${b.width.toFixed(0)}x${b.height.toFixed(0)}`);
      }
      const texts: { t: string; fg: number[]; bg: number[]; px: number; w: number }[] = [];
      const walker = document.createTreeWalker(top === document ? document.body : top, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const el = n.parentElement;
        if (!el || !n.textContent?.trim() || el.closest(`${exempt}, .vh`)) continue;
        const b = el.getBoundingClientRect(); if (b.width === 0) continue;
        const cs = getComputedStyle(el);
        texts.push({ t: n.textContent.trim().slice(0, 40), fg: over(parse(cs.color), bgOf(el)), bg: bgOf(el), px: parseFloat(cs.fontSize), w: Number(cs.fontWeight) || 400 });
      }
      const greens: string[] = [];
      for (const el of document.querySelectorAll('*')) {
        const cs = getComputedStyle(el);
        for (const c of [cs.color, cs.backgroundColor, cs.borderTopColor]) { const [r, g, b, a] = parse(c); if (a! > 0 && g! > r! + 24 && g! > b! + 24) greens.push(`${el.tagName} ${c}`); }
      }
      const copy = [document.title, ...document.body.innerText.split('\n'), ...[...document.querySelectorAll('[aria-label],[placeholder]')].flatMap((e) => [e.getAttribute('aria-label') ?? '', e.getAttribute('placeholder') ?? ''])].filter((t) => t.trim());
      return { small, texts, greens, copy };
    }, { min: MIN_TAP, exempt: CONTRAST_EXEMPT });
    expect(r.small, 'controls below 48px').toEqual([]);
    const low = r.texts.map((x) => ({ ...x, ratio: contrast(x.fg as [number, number, number], x.bg as [number, number, number]), need: requiredRatio(x.px, x.w) }))
      .filter((x) => x.ratio + 1e-9 < x.need).map((x) => `"${x.t}" ${x.ratio.toFixed(2)}:1 < ${x.need}`);
    expect(low, 'text below 4.5:1').toEqual([]);
    expect(r.greens, 'green anywhere').toEqual([]);
    expect(r.copy.flatMap((t) => checkText(t, { copy: true }).map((v) => `${v.rule} "${v.match}" in ${t.slice(0, 50)}`)), 'banned copy').toEqual([]);
  });
}
