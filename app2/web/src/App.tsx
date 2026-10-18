import { useEffect, useRef, type MouseEvent } from 'react';
import { useRoute } from './ui/route';
import { scrollScreenToTop } from './ui/scrollTop';
import { Today } from './screens/Today';
import { Today15 } from './screens/Today15';
import { Replies } from './screens/Replies';
import { AccountRoom } from './screens/AccountRoom';
import { Report } from './screens/Report';
import { SignIn } from './screens/SignIn';
import { OpenInBrowser } from './screens/OpenInBrowser';
import { READ_ONLY_LINE, READ_ONLY_TOAST, TOAST_MS, hideReadOnlyToast, useReadOnly, useReadOnlyToast } from './ui/readOnly';
import { useSession } from './ui/session';

const TABS = [
  { href: '#/', label: 'Today', key: 'today' },
  { href: '#/replies', label: 'Replies', key: 'replies' },
  { href: '#/report', label: 'Report', key: 'report' },
] as const;

/** The one quiet toast a write control shows in read-only mode. */
function ReadOnlyToast() {
  const at = useReadOnlyToast();
  useEffect(() => {
    if (!at) return;
    const t = setTimeout(hideReadOnlyToast, TOAST_MS);
    return () => clearTimeout(t);
  }, [at]);
  return at ? <div className="toast" role="status" data-testid="ro-toast"><span>{READ_ONLY_TOAST}</span></div> : null;
}

export function App() {
  const s = useSession();
  const ro = useReadOnly();
  // Google refuses sign-in inside an app's link viewer, so send people to their browser first (forced in any mode by ?embed=1).
  if (s.embedded && (!s.live || !s.signedIn)) return <div className="shell"><main className="screen"><OpenInBrowser /></main></div>;
  if (s.live && !s.signedIn) return <div className="shell"><main className="screen"><SignIn error={s.error} misconfigured={s.misconfigured} /></main></div>;
  return <Shell ro={ro} />;
}

function Shell({ ro }: { ro: boolean }) {
  const r = useRoute();
  const screen = useRef<HTMLElement>(null);
  const active = r.name === 'today15' || r.name === 'account' ? 'today' : r.name;
  // The tab for the screen you are on (not a sub screen like Today's 15) scrolls that screen back to the top.
  // Every other tab navigates as a normal link.
  const onTab = (e: MouseEvent<HTMLAnchorElement>, key: string) => {
    if (r.name !== key) return;
    e.preventDefault();
    scrollScreenToTop(screen.current, e.currentTarget);
  };
  return (
    <div className={ro ? 'shell ro' : 'shell'}>
      <a className="skip" href="#main" data-testid="skip-link" onClick={(e) => { e.preventDefault(); screen.current?.focus(); }}>Skip to content</a>
      {ro && (
        <div className="robar">
          <span className="ropill" data-testid="ro-pill">Read-only</span>
          <p className="roline" data-testid="ro-line">{READ_ONLY_LINE}</p>
        </div>
      )}
      <main className="screen" id="main" tabIndex={-1} data-screen={r.name} ref={screen}>
        {r.name === 'today' && <Today />}
        {r.name === 'today15' && <Today15 />}
        {r.name === 'replies' && <Replies />}
        {r.name === 'report' && <Report />}
        {r.name === 'account' && <AccountRoom id={r.id} />}
      </main>
      <nav className="tabs" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.key} href={t.href} className={active === t.key ? 'on' : ''} aria-current={active === t.key ? 'page' : undefined}
            onClick={(e) => onTab(e, t.key)}>{t.label}</a>
        ))}
      </nav>
      {ro && <ReadOnlyToast />}
    </div>
  );
}
