// Replies Owner set aside with "Not now". Local to this session: the data layer has no reply status command yet
// (Reply.status already has 'not_now'; wire it to that command when it exists). A set aside reply leaves Replies and
// the Today pin; Undo (toast, 10 s) or "Move back" returns it.
import { useSyncExternalStore } from 'react';

export const UNDO_MS = 10_000;

export function createNotNow() {
  let ids: ReadonlySet<string> = new Set();
  const subs = new Set<() => void>();
  const set = (next: Set<string>) => { ids = next; subs.forEach((f) => f()); };
  return {
    get: (): ReadonlySet<string> => ids,
    has: (id: string) => ids.has(id),
    add: (id: string) => { if (!ids.has(id)) set(new Set([...ids, id])); },
    remove: (id: string) => { if (ids.has(id)) { const n = new Set(ids); n.delete(id); set(n); } },
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
}

export const notNow = createNotNow();
export const useNotNow = (): ReadonlySet<string> => useSyncExternalStore(notNow.subscribe, notNow.get, notNow.get);
