import { beforeEach, describe, expect, it, vi } from 'vitest';

// idb-keyval backed by a Map (node has no IndexedDB). Hoisted so every module below sees it.
const db = vi.hoisted(() => new Map<string, unknown>());
vi.mock('idb-keyval', () => ({
  get: async (k: string) => db.get(k),
  update: async (k: string, f: (o: unknown) => unknown) => { db.set(k, f(db.get(k))); },
  del: async (k: string) => { db.delete(k); },
  clear: async () => { db.clear(); },
}));

import { Auth } from '../data/auth';
import { createReadStore, type ReadEnv } from './readStore';
import { TODAY_V, TTL_MS, idbKv, readToday, seedToday, todayKey, userIdOf, wireToday } from './todayCache';
import { readCacheSize, readStore } from './useAsync';
import { setAuth, signOut } from './session';

const env = (t: { now: number }, online = { v: true }): ReadEnv => ({
  now: () => t.now, setTimeout: () => 0, clearTimeout: () => undefined, visible: () => true, online: () => online.v, listen: null,
});
const tick = () => new Promise((r) => setTimeout(r, 0));
const entry = (cached_at: number, data: Record<string, { at: number; v: unknown }>) => ({ v: TODAY_V, cached_at, data });

beforeEach(() => { db.clear(); readStore.clear(); });

describe('key scoping', () => {
  it('one key per user id; no user id, no key', () => {
    expect(todayKey('u1')).toBe('today_queue_u1');
    expect(todayKey('u2')).not.toBe(todayKey('u1'));
    expect(todayKey(null)).toBeNull();
    expect(todayKey('')).toBeNull();
  });
  it('user id from the session, else the token sub', () => {
    const jwt = `x.${btoa(JSON.stringify({ sub: 'u9' }))}.y`;
    expect(userIdOf({ userId: 'u1', accessToken: jwt })).toBe('u1');
    expect(userIdOf({ accessToken: jwt })).toBe('u9');
    expect(userIdOf({ accessToken: 'acc-test' })).toBeNull();
    expect(userIdOf(null)).toBeNull();
  });
  it('writes only Today parts, only under the user signed in when the read lands', async () => {
    const t = { now: 5000 };
    const s = createReadStore(env(t));
    let uid: string | null = 'u1';
    wireToday(s, idbKv, () => uid);
    for (const k of ['queue:[]', 'hygiene:[]', 'replies:[]', 'report:[]']) { s.use(k, async () => [k]); await s.load(k); }
    expect(Object.keys((db.get('today_queue_u1') as { data: object }).data).sort()).toEqual(['hygiene:[]', 'queue:[]']);
    uid = null;
    s.use('queue:[]', async () => ['later']); await s.load('queue:[]'); await tick();
    expect([...db.keys()]).toEqual(['today_queue_u1']);
    expect((db.get('today_queue_u1') as { cached_at: number }).cached_at).toBe(5000);
  });
  it('a read the good check refuses is never written', async () => {
    const s = createReadStore(env({ now: 1 }));
    wireToday(s, idbKv, () => 'u1');
    s.use('queue:[]', async () => ['partial'], () => false);
    await s.load('queue:[]');
    expect(db.size).toBe(0);
  });
});

describe('24 hour TTL', () => {
  it('an entry older than 24 h is deleted on read and never shown', async () => {
    db.set('today_queue_u1', entry(0, { 'queue:[]': { at: 0, v: ['old'] } }));
    expect(await readToday(idbKv, 'u1', TTL_MS + 1)).toBeNull();
    expect(db.has('today_queue_u1')).toBe(false);
    const s = createReadStore(env({ now: 0 }));
    db.set('today_queue_u1', entry(0, { 'queue:[]': { at: 0, v: ['old'] } }));
    expect(await seedToday(s, idbKv, 'u1', TTL_MS + 1)).toBe(0);
    expect(s.snap('queue:[]').data).toBeUndefined();
  });
  it('inside 24 h it is kept; another schema version is dropped', async () => {
    db.set('today_queue_u1', entry(0, {}));
    expect(await readToday(idbKv, 'u1', TTL_MS)).not.toBeNull();
    db.set('today_queue_u1', { ...entry(0, {}), v: TODAY_V + 1 });
    expect(await readToday(idbKv, 'u1', 1)).toBeNull();
    expect(db.has('today_queue_u1')).toBe(false);
  });
});

