import { defineConfig, devices } from '@playwright/test';

// Mobile-first shells at 360 and 412 px wide, Chromium + WebKit. Runs on GitHub Actions (the Hark sandbox cannot run browsers).
const sizes = [
  { name: '360', viewport: { width: 360, height: 780 } },
  { name: '412', viewport: { width: 412, height: 915 } },
];
const engines = [
  { name: 'chromium', use: devices['Pixel 7'] },
  { name: 'webkit', use: devices['iPhone 14'] },
];

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  projects: engines.flatMap((e) =>
    sizes.map((s) => ({
      name: `${e.name}-${s.name}`,
      use: { ...e.use, viewport: s.viewport, browserName: e.name as 'chromium' | 'webkit' },
    })),
  ),
  webServer: { command: 'npm run build && npm run preview', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI, timeout: 120_000 },
});
