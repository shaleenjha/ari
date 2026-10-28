import { useEffect, useState } from 'react';
export type Route = { name: 'today' } | { name: 'today15' } | { name: 'replies' } | { name: 'report' } | { name: 'import' } | { name: 'account'; id: string };
export function parse(hash: string): Route {
  const [a, b] = hash.replace(/^#\/?/, '').split('/');
  if (a === 'today15') return { name: 'today15' };
  if (a === 'replies') return { name: 'replies' };
  if (a === 'report') return { name: 'report' };
  if (a === 'import') return { name: 'import' };
  if (a === 'account' && b) return { name: 'account', id: decodeURIComponent(b) };
  return { name: 'today' };
}
export function useRoute(): Route {
  const [r, setR] = useState(() => parse(location.hash));
  useEffect(() => { const f = () => setR(parse(location.hash)); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []);
  return r;
}
export const go = (path: string): void => { location.hash = path; };
