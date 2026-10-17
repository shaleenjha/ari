import { defineConfig, devices } from '@playwright/test';

// Mobile-first shells at 360, 390 and 412 px wide (touch, mobile viewport), Chromium + WebKit on GitHub Actions.
// Local escape hatch: PW_CHROMIUM_PATH=/path/to/chromium runs the Chromium projects only, with that binary
// (used where Playwright's own browser download is unavailable, e.g. linux-arm64 sandboxes).
const localChromium = process.env.PW_CHROMIUM_PATH;
const port = Number(process.env.PW_PORT ?? 4173);
const sizes = [
  { name: '360', use: { viewport: { width: 360, height: 780 } } },
  { name: '390', use: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 } },
  { name: '412', use: { viewport: { width: 412, height: 915 } } },
];
const engines = [
  { name: 'chromium' as const, use: { ...devices['Pixel 7'], ...(localChromium ? { launchOptions: { executablePath: localChromium } } : {}) } },
  ...(localChromium ? [] : [{ name: 'webkit' as const, use: devices['iPhone 14'] }]),
];

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: engines.flatMap((e) =>
    sizes.map((s) => ({
      name: `${e.name}-${s.name}`,
      use: { ...e.use, ...s.use, isMobile: true, hasTouch: true, browserName: e.name },
    })),
  ),
  webServer: { command: `npm run build && npx vite preview --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
