import { useRoute } from './ui/route';
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
  const active = r.name === 'today15' || r.name === 'account' ? 'today' : r.name;
  return (
    <div className="shell">
      <main className="screen" data-screen={r.name}>
        {r.name === 'today' && <Today />}
        {r.name === 'today15' && <Today15 />}
        {r.name === 'replies' && <Replies />}
        {r.name === 'report' && <Report />}
        {r.name === 'account' && <AccountRoom id={r.id} />}
      </main>
      <nav className="tabs" aria-label="Main">
        {TABS.map((t) => (
          <a key={t.key} href={t.href} className={active === t.key ? 'on' : ''} aria-current={active === t.key ? 'page' : undefined}>{t.label}</a>
        ))}
      </nav>
    </div>
  );
}
