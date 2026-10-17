import { useRef, type MouseEvent } from 'react';
import { useRoute } from './ui/route';
import { scrollScreenToTop } from './ui/scrollTop';
import { Today } from './screens/Today';
import { Today15 } from './screens/Today15';
import { Replies } from './screens/Replies';
import { AccountRoom } from './screens/AccountRoom';
import { Report } from './screens/Report';

const TABS = [
  { href: '#/', label: 'Today', key: 'today' },
  { href: '#/replies', label: 'Replies', key: 'replies' },
  { href: '#/report', label: 'Report', key: 'report' },
] as const;

export function App() {
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
    <div className="shell">
      <main className="screen" data-screen={r.name} ref={screen}>
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
    </div>
  );
}
