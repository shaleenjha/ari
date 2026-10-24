// B+ shell (Owner's lock, Oct 24 2026). Two places, Stack and Desk, switched by the bottom pill or a sideways swipe.
// Sheets (Accounts, Report) open from the header; the account page opens from the avatar. Demo data only.
import { useCallback, useMemo, useReducer, useRef, useState, type PointerEvent } from 'react';
import { REP } from './demo';
import { StoreContext, initialState, reducer } from './store';
import { back, go, swap, useRoute, type Route } from './route';
import { useTheme } from './theme';
import { Avatar, Icon, Toast } from './ui';
import { Stack } from './screens/Stack';
import { PassOpen } from './screens/PassOpen';
import { Desk } from './screens/Desk';
import { MotionDetail } from './screens/MotionDetail';
import { AccountsSheet, ReportSheet } from './screens/Sheets';
import { AccountPage } from './screens/AccountPage';
import { SignIn } from './screens/SignIn';
import { NoteContext } from './notify';

interface Note { text: string; undo: boolean; n: number }

export function App() {
  useTheme();
  const r = useRoute();
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const store = useMemo(() => ({ state, dispatch }), [state]);
  const [note, setNote] = useState<Note | null>(null);
  const notify = useCallback((text: string, undo = false) => setNote((n) => ({ text, undo, n: (n?.n ?? 0) + 1 })), []);
  const clear = useCallback(() => setNote(null), []);
  const undo = useCallback(() => { dispatch({ type: 'undo' }); setNote(null); }, []);

  if (r.place === 'signin') return <SignIn onContinue={() => go('#/stack')} />;

  return (
    <StoreContext.Provider value={store}>
      <NoteContext.Provider value={notify}>
        <div className="app" data-place={r.place}>
          {r.place === 'stack' || r.place === 'desk' ? <Places r={r} /> : null}
          {r.place === 'motion' && <MotionDetail id={r.id} />}
          {r.place === 'account' && <AccountPage />}
          {note && <Toast key={note.n} text={note.text} onUndo={note.undo ? undo : undefined} onDone={clear} />}
        </div>
      </NoteContext.Provider>
    </StoreContext.Provider>
  );
}

const SWIPE_MIN = 64;

function Places({ r }: { r: Route }) {
  const base = r.place === 'desk' ? '#/desk' : '#/stack';
  const start = useRef<{ x: number; y: number } | null>(null);
  const passOpen = r.place === 'stack' && r.pass;
  // Sideways swipe switches places. Skipped while a pass is open and when it starts in a text field.
  const down = (e: PointerEvent) => {
    const el = e.target as HTMLElement;
    start.current = passOpen || el.closest('input, textarea, dialog') ? null : { x: e.clientX, y: e.clientY };
  };
  const up = (e: PointerEvent) => {
    const s = start.current; start.current = null;
    if (!s) return;
    const dx = e.clientX - s.x; const dy = e.clientY - s.y;
    if (Math.abs(dx) < SWIPE_MIN || Math.abs(dx) < Math.abs(dy) * 2) return;
    if (dx < 0 && r.place === 'stack') swap('#/desk');
    if (dx > 0 && r.place === 'desk') swap('#/stack');
  };
  return (
    <>
      <a className="skip" href="#main" onClick={(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to content</a>
      {!passOpen && <Header base={base} />}
      <main className="place" id="main" tabIndex={-1} onPointerDown={down} onPointerUp={up} onPointerCancel={() => { start.current = null; }}>
        {r.place === 'stack' && (r.pass ? <PassOpen kind={r.pass} /> : <Stack />)}
        {r.place === 'desk' && <Desk />}
      </main>
      {!passOpen && (
        <nav className="pill" aria-label="Places">
          <button type="button" aria-current={r.place === 'stack' ? 'page' : undefined} onClick={() => swap('#/stack')}><Icon name="cards" />Stack</button>
          <button type="button" aria-current={r.place === 'desk' ? 'page' : undefined} onClick={() => swap('#/desk')}><Icon name="layout-dashboard" />Desk</button>
        </nav>
      )}
      {r.sheet === 'accounts' && <AccountsSheet onClose={() => back(base)} />}
      {r.sheet === 'report' && <ReportSheet onClose={() => back(base)} />}
    </>
  );
}

function Header({ base }: { base: string }) {
  return (
    <header className="top">
      <span className="wm" translate="no">ari</span>
      <span className="top-actions">
        <button type="button" className="icon-btn" aria-label="Accounts" onClick={() => go(`${base}?sheet=accounts`)}><Icon name="building" /></button>
        <button type="button" className="icon-btn" aria-label="Report" onClick={() => go(`${base}?sheet=report`)}><Icon name="chart-bar" /></button>
        <button type="button" className="icon-btn av-btn" aria-label="Your account" onClick={() => go('#/account')}><Avatar name={REP.name} size="s" /></button>
      </span>
    </header>
  );
}
