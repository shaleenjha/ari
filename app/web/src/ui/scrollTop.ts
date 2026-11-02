// Tapping the bottom tab you are already on takes the screen back to the top (spec 01: tab = tick 4 haptic, press
// scale 0.955, transform only, no motion under reduced motion).
import { tick } from './haptics';

type Styled = { overflowY: string };
type Scrollable = { scrollHeight: number; clientHeight: number; parentElement: unknown };

/**
 * The element that actually scrolls the screen: the nearest of `from` and its ancestors (below body) whose overflow-y
 * lets it scroll and whose content overflows it. Null means the window is the scroller, which it is in app today.
 */
export function scrollRoot<T extends Scrollable>(from: T | null, style: (el: T) => Styled = (el) => getComputedStyle(el as unknown as Element),
  stop: unknown = typeof document !== 'undefined' ? document.body : null): T | null {
  for (let n: T | null = from; n && n !== stop; n = n.parentElement as T | null) {
    const oy = style(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && n.scrollHeight > n.clientHeight) return n;
  }
  return null;
}

/** 'smooth', or 'auto' (an instant jump) when the person asked for reduced motion. */
export const scrollBehavior = (reduced: boolean): ScrollBehavior => (reduced ? 'auto' : 'smooth');

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Scroll the screen to the top and acknowledge the tap even when it is already there: focus moves to the screen
 * heading (screen readers announce it), a tab tick haptic plays, and the tab does one 110 ms press scale unless
 * reduced motion is on.
 */
export function scrollScreenToTop(screen: HTMLElement | null, tab?: HTMLElement): void {
  const reduced = prefersReducedMotion();
  const behavior = scrollBehavior(reduced);
  const root = scrollRoot(screen);
  if (root) root.scrollTo({ top: 0, left: 0, behavior });
  else window.scrollTo({ top: 0, left: 0, behavior });
  const h = screen?.querySelector<HTMLElement>('h1');
  if (h) {
    if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1');
    h.focus({ preventScroll: true });
  }
  tick(4);
  if (!reduced && tab && typeof tab.animate === 'function') {
    tab.animate([{ transform: 'scale(1)' }, { transform: 'scale(0.955)' }, { transform: 'scale(1)' }],
      { duration: 110, easing: 'cubic-bezier(.22,1,.36,1)' });
  }
}
