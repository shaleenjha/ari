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
const HINT = 'ari2-last-email';
const LOCK = 'ari2-refresh';
const LOCK_KEY = 'ari2-refresh-lock';

const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
export const sha256Hex = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/** In-memory Storage for viewers that block or throw on web storage (some in-app WebViews). */
export class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(String(k), String(v)); }
}

/**
 * window.localStorage / sessionStorage, or memory when touching them throws (SecurityError with storage blocked) or they
 * are null (Android WebView without DOM storage). Reading them bare crashed boot to a blank page in such viewers.
 */
export function safeStorage(kind: 'localStorage' | 'sessionStorage', w: unknown = globalThis): Storage {
  try {
    const s = (w as Record<string, Storage | null | undefined>)[kind];
    if (s) { const k = '__ari2_probe'; s.setItem(k, '1'); s.removeItem(k); return s; }
  } catch { /* blocked: fall through */ }
  return new MemoryStorage();
}

export function readSession(store: Storage): Session | null {
  try { const s = JSON.parse(store.getItem(KEY) ?? 'null') as Session | null; return s?.accessToken ? s : null; } catch { return null; }
}

type TokenReply = { access_token?: string; refresh_token?: string; expires_in?: number; expires_at?: number; user?: { id?: string; email?: string } };
const toSession = (j: TokenReply, now: number): Session | null => (j.access_token && j.refresh_token ? {
  accessToken: j.access_token, refreshToken: j.refresh_token, expiresAt: j.expires_at ? j.expires_at * 1000 : now + (j.expires_in ?? 3600) * 1000,
  email: j.user?.email, userId: j.user?.id } : null);

/** Signed out for good: the refresh token is gone (purged). */
export class SignedOutError extends Error { constructor() { super('signed out'); } }
/** Refresh could not finish right now (429, 408, 5xx, network). The session is kept; reads fall back to the last good copy. */
export class TransientAuthError extends Error { constructor(public status: number) { super(`auth retrying (${status || 'network'})`); } }

const TERMINAL_CODES = new Set(['refresh_token_not_found', 'refresh_token_already_used', 'session_not_found', 'session_expired']);
/**
 * Only these end a session: OAuth invalid_grant, Supabase's refresh_token_not_found family, or its "Invalid Refresh Token"
 * message. Everything else (429, 408, 5xx, network, an unrecognised 4xx) is transient and keeps the session.
 */
export function isTerminal(status: number, body: unknown): boolean {
  if (status < 400 || status >= 500 || status === 408 || status === 429) return false;
  const b = (body ?? {}) as { error?: string; error_code?: string; code?: string; msg?: string; message?: string; error_description?: string };
  if (b.error === 'invalid_grant' || TERMINAL_CODES.has(b.error_code ?? '') || TERMINAL_CODES.has(String(b.code ?? ''))) return true;
  return /invalid refresh token/i.test(`${b.msg ?? ''} ${b.message ?? ''} ${b.error_description ?? ''} ${b.error ?? ''}`);
}

/** Exponential backoff with full jitter: attempt 0 -> up to 0.5 s, 1 -> 1 s, 2 -> 2 s ... capped at 15 s. */
export const backoff = (attempt: number, rnd: () => number = Math.random) => Math.round(Math.min(15_000, 500 * 2 ** attempt) * (0.5 + rnd() / 2));

type LockMgr = { request<T>(name: string, cb: () => Promise<T>): Promise<T> };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Run fn holding the cross-tab refresh lock. Web Locks where available; otherwise a best-effort localStorage lease
 * (owner + expiry, 10 s) that other tabs poll, so two tabs almost never rotate the same refresh token.
 */
export async function withRefreshLock<T>(fn: () => Promise<T>, store: Storage, locks: LockMgr | undefined = (globalThis.navigator as { locks?: LockMgr } | undefined)?.locks): Promise<T> {
  if (locks?.request) return locks.request(LOCK, fn);
  const me = `${Date.now()}-${Math.random()}`;
  const held = () => { try { const l = JSON.parse(store.getItem(LOCK_KEY) ?? 'null') as { o: string; u: number } | null; return l && l.u > Date.now() && l.o !== me ? l : null; } catch { return null; } };
  for (let i = 0; i < 100 && held(); i++) await sleep(100);
  try { store.setItem(LOCK_KEY, JSON.stringify({ o: me, u: Date.now() + 10_000 })); } catch { /* storage blocked: no lock */ }
  try { return await fn(); } finally { try { if (!held()) store.removeItem(LOCK_KEY); } catch { /* ignore */ } }
}

export type AuthStatus = 'ok' | 'retrying';

