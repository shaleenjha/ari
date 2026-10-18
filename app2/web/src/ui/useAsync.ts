import { useCallback, useEffect, useState } from 'react';

// Last good read per screen (v18.15.0). Memory only, this tab: when a read fails for now (offline, 429, 5xx, a refresh
// that is retrying) the screen keeps showing the last copy it loaded, with a quiet "Updated <time>" line. Never written
// to storage (content stays off disk), cleared on sign-out.
const cache = new Map<string, { v: unknown; at: number }>();
export const clearReadCache = () => cache.clear();
export const readCacheSize = () => cache.size;

export interface AsyncOpts<T> { key?: string; good?: (v: T) => boolean }
export interface AsyncState<T> { data: T | undefined; loading: boolean; error?: string; stale?: number; reload: () => void }

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = [], opts: AsyncOpts<T> = {}): AsyncState<T> {
  const { key, good } = opts;
  const [s, setS] = useState<{ data?: T; loading: boolean; error?: string; stale?: number }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setS((p) => ({ ...p, loading: true }));
    const k = key ? `${key}:${JSON.stringify(deps)}` : null;
    const fallback = () => {
      const c = k ? cache.get(k) : undefined;
      if (c) setS({ data: c.v as T, loading: false, stale: c.at });
      else return false;
      return true;
    };
    fn().then((data) => {
      if (!live) return;
      if (good && !good(data)) { if (!fallback()) setS({ data, loading: false }); return; }
      if (k) cache.set(k, { v: data, at: Date.now() });
      setS({ data, loading: false });
    }).catch((e: unknown) => { if (live && !fallback()) setS({ loading: false, error: String(e) }); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data: s.data, loading: s.loading, error: s.error, stale: s.stale, reload };
}

/** "14:05" in the viewer's own clock, for the quiet stale line. */
export const hhmm = (at: number) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
