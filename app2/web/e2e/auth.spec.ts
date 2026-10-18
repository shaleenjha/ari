import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

// v18.15.0 auth hygiene, against the live-mode build (playwright.config.ts, second web server) with every auth and REST
// call mocked by route(): nothing reaches Supabase or Google. One size per engine is enough for auth behaviour.
const LIVE = `http://localhost:${Number(process.env.PW_PORT ?? 4173) + 1}`;
const AUTH = 'https://auth-mock.test';
test.use({ baseURL: LIVE });
test.beforeEach(({}, info) => { test.skip(!info.project.name.endsWith('-390'), 'auth: one size per engine'); });

type Reply = (route: Route) => Promise<void>;
const json = (status: number, body: unknown) => (r: Route) => r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const fresh = { access_token: 'acc-new', refresh_token: 'ref-new', expires_in: 3600, user: { id: 'u1', email: 'me@example.com' } };

/** Mocks the auth host; returns the list of refresh calls seen. Google is aborted and counted. */
async function mock(ctx: BrowserContext, refresh: Reply) {
  const seen = { refresh: 0, google: 0, rest: 0 };
  await ctx.route('https://accounts.google.com/**', (r) => { seen.google++; return r.abort(); });
  await ctx.route(`${AUTH}/auth/v1/token**`, (r) => { if (r.request().url().includes('grant_type=refresh_token')) seen.refresh++; return refresh(r); });
  await ctx.route(`${AUTH}/rest/v1/**`, (r) => { seen.rest++; return json(200, [])(r); });
  ctx.on('request', (q) => { if (q.url().startsWith('https://accounts.google.com')) seen.google++; });
  return seen;
}

/** Seeds a stored session once per tab (so a purge stays purged on reload), and records whether sign-in ever painted. */
async function seed(page: Page, expiresAt: number) {
  await page.addInitScript((exp) => {
    if (!sessionStorage.getItem('seeded') && !localStorage.getItem('ari2-session')) {
      sessionStorage.setItem('seeded', '1');
      localStorage.setItem('ari2-session', JSON.stringify({ accessToken: 'acc-old', refreshToken: 'ref-old', expiresAt: exp, email: 'me@example.com' }));
    }
    const w = window as unknown as { __sawSignIn: boolean };
    w.__sawSignIn = false;
    new MutationObserver(() => { if (document.body?.textContent?.includes('Sign in with Google')) w.__sawSignIn = true; })
      .observe(document, { subtree: true, childList: true, characterData: true });
  }, expiresAt);
}
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('ari2-session'));

test('warm session cold boot: straight into Today, no sign-in flash, no Google, no redirect', async ({ page, context }) => {
  const seen = await mock(context, json(500, {}));
  await seed(page, Date.now() + 3_600_000);
  const navs: string[] = [];
  page.on('framenavigated', (f) => { if (f === page.mainFrame()) navs.push(f.url()); });
  await page.goto('/');
  await expect(page.locator('main[data-screen="today"] section[aria-busy="false"]')).toBeVisible({ timeout: 10_000 });
  expect(seen.google).toBe(0);
  expect(seen.refresh).toBe(0);
  expect(seen.rest).toBeGreaterThan(0);
  expect(navs).toHaveLength(1);
  expect(new URL(page.url()).origin).toBe(LIVE);
  expect(await page.evaluate(() => (window as unknown as { __sawSignIn: boolean }).__sawSignIn)).toBe(false);
});

for (const [name, reply] of [
  ['429', json(429, { msg: 'rate limited' })],
  ['408', json(408, {})],
  ['503', json(503, {})],
  ['network error', (r: Route) => r.abort('internetdisconnected')],
] as const) {
  test(`refresh ${name}: session kept, quiet retrying line, no sign-in`, async ({ page, context }) => {
    const seen = await mock(context, reply as Reply);
    await seed(page, 0);
    await page.goto('/');
    await expect(page.getByTestId('retrying')).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => seen.refresh, { timeout: 10_000 }).toBeGreaterThanOrEqual(2);
    expect(await stored(page)).toContain('ref-old');
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __sawSignIn: boolean }).__sawSignIn)).toBe(false);
    expect(seen.google).toBe(0);
  });
}

test('refresh invalid_grant: session purged, sign-in shown', async ({ page, context }) => {
  const seen = await mock(context, json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' }));
  await seed(page, 0);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible({ timeout: 10_000 });
  expect(await stored(page)).toBeNull();
  expect(seen.refresh).toBe(1);
  expect(seen.google).toBe(0);
});

test('two tabs refreshing at once: one refresh request, both reuse it', async ({ context }) => {
  const seen = await mock(context, async (r) => { await new Promise((x) => setTimeout(x, 600)); return json(200, fresh)(r); });
  const [a, b] = [await context.newPage(), await context.newPage()];
  await seed(a, 0); await seed(b, 0);
  await Promise.all([a.goto('/'), b.goto('/')]);
  for (const p of [a, b]) await expect(p.locator('main[data-screen="today"] section[aria-busy="false"]')).toBeVisible({ timeout: 10_000 });
  expect(seen.refresh).toBe(1);
  expect(await stored(a)).toContain('ref-new');
  expect(await stored(b)).toContain('ref-new');
});
