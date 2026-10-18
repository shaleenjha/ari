import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { setData } from './data/client';
import { Auth } from './data/auth';
import { LiveData } from './data/live';
import { liveEnv, resolveMode } from './data/mode';
import { MockData } from './data/fixtures/mock';
import { JWT_A, MockPostgrest, WS_A } from './data/fixtures/pgmock';
import { SyntheticRestData } from './data/fixtures/syntheticRest';
import { setReadOnly } from './ui/readOnly';
import { setAuth, setMisconfigured } from './ui/session';
import './ui/styles.css';

// live: production, read-only, Google sign-in. mock (default): synthetic rows through the PostgREST fixture. See data/mode.ts.
async function boot() {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const mode = resolveMode(env, location.search);
  setReadOnly(mode.readOnly);
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
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
void boot();
if ('serviceWorker' in navigator && import.meta.env.PROD) navigator.serviceWorker.register('/sw.js').catch(() => undefined);
