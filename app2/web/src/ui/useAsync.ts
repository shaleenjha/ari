import { useCallback, useEffect, useState } from 'react';
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): { data: T | undefined; loading: boolean; error?: string; reload: () => void } {
  const [s, setS] = useState<{ data?: T; loading: boolean; error?: string }>({ loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    setS((p) => ({ ...p, loading: true }));
    fn().then((data) => live && setS({ data, loading: false })).catch((e: unknown) => live && setS({ loading: false, error: String(e) }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  return { data: s.data, loading: s.loading, error: s.error, reload };
}
