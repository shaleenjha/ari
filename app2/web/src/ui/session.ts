// Live mode only: the Google sign-in state the shell renders from (signed in, signed out, or a sign-in error line).
import { useSyncExternalStore } from 'react';
import type { Auth } from '../data/auth';
import { clearReadCache } from './useAsync';

let auth: Auth | null = null;
let error: string | null = null;
let misconfigured = false;
let embedded = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
let snap = { live: false, signedIn: false, retrying: false, error: null as string | null, misconfigured: false, embedded: false };
const take = () => {
  let signedIn = false;
  try { signedIn = !!auth?.session(); } catch { signedIn = false; }
  if (auth && !signedIn) clearReadCache();
  const retrying = auth?.status() === 'retrying';
  const next = { live: !!auth || misconfigured, signedIn, retrying, error, misconfigured, embedded };
  if (next.live !== snap.live || next.signedIn !== snap.signedIn || next.retrying !== snap.retrying || next.error !== snap.error || next.misconfigured !== snap.misconfigured
    || next.embedded !== snap.embedded) snap = next;
  return snap;
};

export function setAuth(a: Auth, err: string | null) { auth = a; error = err; a.subscribe(emit); emit(); }
/** Inside an app's link viewer (ui/embedded.ts), or forced with ?embed=1 for tests. */
export function setEmbedded(v: boolean) { embedded = v; emit(); }
export function setMisconfigured() { misconfigured = true; emit(); }
export const signIn = () => { error = null; void auth?.start(); };
export const signOut = () => auth?.signOut();
export const useSession = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, take, take);
