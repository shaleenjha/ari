// Google sign-in for live mode, the same path the current app uses: Google returns an ID token (implicit, nonce bound),
// and Supabase Auth exchanges it for a session (grant_type=id_token). That needs only the Google client id on both sides:
// no OAuth client secret in Supabase and no Supabase redirect allow list. Google must list this origin as an authorized
// redirect URI and JavaScript origin on that client. Sign-in and refresh are the only non-GET requests the app makes,
// and both go to the auth path (lint rule no-client-writes allows exactly that).
import type { FetchFn } from './rest';

export interface AuthConfig { url: string; apikey: string; googleClientId: string }
export interface Session { accessToken: string; refreshToken: string; expiresAt: number; email?: string; userId?: string }

const KEY = 'ari2-session';
const NONCE = 'ari2-nonce';
const STATE = 'ari2-signin';

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

function readSession(store: Storage): Session | null {
  try { const s = JSON.parse(store.getItem(KEY) ?? 'null') as Session | null; return s?.accessToken ? s : null; } catch { return null; }
}

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number; user?: { id?: string; email?: string } };
const toSession = (j: TokenReply, now: number): Session | null => (j.access_token && j.refresh_token ? {
  accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: j.expires_at ? j.expires_at * 1000 : now + (j.expires_in ?? 3600) * 1000,
  email: j.user?.email, userId: j.user?.id } : null);

export class Auth {
  private refreshing: Promise<Session | null> | null = null;
  private subs = new Set<() => void>();
  constructor(private cfg: AuthConfig, private f: FetchFn = fetch.bind(globalThis), private store: Storage = localStorage,
    private loc: Pick<Location, 'origin' | 'hash' | 'pathname' | 'search' | 'assign'> = location, private now: () => number = Date.now) {}

  session(): Session | null { return readSession(this.store); }
  subscribe(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private save(s: Session | null) {
    if (s) this.store.setItem(KEY, JSON.stringify(s)); else this.store.removeItem(KEY);
    this.subs.forEach((fn) => fn());
  }

  /** Go to Google. The raw nonce stays in this tab; Google signs its hash into the ID token. */
  async start(): Promise<void> {
    const raw = hex(crypto.getRandomValues(new Uint8Array(32)));
    sessionStorage.setItem(NONCE, raw);
    const p = new URLSearchParams({ client_id: this.cfg.googleClientId, redirect_uri: `${this.loc.origin}/`, response_type: 'id_token',
      scope: 'openid email', nonce: await sha256Hex(raw), state: STATE, prompt: 'select_account' });
    this.loc.assign(`https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`);
  }

  /**
   * Finish a sign-in if Google just sent us back (`#id_token=...&state=ari2-signin`). Clears the fragment either way so the
   * hash router starts at Today. Returns an error line for the screen, or null.
   */
  async complete(): Promise<string | null> {
    const h = new URLSearchParams(this.loc.hash.replace(/^#/, ''));
    if (h.get('state') !== STATE) return null;
    history.replaceState(null, '', `${this.loc.pathname}${this.loc.search}#/`);
    const raw = sessionStorage.getItem(NONCE); sessionStorage.removeItem(NONCE);
    if (h.get('error')) return 'Google sign-in was cancelled.';
    const idToken = h.get('id_token');
    if (!idToken || !raw) return 'Sign-in did not finish. Try again.';
    const r = await this.f(`${this.cfg.url}/auth/v1/token?grant_type=id_token`, {
      method: 'POST', headers: { apikey: this.cfg.apikey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'google', id_token: idToken, nonce: raw }),
    });
    const s = r.ok ? toSession((await r.json()) as TokenReply, this.now()) : null;
    if (!s) return r.status === 422 || r.status === 400 ? 'This Google account cannot open Ari.' : 'Sign-in failed. Try again.';
    this.save(s);
    return null;
  }

  /** A valid access JWT, refreshed when under a minute is left. Throws when signed out. */
  async token(): Promise<string> {
    const s = this.session();
    if (!s) throw new Error('signed out');
    if (s.expiresAt - this.now() > 60_000) return s.accessToken;
    this.refreshing ??= this.refresh(s.refreshToken).finally(() => { this.refreshing = null; });
    const n = await this.refreshing;
    if (!n) throw new Error('signed out');
    return n.accessToken;
  }

  private async refresh(refreshToken: string): Promise<Session | null> {
    const r = await this.f(`${this.cfg.url}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST', headers: { apikey: this.cfg.apikey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }),
    });
    const s = r.ok ? toSession((await r.json()) as TokenReply, this.now()) : null;
    if (!s && r.status >= 400 && r.status < 500) this.save(null);
    else if (s) this.save(s);
    return s;
  }

  /** Forget the session on this device. */
  signOut() { this.save(null); }
}
