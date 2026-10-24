// Haptics from spec 01 (navigator.vibrate on web). Kept under reduced motion. Silent where vibrate is missing.
export function tick(pattern: number | number[]): void {
  try { (globalThis.navigator as Navigator | undefined)?.vibrate?.(pattern); } catch { /* no haptics here */ }
}
