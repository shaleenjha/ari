// Last good read per key (v18.15.2). Memory only, this tab, never written to storage; cleared on sign-out.
// Rules:
// - A failed read (a reject, or a result the caller's `good` check refuses because parts failed) never replaces data that
//   already loaded for that key. The screen keeps it and, when the failure looks like no network, shows one quiet line.
// - "Could not load" (snapshot.error) only when nothing has ever loaded for that key in this tab.
// - One request per key at a time (in-flight dedup). A transient failure retries the keys on screen after 1 s, 2 s, 4 s,
//   then every 8 s; success resets the steps. Coming back online, or the tab becoming visible again, refetches now.
import { TransientAuthError } from '../data/auth';
import { RestError } from '../data/rest';

export interface ReadSnap<T = unknown> {
  data: T | undefined;
  /** When `data` last loaded (ms). */
  at?: number;
  loading: boolean;
  /** Only when nothing has ever loaded for this key. */
  error?: string;
  /** The last read failed and looks like no network, while `data` is still shown. */
  offline: boolean;
}

export interface ReadEnv {
  now: () => number;
  setTimeout: (f: () => void, ms: number) => unknown;
  clearTimeout: (t: unknown) => void;
  /** False while the tab is in the background. */
  visible: () => boolean;
  /** False when the browser knows it has no network. */
  online: () => boolean;
  /** Where 'online' and 'visibilitychange' are listened for. Null in tests that fire them by hand. */
  listen: ((type: 'online' | 'visibilitychange', f: () => void) => void) | null;
}

export const BACKOFF_MS = [1000, 2000, 4000, 8000] as const;
export const backoffMs = (fails: number): number => BACKOFF_MS[Math.min(Math.max(fails, 1), BACKOFF_MS.length) - 1] ?? 8000;

/** No network: the browser says so, fetch itself failed, or a sign-in refresh could not reach the server. */
export function isNetworkish(e: unknown, online = true): boolean {
  if (!online) return true;
  if (e instanceof TransientAuthError) return e.status === 0;
  if (e instanceof RestError) return e.status === 0;
  const m = e instanceof Error ? `${e.name} ${e.message}` : String(e);
  return /failed to fetch|load failed|network ?error|networkerror|internet disconnected|offline/i.test(m);
}

/** Worth retrying by itself: no network, or the server is busy or briefly down. */
export function isTransient(e: unknown, online = true): boolean {
  if (isNetworkish(e, online)) return true;
  if (e instanceof TransientAuthError) return true;
  if (e instanceof RestError) return e.status === 408 || e.status === 429 || e.status >= 500;
  return false;
}

/** Thrown inside the store when a result comes back with failed parts (the caller's `good` check said no). */
export class PartialReadError extends Error {
  constructor(public cause?: unknown) { super('some parts did not load'); }
}

interface Entry {
  snap: ReadSnap;
  fn?: () => Promise<unknown>;
  good?: (v: unknown) => boolean;
  inflight: Promise<void> | null;
  fails: number;
  timer: unknown;
  subs: Set<() => void>;
  /** Ephemeral keys (no `key` given) are dropped when the last subscriber leaves. */
  temp: boolean;
}

const EMPTY: ReadSnap = { data: undefined, loading: true, offline: false };

export function createReadStore(env: ReadEnv) {
  const m = new Map<string, Entry>();
  let wired = false;

  const entry = (key: string): Entry => {
    let e = m.get(key);
    if (!e) { e = { snap: EMPTY, inflight: null, fails: 0, timer: null, subs: new Set(), temp: false }; m.set(key, e); }
    return e;
  };
  const set = (e: Entry, next: Partial<ReadSnap>) => { e.snap = { ...e.snap, ...next }; e.subs.forEach((f) => f()); };
  const stopTimer = (e: Entry) => { if (e.timer != null) { env.clearTimeout(e.timer); e.timer = null; } };

  function schedule(key: string, e: Entry) {
    stopTimer(e);
    if (e.subs.size === 0 || !env.visible()) return;
    e.timer = env.setTimeout(() => { e.timer = null; void load(key); }, backoffMs(e.fails));
  }

  /** Start a read for `key`, or join the one already in flight. Never rejects. */
  function load(key: string): Promise<void> {
    const e = entry(key);
    if (e.inflight) return e.inflight;
    const fn = e.fn;
    if (!fn) return Promise.resolve();
    stopTimer(e);
    if (!e.snap.loading) set(e, { loading: true });
    const run = (async () => {
      try {
        const v = await fn();
        if (e.good && !e.good(v)) throw new PartialReadError(v);
        e.fails = 0;
        set(e, { data: v, at: env.now(), loading: false, error: undefined, offline: false });
      } catch (err) {
        e.fails += 1;
        const online = env.online();
        const net = err instanceof PartialReadError ? !online : isNetworkish(err, online);
        const has = e.snap.data !== undefined;
        // Data that loaded before stays. The error line is only for a key that never loaded.
        set(e, { loading: false, offline: has && net, error: has ? undefined : String(err) });
        if (err instanceof PartialReadError || isTransient(err, online)) schedule(key, e);
      } finally {
        e.inflight = null;
      }
    })();
    e.inflight = run;
    return run;
  }

  /** Refetch every key a screen is showing now (coming back online, or the tab visible again). Steps start over. */
  function refetchVisible() {
    if (!env.visible()) return;
    for (const [key, e] of m) if (e.subs.size > 0) { e.fails = 0; void load(key); }
  }

  function wire() {
    if (wired || !env.listen) return;
    wired = true;
    env.listen('online', refetchVisible);
    env.listen('visibilitychange', () => { if (env.visible()) refetchVisible(); else for (const e of m.values()) stopTimer(e); });
  }

  return {
    /** Register the reader for a key (the latest component wins) without starting it. */
    use(key: string, fn: () => Promise<unknown>, good?: (v: unknown) => boolean, temp = false) {
      const e = entry(key);
      e.fn = fn; e.good = good; e.temp = temp;
    },
    load,
    subscribe(key: string, f: () => void) {
      wire();
      const e = entry(key);
      e.subs.add(f);
      return () => {
        e.subs.delete(f);
        if (e.subs.size === 0) { stopTimer(e); if (e.temp && !e.inflight) m.delete(key); }
      };
    },
    snap(key: string): ReadSnap { return m.get(key)?.snap ?? EMPTY; },
    refetchVisible,
    clear() { for (const e of m.values()) stopTimer(e); m.clear(); },
    size() { let n = 0; for (const e of m.values()) if (e.snap.data !== undefined) n++; return n; },
    /** Test hook: the retry step a key is on. */
    fails(key: string) { return m.get(key)?.fails ?? 0; },
  };
}

export type ReadStore = ReturnType<typeof createReadStore>;

const g = globalThis as unknown as { document?: Document; navigator?: Navigator; addEventListener?: Window['addEventListener'] };
export const browserEnv: ReadEnv = {
  now: () => Date.now(),
  setTimeout: (f, ms) => globalThis.setTimeout(f, ms),
  clearTimeout: (t) => globalThis.clearTimeout(t as ReturnType<typeof setTimeout>),
  visible: () => g.document?.visibilityState !== 'hidden',
  online: () => g.navigator?.onLine !== false,
  listen: (type, f) => {
    if (type === 'online') g.addEventListener?.('online', f);
    else g.document?.addEventListener('visibilitychange', f);
  },
};

/** "4:05 PM" in the viewer's own clock (h:mm a), for the quiet offline line. */
export function hma(at: number): string {
  const d = new Date(at);
  const h = d.getHours();
  return `${h % 12 || 12}:${String(d.getMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}
