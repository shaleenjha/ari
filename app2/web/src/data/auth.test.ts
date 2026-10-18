import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Auth, backoff, isTerminal, sha256Hex, withRefreshLock } from './auth';

class Mem implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.get(k) ?? null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const cfg = { url: 'https://example.invalid', apikey: 'pk', googleClientId: 'cid.apps.example' };
let replaced: string[] = [];
beforeEach(() => {
  replaced = [];
  vi.stubGlobal('sessionStorage', new Mem());
  vi.stubGlobal('history', { replaceState: (_s: unknown, _t: string, u: string) => { replaced.push(u); } });
});

const loc = (hash = '') => {
  const l = { origin: 'https://preview.example', hash, pathname: '/', search: '', assigned: '', assign(u: string) { l.assigned = u; } };
  return l;
};
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Google sign-in (ID token, nonce bound) and the session', () => {
  it('start: goes to Google with the hashed nonce and keeps the raw one in this tab', async () => {
    const l = loc();
    await new Auth(cfg, vi.fn(), new Mem(), l).start();
    const u = new URL(l.assigned);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe(cfg.googleClientId);
    expect(u.searchParams.get('redirect_uri')).toBe('https://preview.example/');
    expect(u.searchParams.get('response_type')).toBe('id_token');
    const raw = sessionStorage.getItem('ari2-nonce')!;
    expect(u.searchParams.get('nonce')).toBe(await sha256Hex(raw));
  });

  it('complete: exchanges the ID token with the raw nonce on the auth path, saves the session, clears the fragment', async () => {
    sessionStorage.setItem('ari2-nonce', 'raw-nonce');
    const f = vi.fn(async () => reply(200, { access_token: 'a1', refresh_token: 'r1', expires_in: 3600, user: { id: 'u1', email: 'x@example.com' } }));
    const store = new Mem();
    const a = new Auth(cfg, f, store, loc('#id_token=idt&state=ari2-signin'), () => 1000);
    expect(await a.complete()).toBeNull();
    expect(f).toHaveBeenCalledWith('https://example.invalid/auth/v1/token?grant_type=id_token', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ provider: 'google', id_token: 'idt', nonce: 'raw-nonce' });
    expect(a.session()).toMatchObject({ accessToken: 'a1', refreshToken: 'r1', expiresAt: 3_601_000, userId: 'u1' });
    expect(replaced).toEqual(['/#/']);
    expect(sessionStorage.getItem('ari2-nonce')).toBeNull();
  });

  it('complete: ignores other fragments, and reports a refused account plainly', async () => {
    const f = vi.fn(async () => reply(400, { error: 'signups not allowed' }));
    expect(await new Auth(cfg, f, new Mem(), loc('#/replies')).complete()).toBeNull();
    expect(f).not.toHaveBeenCalled();
    sessionStorage.setItem('ari2-nonce', 'n');
    const a = new Auth(cfg, f, new Mem(), loc('#id_token=idt&state=ari2-signin'));
    expect(await a.complete()).toBe('This Google account cannot open Ari.');
    expect(a.session()).toBeNull();
  });

  it('token: refreshes once when under a minute is left; a refused refresh signs out', async () => {
    const store = new Mem();
    store.setItem('ari2-session', JSON.stringify({ accessToken: 'old', refreshToken: 'r1', expiresAt: 30_000 }));
    const f = vi.fn(async () => reply(200, { access_token: 'new', refresh_token: 'r2', expires_in: 3600 }));
    const a = new Auth(cfg, f, store, loc(), () => 0);
    expect(await Promise.all([a.token(), a.token()])).toEqual(['new', 'new']);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f).toHaveBeenCalledWith('https://example.invalid/auth/v1/token?grant_type=refresh_token', expect.objectContaining({ method: 'POST' }));
    store.setItem('ari2-session', JSON.stringify({ accessToken: 'x', refreshToken: 'bad', expiresAt: 0 }));
    const g = vi.fn(async () => reply(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' }));
    await expect(new Auth(cfg, g, store, loc(), () => 0).token()).rejects.toThrow('signed out');
    expect(store.getItem('ari2-session')).toBeNull();
  });

  it('start: account chooser on the first sign-in only; afterwards login_hint with the last email', async () => {
    const store = new Mem();
    const l = loc();
    await new Auth(cfg, vi.fn(), store, l).start();
    expect(new URL(l.assigned).searchParams.get('prompt')).toBe('select_account');
    expect(new URL(l.assigned).searchParams.get('login_hint')).toBeNull();
    store.setItem('ari2-last-email', 'me@example.com');
    await new Auth(cfg, vi.fn(), store, l).start();
    expect(new URL(l.assigned).searchParams.get('prompt')).toBeNull();
    expect(new URL(l.assigned).searchParams.get('login_hint')).toBe('me@example.com');
  });
});

