// System back closes an open sheet, never the app (Citrine spec §7). Sheets are modal <dialog>s. Where CloseWatcher
// exists (Chromium: Android Chrome and Brave), the browser already closes a modal dialog on back and predictive back, and
// a history entry of ours would need two backs; so we add nothing. Elsewhere (iOS Safari and the installed iOS PWA) we
// push one same-URL history entry when the sheet opens and close it on popstate. Closing from the UI pops our own entry,
// so the next back goes up one screen as usual. The hash route is unchanged, so no hashchange fires.
// No sheet ships yet (slot 3 brings the draft sheet); this is the plumbing it uses.

export type BackWindow = Pick<Window, 'addEventListener' | 'removeEventListener'> & {
  history: Pick<History, 'pushState' | 'back' | 'state'>;
  CloseWatcher?: unknown;
};

/** True when the browser closes modal dialogs on system back by itself (no history entry needed). */
export const nativeBackClose = (w: Pick<BackWindow, 'CloseWatcher'>): boolean => 'CloseWatcher' in w && w.CloseWatcher !== undefined;

const MARK = 'ari-sheet';

/**
 * Call when a sheet opens. Returns `release(fromUi)`: call it when the sheet closes; `fromUi` true when the close came from
 * the UI (a button, Escape), so our history entry is popped and back is not spent twice. `onBack` runs when system back
 * closes the sheet (iOS only; on Chromium the dialog's own cancel/close event covers it).
 */
export function armSheetBack(w: BackWindow, onBack: () => void): (fromUi: boolean) => void {
  if (nativeBackClose(w)) return () => undefined;
  let armed = true;
  w.history.pushState({ [MARK]: true }, '');
  const onPop = () => {
    if (!armed) return;
    armed = false;
    w.removeEventListener('popstate', onPop);
    onBack();
  };
  w.addEventListener('popstate', onPop);
  return (fromUi) => {
    if (!armed) return;
    armed = false;
    w.removeEventListener('popstate', onPop);
    const st = w.history.state as Record<string, unknown> | null;
    if (fromUi && st && st[MARK]) w.history.back();
  };
}
