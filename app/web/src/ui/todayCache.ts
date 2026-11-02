// Today's last good read on this device (v18.15.3): the queue and Tidy up only, never threads, bios, Replies or Report.
// One entry per signed-in user, `today_queue_${user_id}`; no user id means nothing is kept. Written on every good read,
// read once on cold boot to seed the memory store, dropped after 24 h, and wiped on sign-out or a terminal sign-in refresh.
import { clear, del, get, update } from 'idb-keyval';
import type { ReadStore } from './readStore';

export const TODAY_V = 1;
export const TTL_MS = 24 * 3600_000;
/** The read-store keys Today uses for its queue and Tidy up (useAsync key plus deps). */
export const TODAY_PARTS = ['queue:[]', 'hygiene:[]'] as const;
type Part = { at: number; v: unknown };
export interface TodayEntry { v: number; cached_at: number; data: Record<string, Part> }
export interface Kv {
  get(k: string): Promise<unknown>;
  /** Read and replace one entry in a single device transaction (idb-keyval update). */
  merge(k: string, f: (old: unknown) => unknown): Promise<void>;
  del(k: string): Promise<void>;
  clear(): Promise<void>;
}
export const idbKv: Kv = { get, merge: update, del, clear };

export const todayKey = (uid?: string | null) => (uid ? `today_queue_${uid}` : null);
const fresh = (e: unknown, now: number): e is TodayEntry => {
  const x = e as TodayEntry | undefined;
  return !!x && x.v === TODAY_V && typeof x.cached_at === 'number' && now - x.cached_at <= TTL_MS && !!x.data;
};

/** The entry for this user, or null. A stale or older-schema entry is deleted and never shown. */
export async function readToday(kv: Kv, uid: string | null | undefined, now: number): Promise<TodayEntry | null> {
  const k = todayKey(uid);
  if (!k) return null;
  const e = await kv.get(k).catch(() => undefined);
  if (e === undefined) return null;
  if (!fresh(e, now)) { await kv.del(k).catch(() => undefined); return null; }
  return e;
}

/** Cold boot: put this user's last good Today into the memory store before the first read starts. */
export async function seedToday(store: Pick<ReadStore, 'seed'>, kv: Kv, uid: string | null | undefined, now: number): Promise<number> {
  const e = await readToday(kv, uid, now);
  let n = 0;
  for (const [key, p] of Object.entries(e?.data ?? {})) if (now - p.at <= TTL_MS) { store.seed(key, p.v, p.at); n++; }
  return n;
}

/** Keep each good Today read for whoever is signed in at the time it lands. */
export function wireToday(store: Pick<ReadStore, 'onGood'>, kv: Kv, uid: () => string | null | undefined) {
  return store.onGood((key, v, at) => {
    const k = (TODAY_PARTS as readonly string[]).includes(key) ? todayKey(uid()) : null;
    if (!k) return;
    void kv.merge(k, (old) => ({ v: TODAY_V, cached_at: at, data: { ...(fresh(old, at) ? old.data : {}), [key]: { at, v } } })).catch(() => undefined);
  });
}

export const purgeToday = (kv: Kv = idbKv) => kv.clear().catch(() => undefined);

/** The signed-in user's id: the session's own, else the `sub` of its access token. */
export function userIdOf(s: { userId?: string; accessToken?: string } | null | undefined): string | null {
  if (!s) return null;
  if (s.userId) return s.userId;
  try {
    const b = s.accessToken?.split('.')[1];
    const sub = b ? (JSON.parse(atob(b.replace(/-/g, '+').replace(/_/g, '/'))) as { sub?: unknown }).sub : undefined;
    return typeof sub === 'string' && sub ? sub : null;
  } catch { return null; }
}
