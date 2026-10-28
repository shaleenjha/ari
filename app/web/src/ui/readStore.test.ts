import { describe, expect, it } from 'vitest';
import { TransientAuthError } from '../data/auth';
import { RestError } from '../data/rest';
import { backoffMs, createReadStore, hma, isNetworkish, isTransient, type ReadEnv } from './readStore';

/** A hand-driven clock and event bus: timers run only when the test advances time. */
function harness() {
  let t = 1_000_000;
  let visible = true;
  let online = true;
  const timers: { at: number; f: () => void; id: number }[] = [];
  const handlers: Record<string, (() => void)[]> = { online: [], visibilitychange: [] };
  let id = 0;
  const env: ReadEnv = {
    now: () => t,
    setTimeout: (f, ms) => { timers.push({ at: t + ms, f, id: ++id }); return id; },
    clearTimeout: (x) => { const i = timers.findIndex((y) => y.id === x); if (i >= 0) timers.splice(i, 1); },
    visible: () => visible,
    online: () => online,
    listen: (type, f) => { handlers[type]!.push(f); },
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return {
    env,
    async advance(ms: number) {
      t += ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const next = timers[0];
        if (!next || next.at > t) break;
        timers.shift(); next.f(); await flush();
      }
      await flush();
    },
    nextDelay: () => (timers.length ? Math.min(...timers.map((x) => x.at)) - t : null),
    setOnline(v: boolean) { online = v; if (v) handlers.online!.forEach((f) => f()); },
    setVisible(v: boolean) { visible = v; handlers.visibilitychange!.forEach((f) => f()); },
    flush,
  };
}

const offlineErr = () => new TypeError('Failed to fetch');

describe('read store: last good copy', () => {
  it('a failed read keeps the data that loaded and marks it offline when the network is gone', async () => {
    const h = harness(); const s = createReadStore(h.env);
    let fail = false;
    s.use('queue', async () => { if (fail) throw offlineErr(); return ['a', 'b']; });
    const off = s.subscribe('queue', () => {});
    await s.load('queue');
    expect(s.snap('queue')).toMatchObject({ data: ['a', 'b'], loading: false, offline: false, error: undefined });
    const at = s.snap('queue').at;
    fail = true;
    await s.load('queue');
    expect(s.snap('queue')).toMatchObject({ data: ['a', 'b'], loading: false, offline: true, error: undefined, at });
    off();
  });

  it('error only when nothing has ever loaded for the key', async () => {
    const h = harness(); const s = createReadStore(h.env);
    s.use('report', async () => { throw offlineErr(); });
    await s.load('report');
    expect(s.snap('report').data).toBeUndefined();
    expect(s.snap('report').error).toContain('Failed to fetch');
    expect(s.snap('report').offline).toBe(false);
  });

  it('a result with failed parts (good says no) never replaces data', async () => {
    const h = harness(); const s = createReadStore(h.env);
    let v = { ok: true, n: 20 };
    s.use('today', async () => v, (x) => (x as typeof v).ok);
    await s.load('today');
    v = { ok: false, n: 0 };
    await s.load('today');
    expect(s.snap('today').data).toEqual({ ok: true, n: 20 });
    expect(s.snap('today').error).toBeUndefined();
  });

  it('a non network failure keeps data without the offline line', async () => {
    const h = harness(); const s = createReadStore(h.env);
    let fail = false;
    s.use('k', async () => { if (fail) throw new RestError(403, 'no'); return 1; });
    await s.load('k');
    fail = true;
    await s.load('k');
    expect(s.snap('k')).toMatchObject({ data: 1, offline: false, error: undefined });
  });

  it('keys are independent: one module failing leaves the others', async () => {
    const h = harness(); const s = createReadStore(h.env);
    let fail = false;
    s.use('queue', async () => { if (fail) throw offlineErr(); return 'q'; });
    s.use('hygiene', async () => 'h');
    await Promise.all([s.load('queue'), s.load('hygiene')]);
    fail = true;
    await s.load('queue');
    expect(s.snap('hygiene')).toMatchObject({ data: 'h', offline: false });
    expect(s.snap('queue')).toMatchObject({ data: 'q', offline: true });
  });

  it('clear forgets everything (sign-out)', async () => {
    const h = harness(); const s = createReadStore(h.env);
    s.use('k', async () => 1);
    await s.load('k');
    expect(s.size()).toBe(1);
    s.clear();
    expect(s.size()).toBe(0);
    expect(s.snap('k').data).toBeUndefined();
  });
});

