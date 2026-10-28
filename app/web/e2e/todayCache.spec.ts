import { expect, test, type BrowserContext, type Page, type Route } from '@playwright/test';

// v18.15.3 last-good Today on this device (ui/todayCache.ts), against the live-mode build with every auth and REST call
// answered by route() from synthetic rows. Service workers blocked as in offline.spec.ts (WebKit route bypass), so a reload
// "while offline" is the preview server serving the shell (what sw.js does on a phone) with every data call failing.
const LIVE = process.env.PW_LIVE_URL ?? `http://localhost:${Number(process.env.PW_PORT ?? 4173) + 1}`;
const AUTH = 'https://auth-mock.test';
test.use({ baseURL: LIVE, serviceWorkers: 'block' });
test.beforeEach(({}, info) => {
  test.skip(!['webkit-390', 'chromium-412'].includes(info.project.name), 'today cache: iPhone 14 WebKit and Pixel 7 Chromium');
});

const now = () => new Date().toISOString();
const ROWS: Record<string, unknown[]> = {
  people: [{ id: 'P900', name: 'Test Person A', title: 'Staff Engineer', stage: 'Accepted', accepted: now(), linkedin_url: 'https://www.linkedin.com/in/test-a' }],
  hygiene_findings: [{ id: 'f900', check_key: 'stale_stage', entity_type: 'person', entity_id: 'P900', status: 'open', first_seen: now(), detail: { label: 'Test' } }],
  replies: [], log_entries: [], accounts: [], account_briefs: [],
};
const LINE = /^Offline · loaded \d{1,2}:\d{2} (AM|PM)$/;

async function mock(ctx: BrowserContext) {
  const net = { down: false, rest: 0 };
  await ctx.route(`${AUTH}/auth/v1/**`, (r) => (net.down ? r.abort('internetdisconnected') : r.fulfill({ status: 500, contentType: 'application/json', body: '{}' })));
  await ctx.route(`${AUTH}/rest/v1/**`, (r: Route) => {
    if (net.down) return r.abort('internetdisconnected');
    net.rest++;
    const table = new URL(r.request().url()).pathname.split('/').pop() ?? '';
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROWS[table] ?? []) });
  });
  return net;
}
async function signedIn(page: Page) {
  await page.addInitScript(() => {
    if (sessionStorage.getItem('seeded')) return;
    sessionStorage.setItem('seeded', '1');
    localStorage.setItem('ari2-session', JSON.stringify({ accessToken: 'acc-test', refreshToken: 'ref-test', expiresAt: Date.now() + 3_600_000, email: 'me@example.com', userId: 'u-test' }));
  });
}
/** Keys in idb-keyval's default store. */
const idbKeys = (page: Page) => page.evaluate(() => new Promise<string[]>((res) => {
  const o = indexedDB.open('keyval-store');
  o.onupgradeneeded = () => o.result.createObjectStore('keyval');
  o.onsuccess = () => {
    const q = o.result.transaction('keyval', 'readonly').objectStore('keyval').getAllKeys();
    q.onsuccess = () => { res(q.result.map(String)); o.result.close(); };
  };
}));
const todayKept = async (page: Page) => {
  await expect(page.getByTestId('queue')).toContainText('Test Person A');
  await expect(page.getByTestId('tidy-up')).toBeVisible();
  await expect(page.getByText('Could not load your queue.')).toHaveCount(0);
};

test('Today survives tab switches and a reload while offline, from this device, then clears the line online', async ({ page, context }) => {
  const net = await mock(context);
  await signedIn(page);
  await page.goto('/');
  await expect(page.getByTestId('queue')).toContainText('Test Person A', { timeout: 10_000 });
  await expect(page.getByTestId('tidy-up')).toBeVisible();
  await expect.poll(() => idbKeys(page), { timeout: 5000 }).toEqual(['today_queue_u-test']);

  // Offline: Today -> Today's 15 -> back -> Report -> Today.
  net.down = true;
  await context.setOffline(true);
  await page.getByTestId('today15-link').click();
  await expect(page.locator('main[data-screen="today15"]')).toBeVisible();
  await page.goBack();
  await expect(page.locator('main[data-screen="today"]')).toBeVisible();
  await page.locator('nav a[href="#/report"]').click();
  await expect(page.locator('main[data-screen="report"]')).toBeVisible();
  await page.locator('nav a[href="#/"]').click();
  await expect(page.getByTestId('stale')).toHaveText(LINE, { timeout: 10_000 });
  await expect(page.locator('[data-testid="stale"], [data-testid="retrying"]')).toHaveCount(1);
  await todayKept(page);

  // Reload with every data call failing (the phone threw the tab away): Today renders from this device.
  await context.setOffline(false);
  const before = net.rest;
  await page.reload();
  await todayKept(page);
  await expect(page.getByTestId('stale')).toHaveText(LINE, { timeout: 10_000 });
  await expect(page.locator('[data-testid="stale"], [data-testid="retrying"]')).toHaveCount(1);
  expect(net.rest).toBe(before);

  // Back online: refetch without a reload, the line clears, the data stays.
  net.down = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('stale')).toHaveCount(0, { timeout: 10_000 });
  expect(net.rest).toBeGreaterThan(before);
  await todayKept(page);
});

test('sign out leaves nothing on this device', async ({ page, context }) => {
  await mock(context);
  await signedIn(page);
  await page.goto('/');
  await expect(page.getByTestId('queue')).toContainText('Test Person A', { timeout: 10_000 });
  await expect.poll(() => idbKeys(page), { timeout: 5000 }).toEqual(['today_queue_u-test']);
  await page.locator('nav a[href="#/report"]').click();
  const b = page.getByTestId('sign-out');
  const box = (await b.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(48);
  expect(box.height).toBeGreaterThanOrEqual(48);
  await b.click();
  await expect(page.getByRole('button', { name: 'Sign in with Google' })).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => idbKeys(page), { timeout: 5000 }).toEqual([]);
  expect(await page.evaluate(() => localStorage.getItem('ari2-session'))).toBeNull();
});
