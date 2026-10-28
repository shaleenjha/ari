import { defineConfig, devices } from '@playwright/test';

// Mobile-first shells at 360, 390 and 412 px wide (touch, mobile viewport), Chromium + WebKit on GitHub Actions.
// Local escape hatch: PW_CHROMIUM_PATH=/path/to/chromium runs the Chromium projects only, with that binary
// (used where Playwright's own browser download is unavailable, e.g. linux-arm64 sandboxes).
const localChromium = process.env.PW_CHROMIUM_PATH;
const port = Number(process.env.PW_PORT ?? 4173);
export const livePort = port + 1;
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
  // PW_NO_SERVER=1: servers already running (local sandboxes where the reuse probe misses them).
  webServer: process.env.PW_NO_SERVER ? [] : [
    // Synthetic data (mock mode). PW_PREBUILT=1 reuses dist/ from an earlier run in the same job (verify-mobile step).
    { command: `${process.env.PW_PREBUILT ? '' : 'npm run build && '}npx vite preview --port ${port} --strictPort`, url: `http://localhost:${port}`, reuseExistingServer: !process.env.CI, timeout: 120_000 },
    // A live-mode build pointed at a fake auth host, for e2e/auth.spec.ts. Every auth and REST call is mocked with route();
    // nothing reaches Supabase or Google. Output under node_modules so it is never exported or committed. PW_NO_LIVE=1 skips it.
    ...(process.env.PW_NO_LIVE ? [] : [{
      command: `npx vite build --outDir node_modules/.ari-dist-live --emptyOutDir && npx vite preview --outDir node_modules/.ari-dist-live --port ${livePort} --strictPort`,
      url: `http://localhost:${livePort}`, reuseExistingServer: !process.env.CI, timeout: 120_000,
      env: { VITE_ARI_DATA: 'live', VITE_ARI_SUPABASE_URL: 'https://auth-mock.test', VITE_ARI_SUPABASE_KEY: 'pk-test', VITE_ARI_GOOGLE_CLIENT_ID: 'cid-test.apps.example', VITE_ARI_WORKSPACE_ID: 'ws-test' },
    }]),
  ],
});