describe('read store: one request per key, retries, reconnect', () => {
  it('dedups reads in flight for the same key', async () => {
    const h = harness(); const s = createReadStore(h.env);
    let calls = 0; let done: (v: number) => void = () => {};
    s.use('k', () => { calls++; return new Promise<number>((r) => { done = r; }); });
    const a = s.load('k'); const b = s.load('k'); s.load('k');
    expect(calls).toBe(1);
    expect(a).toBe(b);
    done(7); await a;
    expect(s.snap('k').data).toBe(7);
    const c = s.load('k'); done(8); await c;
    expect(calls).toBe(2);
    expect(s.snap('k').data).toBe(8);
  });

  it('backs off 1 s, 2 s, 4 s, then 8 s, and resets on success', async () => {
    const h = harness(); const s = createReadStore(h.env);
    let fail = true; let calls = 0;
    s.use('k', async () => { calls++; if (fail) throw offlineErr(); return calls; });
    s.subscribe('k', () => {});
    await s.load('k');
    const seen: (number | null)[] = [];
    for (let i = 0; i < 5; i++) { const d = h.nextDelay(); seen.push(d); await h.advance(d ?? 0); }
    expect(seen).toEqual([1000, 2000, 4000, 8000, 8000]);
    expect(calls).toBe(6);
    fail = false;
    await h.advance(h.nextDelay() ?? 0);
    expect(s.snap('k').offline).toBe(false);
    expect(s.fails('k')).toBe(0);
    expect(h.nextDelay()).toBeNull();
    expect(backoffMs(1)).toBe(1000);
    expect(backoffMs(9)).toBe(8000);
  });

  it('no retries for keys nobody shows, and none while the tab is hidden', async () => {
    const h = harness(); const s = createReadStore(h.env);
    s.use('k', async () => { throw offlineErr(); });
    await s.load('k');
    expect(h.nextDelay()).toBeNull();
    s.subscribe('k', () => {});
    h.setVisible(false);
    await s.load('k');
    expect(h.nextDelay()).toBeNull();
  });

  it('coming back online refetches what is on screen and clears the offline mark', async () => {
    const h = harness(); const s = createReadStore(h.env);
    let fail = false; let calls = 0;
    s.use('queue', async () => { calls++; if (fail) throw offlineErr(); return calls; });
    s.use('report', async () => 'r');
    const off = s.subscribe('queue', () => {});
    await s.load('queue');
    fail = true;
    h.setOnline(false);
    await s.load('queue');
    expect(s.snap('queue').offline).toBe(true);
    fail = false;
    const before = calls;
    h.setOnline(true);
    await h.flush(); await h.flush();
    expect(calls).toBe(before + 1);
    expect(s.snap('queue')).toMatchObject({ offline: false, data: before + 1 });
    expect(s.snap('report').data).toBeUndefined(); // not on screen, not fetched
    off();
  });

  it('the tab becoming visible refetches what is on screen', async () => {
    const h = harness(); const s = createReadStore(h.env);
    let calls = 0;
    s.use('k', async () => ++calls);
    s.subscribe('k', () => {});
    await s.load('k');
    h.setVisible(false);
    h.setVisible(true);
    await h.flush(); await h.flush();
    expect(calls).toBe(2);
  });

  it('subscribers hear every change', async () => {
    const h = harness(); const s = createReadStore(h.env);
    let n = 0;
    s.use('k', async () => 1);
    s.subscribe('k', () => { n++; });
    await s.load('k');
    expect(n).toBeGreaterThanOrEqual(1);
  });
});

describe('what counts as no network', () => {
  it('fetch failures in each engine, refresh with no network, and the browser saying offline', () => {
    expect(isNetworkish(new TypeError('Failed to fetch'))).toBe(true);
    expect(isNetworkish(new TypeError('Load failed'))).toBe(true);
    expect(isNetworkish(new Error('The Internet connection appears to be offline.'))).toBe(true);
    expect(isNetworkish(new TransientAuthError(0))).toBe(true);
    expect(isNetworkish(new TransientAuthError(503))).toBe(false);
    expect(isNetworkish(new RestError(500, 'x'))).toBe(false);
    expect(isNetworkish(new Error('anything'), false)).toBe(true);
    expect(isNetworkish(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
  });
  it('transient: network, 408, 429, 5xx and auth retrying; not 403 or 404', () => {
    expect(isTransient(new RestError(503, 'x'))).toBe(true);
    expect(isTransient(new RestError(429, 'x'))).toBe(true);
    expect(isTransient(new TransientAuthError(503))).toBe(true);
    expect(isTransient(new RestError(403, 'x'))).toBe(false);
    expect(isTransient(new RestError(404, 'x'))).toBe(false);
  });
});

describe('offline line time', () => {
  it('h:mm a in the viewer clock', () => {
    const d = new Date(2026, 9, 18, 16, 5); expect(hma(d.getTime())).toBe('4:05 PM');
    expect(hma(new Date(2026, 9, 18, 0, 7).getTime())).toBe('12:07 AM');
    expect(hma(new Date(2026, 9, 18, 12, 0).getTime())).toBe('12:00 PM');
    expect(hma(new Date(2026, 9, 18, 9, 30).getTime())).toBe('9:30 AM');
  });
});
