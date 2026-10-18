// Live mode only: the Google sign-in state the shell renders from (signed in, signed out, or a sign-in error line).
import { useSyncExternalStore } from 'react';
import type { Auth } from '../data/auth';

let auth: Auth | null = null;
let error: string | null = null;
let misconfigured = false;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
let snap = { live: false, signedIn: false, error: null as string | null, misconfigured: false };
const take = () => {
  const next = { live: !!auth || misconfigured, signedIn: !!auth?.session(), error, misconfigured };
  if (next.live !== snap.live || next.signedIn !== snap.signedIn || next.error !== snap.error || next.misconfigured !== snap.misconfigured) snap = next;
  return snap;
};

export function setAuth(a: Auth, err: string | null) { auth = a; error = err; a.subscribe(emit); emit(); }
export function setMisconfigured() { misconfigured = true; emit(); }
export const signIn = () => { error = null; void auth?.start(); };
export const signOut = () => auth?.signOut();
export const useSession = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, take, take);