describe('seed and the overwrite guard', () => {
  it('seeds before the read; a failed refetch keeps the seed and shows the offline line from cached_at', async () => {
    const t = { now: 10_000 };
    const online = { v: false };
    const s = createReadStore(env(t, online));
    db.set('today_queue_u1', entry(9000, { 'queue:[]': { at: 9000, v: ['T1'] }, 'hygiene:[]': { at: 9000, v: ['F1'] } }));
    expect(await seedToday(s, idbKv, 'u1', t.now)).toBe(2);
    expect(s.snap('queue:[]').data).toEqual(['T1']);
    s.use('queue:[]', async () => { throw new TypeError('Failed to fetch'); });
    await s.load('queue:[]');
    expect(s.snap('queue:[]')).toMatchObject({ data: ['T1'], at: 9000, offline: true, error: undefined });
    online.v = true;
    s.use('queue:[]', async () => ['T2']);
    await s.load('queue:[]');
    expect(s.snap('queue:[]')).toMatchObject({ data: ['T2'], offline: false });
  });
  it('a seed never replaces data already in memory', async () => {
    const s = createReadStore(env({ now: 1 }));
    s.use('queue:[]', async () => ['fresh']); await s.load('queue:[]');
    s.seed('queue:[]', ['seeded'], 0);
    expect(s.snap('queue:[]').data).toEqual(['fresh']);
  });
  it("another user's entry is never seeded", async () => {
    const s = createReadStore(env({ now: 1 }));
    db.set('today_queue_u1', entry(1, { 'queue:[]': { at: 1, v: ['u1'] } }));
    expect(await seedToday(s, idbKv, 'u2', 1)).toBe(0);
    expect(await seedToday(s, idbKv, null, 1)).toBe(0);
  });
});

describe('purge', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { get length() { return m.size; }, clear: () => m.clear(), getItem: (k: string) => m.get(k) ?? null, key: () => null,
      removeItem: (k: string) => { m.delete(k); }, setItem: (k: string, v: string) => { m.set(k, v); } } as Storage;
  };
  const session = (st: Storage, exp: number) => st.setItem('ari2-session', JSON.stringify({ accessToken: 'a', refreshToken: 'r', expiresAt: exp, userId: 'u1' }));
  const lock = { request: <T,>(_n: string, f: () => Promise<T>) => f() };
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('sign out clears the session, memory and every device entry', async () => {
    const st = store(); session(st, Date.now() + 3_600_000);
    const a = new Auth({ url: 'https://x.invalid', apikey: 'k', googleClientId: 'c' }, vi.fn(), st, {} as never, Date.now, store());
    setAuth(a, null);
    db.set('today_queue_u1', entry(1, {})); db.set('today_queue_u2', entry(1, {}));
    readStore.seed('queue:[]', ['T1'], 1);
    await signOut();
    expect(a.session()).toBeNull();
    expect(db.size).toBe(0);
    expect(readCacheSize()).toBe(0);
  });

  for (const [name, status, body, purged] of [
    ['invalid_grant', 400, { error: 'invalid_grant' }, true],
    ['refresh_token_not_found', 400, { error_code: 'refresh_token_not_found' }, true],
    ['429', 429, {}, false], ['408', 408, {}, false], ['503', 503, {}, false], ['network', 0, null, false],
  ] as const) {
    it(`refresh ${name}: device entries ${purged ? 'purged' : 'kept'}`, async () => {
      const st = store(); session(st, 0);
      const f = vi.fn(async () => { if (status === 0) throw new TypeError('Failed to fetch'); return reply(status, body); });
      const a = new Auth({ url: 'https://x.invalid', apikey: 'k', googleClientId: 'c' }, f, st, {} as never, () => 1, store(),
        { locks: lock, sleep: async () => undefined, tries: 2 });
      setAuth(a, null);
      db.set('today_queue_u1', entry(1, {}));
      await a.token().catch(() => undefined);
      await tick();
      expect(db.size).toBe(purged ? 0 : 1);
    });
  }
});
