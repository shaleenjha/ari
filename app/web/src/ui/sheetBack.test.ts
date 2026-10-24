import { describe, expect, it } from 'vitest';
import { armSheetBack, nativeBackClose, type BackWindow } from './sheetBack';

function fakeWin(withCloseWatcher: boolean) {
  const stack: unknown[] = [null];
  const listeners = new Set<() => void>();
  const w = {
    history: {
      pushState: (s: unknown) => { stack.push(s); },
      back: () => { stack.pop(); for (const l of [...listeners]) l(); },
      get state() { return stack[stack.length - 1]; },
    },
    addEventListener: (_: string, l: () => void) => { listeners.add(l); },
    removeEventListener: (_: string, l: () => void) => { listeners.delete(l); },
    ...(withCloseWatcher ? { CloseWatcher: class {} } : {}),
  };
  return { w: w as unknown as BackWindow, stack, listeners, systemBack: () => w.history.back() };
}

describe('sheet back (Citrine spec §7)', () => {
  it('Chromium (CloseWatcher): adds no history entry, so back is never spent twice', () => {
    const f = fakeWin(true);
    expect(nativeBackClose(f.w)).toBe(true);
    const release = armSheetBack(f.w, () => { throw new Error('should not run'); });
    expect(f.stack).toHaveLength(1);
    release(true);
    expect(f.stack).toHaveLength(1);
  });
  it('iOS: one entry on open; system back closes the sheet and leaves the screen in place', () => {
    const f = fakeWin(false);
    expect(nativeBackClose(f.w)).toBe(false);
    let closed = 0;
    const release = armSheetBack(f.w, () => { closed++; });
    expect(f.stack).toHaveLength(2);
    f.systemBack();
    expect(closed).toBe(1);
    expect(f.stack).toHaveLength(1);
    release(false); // the sheet's own close handler runs after; nothing more is popped
    expect(f.stack).toHaveLength(1);
    expect(f.listeners.size).toBe(0);
  });
  it('iOS: closing from the UI pops our entry once, without calling onBack', () => {
    const f = fakeWin(false);
    let closed = 0;
    const release = armSheetBack(f.w, () => { closed++; });
    release(true);
    release(true);
    expect(f.stack).toHaveLength(1);
    expect(closed).toBe(0);
    expect(f.listeners.size).toBe(0);
  });
});
