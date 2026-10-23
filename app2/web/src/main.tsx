import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from './App';
import { setData } from './data/client';
import { Auth } from './data/auth';
import { LiveData } from './data/live';
import { liveEnv, resolveMode } from './data/mode';
import { MockData } from './data/fixtures/mock';
import { JWT_A, MockPostgrest, WS_A } from './data/fixtures/pgmock';
import { SyntheticRestData } from './data/fixtures/syntheticRest';
import { fixtureResolver } from './data/fixtures/importPlans';
import { setImportResolver } from './data/imports';
import { isEmbedded } from './ui/embedded';
import { ErrorBoundary, Fallback } from './ui/ErrorBoundary';
import { setReadOnly } from './ui/readOnly';
import { seedFromDevice, setAuth, setEmbedded, setMisconfigured } from './ui/session';
import './ui/styles.css';

let root: Root | null = null;
const mount = () => (root ??= createRoot(document.getElementById('root')!));

const standalone = () => {
  try { return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true; } catch { return false; }
};

/** Synthetic data only: ?delay=<ms> holds every mock response that long, so tests see the placeholders (e2e/cls.spec.ts). */
function slowed(m: MockPostgrest): MockPostgrest {
  const ms = Math.min(Number(new URLSearchParams(location.search).get('delay')) || 0, 5000);
  if (ms > 0) { const f = m.fetch; m.fetch = async (...a) => { await new Promise((r) => setTimeout(r, ms)); return f(...a); }; }
  return m;
}

// live: production, read-only, Google sign-in. mock (default): synthetic rows through the PostgREST fixture. See data/mode.ts.
// Embedded: an app's link viewer, where Google refuses sign-in; live mode shows "open in your browser" instead (?embed=1 forces it).
async function boot() {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const mode = resolveMode(env, location.search);
  setReadOnly(mode.readOnly);
  const forced = new URLSearchParams(location.search).get('embed') === '1';
  setEmbedded(forced || (mode.data === 'live' && isEmbedded(navigator.userAgent, standalone())));
  if (mode.data === 'live') {
    const cfg = liveEnv(env);
    if (Array.isArray(cfg)) setMisconfigured();
    else {
      const auth = new Auth(cfg);
      // Warm boot: the stored session is read synchronously (auth.session()), so a signed-in device renders the app on the
      // first paint with no sign-in screen and no redirect. Only a return from Google awaits the token exchange.
      const err = auth.isReturn() ? await auth.complete().catch(() => 'Sign-in failed. Try again.') : null;
      setData(new LiveData(fetch.bind(globalThis), { url: cfg.url, apikey: cfg.apikey, token: () => auth.token(), workspaceId: cfg.workspaceId }));
      setAuth(auth, err);
      await seedFromDevice();
    }
  } else {
    setData(mode.data === 'legacy' ? new MockData() : new SyntheticRestData(slowed(new MockPostgrest()), WS_A, JWT_A));
    // Synthetic import plans (data/fixtures/importPlans.ts). Live has no resolver yet: see data/imports.ts.
    setImportResolver(fixtureResolver(Math.min(Number(new URLSearchParams(location.search).get('delay')) || 0, 5000)));
  }
  mount().render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
}
boot().catch((e: unknown) => {
  console.error('Ari could not start', e);
  mount().render(<Fallback />);
});
// Keyboard resizes the layout viewport (Android): interactive-widget=resizes-content. Added from script on Chromium
// engines only (Chrome, Brave, Samsung Internet; they expose navigator.userAgentData), because WebKit logs a console error
// for the unknown key on every load. The keyboard opens after boot, so the late edit still applies.
if ('userAgentData' in navigator) {
  const vp = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (vp && !vp.content.includes('interactive-widget')) vp.content += ', interactive-widget=resizes-content';
}
// iOS Safari only fires :active (the press state, Citrine spec §1 motion) when the page has a touchstart listener.
document.addEventListener('touchstart', () => undefined, { passive: true });
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
