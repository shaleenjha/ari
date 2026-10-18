// Phase 1 read-only mode. Write controls stay on screen with aria-disabled="true" (never native disabled, so they stay
// focusable and announce why); a tap only shows one quiet toast. In mock mode they work as before.
import { useSyncExternalStore, type MouseEvent } from 'react';

export const READ_ONLY_TOAST = 'Read-only preview. Actions arrive in Phase 2.';
export const TOAST_MS = 2400;

let readOnly = false;
let toastAt = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };

export const setReadOnly = (v: boolean) => { readOnly = v; emit(); };
export const isReadOnly = () => readOnly;
export const useReadOnly = () => useSyncExternalStore(subscribe, isReadOnly, isReadOnly);
export const useReadOnlyToast = () => useSyncExternalStore(subscribe, () => toastAt, () => toastAt);
export const showReadOnlyToast = () => { toastAt = Date.now(); emit(); };
export const hideReadOnlyToast = () => { toastAt = 0; emit(); };

/**
 * Props for a control that writes. Read-only: aria-disabled="true" and a tap that only shows the toast.
 * Otherwise the control's own handler, untouched.
 */
export function writeProps(ro: boolean, onClick: (e: MouseEvent<HTMLButtonElement>) => void) {
  return ro
    ? { 'aria-disabled': true as const, onClick: (e: MouseEvent<HTMLButtonElement>) => { e.preventDefault(); showReadOnlyToast(); } }
    : { onClick };
}