export class Auth {
  private refreshing: Promise<Session> | null = null;
  private subs = new Set<() => void>();
  private st: AuthStatus = 'ok';
  /** Called when a refresh ends the session for good (invalid_grant family), never on 429, 408, 5xx or network. */
  onTerminal: (() => void) | null = null;
  constructor(private cfg: AuthConfig, private f: FetchFn = fetch.bind(globalThis), private store: Storage = safeStorage('localStorage'),
    private loc: Pick<Location, 'origin' | 'hash' | 'pathname' | 'search' | 'assign'> = location, private now: () => number = Date.now,
    private tab: Storage = safeStorage('sessionStorage'), private opts: { locks?: LockMgr; sleep?: (ms: number) => Promise<void>; tries?: number } = {}) {
    // Another tab signed in, refreshed or was signed out: re-render from the shared session.
    try { globalThis.addEventListener?.('storage', (e: StorageEvent) => { if (e.key === KEY || e.key === null) this.emit(); }); } catch { /* no window */ }
  }

  /** Synchronous: the stored session, read straight from storage (cold boot renders from this, no network). */
  session(): Session | null { return readSession(this.store); }
  status(): AuthStatus { return this.st; }
  subscribe(fn: () => void) { this.subs.add(fn); return () => { this.subs.delete(fn); }; }
  private emit() { this.subs.forEach((fn) => fn()); }
  private setStatus(s: AuthStatus) { if (s !== this.st) { this.st = s; this.emit(); } }
  private save(s: Session | null) {
    if (s) { this.store.setItem(KEY, JSON.stringify(s)); if (s.email) try { this.store.setItem(HINT, s.email); } catch { /* ignore */ } }
    else this.store.removeItem(KEY);
    this.emit();
  }

  /** True when this load is Google sending us back (fragment state=ari2-signin). Synchronous, so a warm boot never waits. */
  isReturn(): boolean { return new URLSearchParams(this.loc.hash.replace(/^#/, '')).get('state') === STATE; }

  /**
   * Go to Google. The raw nonce stays in this tab; Google signs its hash into the ID token. Per the ticket: the account
   * chooser (prompt=select_account) only on the first sign-in on this device; afterwards login_hint with the last email.
   */
  async start(): Promise<void> {
    const raw = hex(crypto.getRandomValues(new Uint8Array(32)));
    this.tab.setItem(NONCE, raw);
    let hint: string | null = null;
    try { hint = this.store.getItem(HINT); } catch { hint = null; }
    const p = new URLSearchParams({ client_id: this.cfg.googleClientId, redirect_uri: `${this.loc.origin}/`, response_type: 'id_token',
      scope: 'openid email', nonce: await sha256Hex(raw), state: STATE, ...(hint ? { login_hint: hint } : { prompt: 'select_account' }) });
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
    const raw = this.tab.getItem(NONCE); this.tab.removeItem(NONCE);
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

  /**
   * A valid access JWT, refreshed when under a minute is left. Throws SignedOutError when there is no session (or a
   * terminal refresh purged it), TransientAuthError when refresh is failing for now and the old token has expired.
   */
  async token(): Promise<string> {
    const s = this.session();
    if (!s) throw new SignedOutError();
    if (s.expiresAt - this.now() > 60_000) return s.accessToken;
    this.refreshing ??= this.refreshWithRetry(s).finally(() => { this.refreshing = null; });
    try { return (await this.refreshing).accessToken; } catch (e) {
      // Still inside its last minute: the old token works, so keep reading with it.
      if (e instanceof TransientAuthError && s.expiresAt > this.now()) return s.accessToken;
      throw e;
    }
  }

  private async refreshWithRetry(s: Session): Promise<Session> {
    const tries = this.opts.tries ?? 3;
    const wait = this.opts.sleep ?? sleep;
    for (let i = 0; ; i++) {
      try { const n = await this.refreshLocked(s.refreshToken); this.setStatus('ok'); return n; } catch (e) {
        if (!(e instanceof TransientAuthError)) { this.setStatus('ok'); throw e; }
        this.setStatus('retrying');
        if (i + 1 >= tries) throw e;
        await wait(backoff(i));
      }
    }
  }

  /** One rotation across every tab: inside the lock, reuse a session another tab already refreshed. */
  private refreshLocked(used: string): Promise<Session> {
    return withRefreshLock(async () => {
      const cur = this.session();
      if (!cur) throw new SignedOutError();
      if (cur.refreshToken !== used && cur.expiresAt - this.now() > 60_000) return cur;
      return this.refresh(cur.refreshToken);
    }, this.store, this.opts.locks);
  }

  private async refresh(refreshToken: string): Promise<Session> {
    let r: Response;
    try {
      r = await this.f(`${this.cfg.url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST', headers: { apikey: this.cfg.apikey, 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }),
      });
    } catch { throw new TransientAuthError(0); }
    let body: unknown = null;
    try { body = await r.json(); } catch { body = null; }
    if (r.ok) {
      const s = toSession((body ?? {}) as TokenReply, this.now());
      if (!s) throw new TransientAuthError(r.status);
      this.save({ ...s, email: s.email ?? this.session()?.email });
      return s;
    }
    if (isTerminal(r.status, body)) { this.save(null); this.onTerminal?.(); throw new SignedOutError(); }
    throw new TransientAuthError(r.status);
  }

  /** Forget the session on this device. */
  signOut() { this.save(null); }
}
