// B+ shell routes, in the hash so Back works and every state has a URL (QA and screenshots).
//   #/stack  #/stack?pass=dm1  #/desk  #/desk?sheet=accounts|report  #/motion/<id>  #/account  #/signin
import { useSyncExternalStore } from 'react';

export type Place = 'stack' | 'desk' | 'motion' | 'account' | 'signin';
export type SheetName = 'accounts' | 'report';
export interface Route { place: Place; id: string; sheet: SheetName | null; pass: string | null }

export function parse(hash: string): Route {
  const [path = '', query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [head = '', id = ''] = path.split('/');
  const q = new URLSearchParams(query);
  const place: Place = (['stack', 'desk', 'motion', 'account', 'signin'] as const).find((p) => p === head) ?? 'stack';
  const sheet = q.get('sheet');
  return { place, id: decodeURIComponent(id), sheet: sheet === 'accounts' || sheet === 'report' ? sheet : null, pass: q.get('pass') };
}

let pushed = 0;
let ours = false;
const subscribe = (cb: () => void) => {
  const on = () => { if (!ours) pushed = Math.max(0, pushed - 1); ours = false; cb(); };
  addEventListener('hashchange', on);
  return () => removeEventListener('hashchange', on);
};
const snapshot = () => location.hash;

export function useRoute(): Route {
  return parse(useSyncExternalStore(subscribe, snapshot));
}

/** Go somewhere new (Back returns here). */
export function go(hash: string) {
  if (location.hash === hash) return;
  ours = true; pushed += 1;
  location.hash = hash;
}

/** Leave a sub state (a sheet, an open pass, a sub screen): Back when we pushed it, else replace with the fallback. */
export function back(fallback: string) {
  if (pushed > 0) { pushed -= 1; ours = true; history.back(); return; }
  ours = true;
  location.replace(`${location.pathname}${location.search}${fallback}`);
}

/** Swap without adding to history (the Stack | Desk pill). */
export function swap(hash: string) {
  if (location.hash === hash) return;
  ours = true;
  location.replace(`${location.pathname}${location.search}${hash}`);
}