describe('refresh: terminal-only purge, backoff, one rotation across tabs', () => {
  const stored = (store: Storage, exp = 0, rt = 'r1') => store.setItem('ari2-session', JSON.stringify({ accessToken: 'old', refreshToken: rt, expiresAt: exp }));
  const noWait = { sleep: async () => undefined, tries: 3 };

  it('classifies terminal errors', () => {
    expect(isTerminal(400, { error: 'invalid_grant' })).toBe(true);
    expect(isTerminal(400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token: Refresh Token Not Found' })).toBe(true);
    expect(isTerminal(400, { msg: 'Invalid Refresh Token: Already Used' })).toBe(true);
    for (const st of [408, 429, 500, 502, 503]) expect(isTerminal(st, { error: 'invalid_grant' })).toBe(false);
    expect(isTerminal(400, { error: 'bad_json' })).toBe(false);
  });

  it('429, 408, 5xx and network failures keep the session and retry with backoff', async () => {
    for (const fail of [() => reply(429, {}), () => reply(408, {}), () => reply(503, {}), () => { throw new TypeError('Failed to fetch'); }]) {
      const store = new Mem(); stored(store);
      const f = vi.fn(async () => fail());
      const a = new Auth(cfg, f, store, loc(), () => 1000, new Mem(), noWait);
      await expect(a.token()).rejects.toThrow(/retrying/);
      expect(f).toHaveBeenCalledTimes(3);
      expect(a.session()?.refreshToken).toBe('r1');
      expect(a.status()).toBe('retrying');
    }
  });

  it('a transient failure inside the last minute keeps using the still valid token', async () => {
    const store = new Mem(); stored(store, 30_000);
    const a = new Auth(cfg, vi.fn(async () => reply(503, {})), store, loc(), () => 0, new Mem(), noWait);
    expect(await a.token()).toBe('old');
  });

  it('recovers after a transient failure', async () => {
    const store = new Mem(); stored(store);
    let n = 0;
    const f = vi.fn(async () => (n++ === 0 ? reply(429, {}) : reply(200, { access_token: 'new', refresh_token: 'r2', expires_in: 3600 })));
    const a = new Auth(cfg, f, store, loc(), () => 0, new Mem(), noWait);
    expect(await a.token()).toBe('new');
    expect(a.status()).toBe('ok');
  });

  it('a second tab waiting on the lock reuses the rotated session instead of rotating again', async () => {
    const store = new Mem(); stored(store);
    let chain: Promise<unknown> = Promise.resolve();
    const locks = { request<T>(_n: string, cb: () => Promise<T>) { const p = chain.then(cb); chain = p.catch(() => undefined); return p; } };
    const f = vi.fn(async () => reply(200, { access_token: 'new', refresh_token: 'r2', expires_in: 3600 }));
    const tab1 = new Auth(cfg, f, store, loc(), () => 0, new Mem(), { locks });
    const tab2 = new Auth(cfg, f, store, loc(), () => 0, new Mem(), { locks });
    expect(await Promise.all([tab1.token(), tab2.token()])).toEqual(['new', 'new']);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('localStorage fallback lock runs one holder at a time', async () => {
    const store = new Mem(); const order: string[] = [];
    const job = (n: string) => withRefreshLock(async () => { order.push(`${n}+`); await new Promise((r) => setTimeout(r, 30)); order.push(`${n}-`); }, store, undefined);
    await Promise.all([job('a'), new Promise((r) => setTimeout(r, 5)).then(() => job('b'))]);
    expect(order).toEqual(['a+', 'a-', 'b+', 'b-']);
  });

  it('backoff grows and stays jittered', () => {
    expect(backoff(0, () => 0)).toBe(250);
    expect(backoff(2, () => 1)).toBe(2000);
    expect(backoff(10, () => 1)).toBe(15_000);
  });
});
