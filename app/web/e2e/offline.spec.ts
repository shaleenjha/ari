import { expect, test, type Route } from '@playwright/test';

// v18.15.2 offline: the live-mode build (playwright.config.ts, second web server) with every auth and REST call answered by
// route() from synthetic rows; nothing reaches the real backend. Service workers blocked, as in auth.spec.ts, so WebKit keeps
// routing fetches through route(). Runs on webkit-390 (iPhone 14) and chromium-412 (Pixel 7).
const LIVE = process.env.PW_LIVE_URL ?? `http://localhost:${Number(process.env.PW_PORT ?? 4173) + 1}`;
const AUTH = 'https://auth-mock.test';
test.use({ baseURL: LIVE, serviceWorkers: 'block' });
test.beforeEach(({}, info) => {
  test.skip(!['webkit-390', 'chromium-412'].includes(info.project.name), 'offline: iPhone 14 WebKit and Pixel 7 Chromium');
});

const now = () => new Date().toISOString();
const ROWS: Record<string, unknown[]> = {
  people: [{ id: 'P900', name: 'Test Person A', title: 'Staff Engineer', stage: 'Accepted', accepted: now(), linkedin_url: 'https://www.linkedin.com/in/test-a' }],
  hygiene_findings: [{ id: 'f900', check_key: 'stale_stage', entity_type: 'person', entity_id: 'P900', status: 'open', first_seen: now(), detail: { label: 'Test' } }],
  replies: [], log_entries: [], accounts: [], account_briefs: [],
};

test('offline keeps what loaded across tab switches, then refetches on reconnect and clears the line', async ({ page, context }) => {
  let offline = false;
  const seen = { people: 0 };
  await context.route(`${AUTH}/auth/v1/**`, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await context.route(`${AUTH}/rest/v1/**`, (r: Route) => {
    if (offline) return r.abort('internetdisconnected');
    const table = new URL(r.request().url()).pathname.split('/').pop() ?? '';
    if (table === 'people') seen.people++;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROWS[table] ?? []) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('ari2-session', JSON.stringify({ accessToken: 'acc-test', refreshToken: 'ref-test', expiresAt: Date.now() + 3_600_000, email: 'me@example.com' }));
  });

  // Online: Today with its queue and the Tidy up card.
  await page.goto('/');
  await expect(page.getByTestId('queue')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('tidy-up')).toBeVisible();
  await expect(page.getByTestId('stale')).toHaveCount(0);

  // Offline, switch tabs and back.
  offline = true;
  await context.setOffline(true);
  await page.locator('nav a[href="#/replies"]').click();
  await expect(page.locator('main[data-screen="replies"]')).toBeVisible();
  await page.locator('nav a[href="#/report"]').click();
  await expect(page.locator('main[data-screen="report"]')).toBeVisible();
  await page.locator('nav a[href="#/"]').click();
  await expect(page.locator('main[data-screen="today"]')).toBeVisible();

  // Everything that loaded is still there, with one quiet line and no error.
  await expect(page.getByTestId('stale')).toHaveText(/^Offline · loaded \d{1,2}:\d{2} (AM|PM)$/, { timeout: 10_000 });
  await expect(page.getByTestId('stale')).toHaveCount(1);
  await expect(page.getByTestId('queue')).toBeVisible();
  await expect(page.getByTestId('queue')).toContainText('Test Person A');
  await expect(page.getByTestId('tidy-up')).toBeVisible();
  await expect(page.getByText('Could not load your queue.')).toHaveCount(0);

  // Back online: refetch without a reload, the line clears, the data stays.
  const before = seen.people;
  offline = false;
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('stale')).toHaveCount(0, { timeout: 10_000 });
  expect(seen.people).toBeGreaterThan(before);
  await expect(page.getByTestId('queue')).toContainText('Test Person A');
  await expect(page.getByTestId('tidy-up')).toBeVisible();
});

test('a screen that never loaded in this tab says so, then recovers on reconnect', async ({ page, context }) => {
  let offline = false;
  await context.route(`${AUTH}/auth/v1/**`, (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await context.route(`${AUTH}/rest/v1/**`, (r: Route) => {
    if (offline) return r.abort('internetdisconnected');
    const table = new URL(r.request().url()).pathname.split('/').pop() ?? '';
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ROWS[table] ?? []) });
  });
  await page.addInitScript(() => {
    localStorage.setItem('ari2-session', JSON.stringify({ accessToken: 'acc-test', refreshToken: 'ref-test', expiresAt: Date.now() + 3_600_000, email: 'me@example.com' }));
  });
  await page.goto('/');
  await expect(page.getByTestId('queue')).toBeVisible({ timeout: 10_000 });
  offline = true;
  await context.setOffline(true);
  await page.locator('nav a[href="#/report"]').click();
  await expect(page.getByText('Could not load this week.')).toBeVisible({ timeout: 10_000 });
  offline = false;
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByTestId('report')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText('Could not load this week.')).toHaveCount(0);
});
