import { useCallback, useEffect, useId, useSyncExternalStore } from 'react';
import { browserEnv, createReadStore, type ReadSnap } from './readStore';

// Screens read through one memory store (ui/readStore.ts): a failed read never replaces what already loaded, "Could not
// load" only when nothing ever loaded for that key in this tab, one request per key at a time, retries with backoff, and
// a refetch of what is on screen when the network comes back or the tab is visible again. Never written to storage.
const store = createReadStore(browserEnv);
export const readStore = store;
export const clearReadCache = () => store.clear();
export const readCacheSize = () => store.size();

export interface AsyncOpts<T> {
  /** Shared name for this read. Two screens with the same key and deps share one copy and one request. */
  key?: string;
  /** False for a result that came back with failed parts: treated as a failed read, so it never replaces data. */
  good?: (v: T) => boolean;
}
export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  /** Only when nothing has ever loaded for this read in this tab. */
  error?: string;
  /** When the data on screen loaded, set only while a read is failing for lack of network (the quiet offline line). */
  stale?: number;
  reload: () => void;
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: AsyncOpts<T> = {}): AsyncState<T> {
  const anon = useId();
  const k = `${opts.key ?? `anon${anon}`}:${JSON.stringify(deps)}`;
  // The latest reader for this key; registering does not start a request.
  store.use(k, fn as () => Promise<unknown>, opts.good as ((v: unknown) => boolean) | undefined, !opts.key);
  const s = useSyncExternalStore(useCallback((f: () => void) => store.subscribe(k, f), [k]), () => store.snap(k), () => store.snap(k)) as ReadSnap<T>;
  // Every mount (and every change of key) reads again; what loaded before stays on screen meanwhile.
  useEffect(() => { void store.load(k); }, [k]);
  const reload = useCallback(() => { void store.load(k); }, [k]);
  return { data: s.data, loading: s.loading, error: s.error, stale: s.offline ? s.at : undefined, reload };
}

/** The oldest load time among reads shown while offline, for a screen built from several reads. */
export const oldestStale = (...at: (number | undefined)[]) => {
  const xs = at.filter((x): x is number => x != null);
  return xs.length ? Math.min(...xs) : undefined;
};
