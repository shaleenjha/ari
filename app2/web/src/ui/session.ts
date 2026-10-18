// Live mode only: the Google sign-in state the shell renders from (signed in, signed out, or a sign-in error line).
import { useSyncExternalStore } from 'react';
import type { Auth } from '../data/auth';
import { clearReadCache, readStore } from './useAsync';
import { idbKv, purgeToday, seedToday, userIdOf, wireToday } from './todayCache';

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

export function setAuth(a: Auth, err: string | null) { auth = a; error = err; a.onTerminal = () => { clearReadCache(); void purgeToday(); }; a.subscribe(emit); emit(); }
/** The signed-in user's id (no id, no device copy of Today). */
export const userId = () => { try { return userIdOf(auth?.session()); } catch { return null; } };
/** Cold boot: seed Today from this device before the first read; never waits more than 300 ms. */
export async function seedFromDevice(): Promise<void> {
  wireToday(readStore, idbKv, userId);
  const uid = userId();
  if (uid) await Promise.race([seedToday(readStore, idbKv, uid, Date.now()).catch(() => 0), new Promise((r) => setTimeout(r, 300))]);
}
/** Inside an app's link viewer (ui/embedded.ts), or forced with ?embed=1 for tests. */
export function setEmbedded(v: boolean) { embedded = v; emit(); }
export function setMisconfigured() { misconfigured = true; emit(); }
export const signIn = () => { error = null; void auth?.start(); };
/** Sign out on this device: the session, the memory store and every device copy go. */
export const signOut = async () => { auth?.signOut(); clearReadCache(); await purgeToday(); };
export const useSession = () => useSyncExternalStore((f) => { subs.add(f); return () => { subs.delete(f); }; }, take, take);
