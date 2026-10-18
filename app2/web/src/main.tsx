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
import { isEmbedded } from './ui/embedded';
import { ErrorBoundary, Fallback } from './ui/ErrorBoundary';
import { setReadOnly } from './ui/readOnly';
import { setAuth, setEmbedded, setMisconfigured } from './ui/session';
import './ui/styles.css';

let root: Root | null = null;
const mount = () => (root ??= createRoot(document.getElementById('root')!));

const standalone = () => {
  try { return matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true; } catch { return false; }
};

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
      const err = await auth.complete().catch(() => 'Sign-in failed. Try again.');
      setData(new LiveData(fetch.bind(globalThis), { url: cfg.url, apikey: cfg.apikey, token: () => auth.token(), workspaceId: cfg.workspaceId }));
      setAuth(auth, err);
    }
  } else setData(mode.data === 'legacy' ? new MockData() : new SyntheticRestData(new MockPostgrest(), WS_A, JWT_A));
  mount().render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
}
boot().catch((e: unknown) => {
  console.error('Ari could not start', e);
  mount().render(<Fallback />);
});
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
