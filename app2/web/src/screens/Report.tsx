import type { ReactNode } from 'react';
import { data } from '../data/client';
import type { WeekReport } from '../data/types';
import { useAsync } from '../ui/useAsync';
import { Busy } from '../ui/Skeleton';
import { Stale } from '../ui/Stale';
import { signOut, useSession } from '../ui/session';

type Tile = { key: string; label: string; value?: (d: WeekReport) => ReactNode; lead?: boolean };
const NBSP = '\u00a0';

const TILES: Tile[] = [
  { key: 'meetings', lead: true, label: '', value: (d) => <>{d.meetings}{d.meetingsGoal != null && <small>/{d.meetingsGoal}</small>}</> },
  { key: 'replies', label: 'Replies', value: (d) => d.replies },
  { key: 'accepts', label: 'Accepts', value: (d) => d.accepts },
  { key: 'connects', label: 'Connects', value: (d) => d.connects },
  { key: 'dm1', label: 'Accept to DM1 · goal 4 h', value: (d) => (d.acceptToDm1MedianHours == null ? 'None' : `${d.acceptToDm1MedianHours.toFixed(1)} h`) },
];

const meetingsLabel = (d?: WeekReport) => (d?.meetingsFromAri ? 'Meetings from Ari' : 'Meetings');
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'short' });
/** "This week · 13 to 17 Oct" (Monday to Friday of the current week, on the phone's clock). */
export function weekLabel(now: Date): string {
  const mon = new Date(now); mon.setHours(12, 0, 0, 0); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
  const m = (x: Date) => MONTH.format(x);
  return `This week · ${mon.getDate()}${m(mon) === m(fri) ? '' : ` ${m(mon)}`} to ${fri.getDate()} ${m(fri)}`;
}

/**
 * The week as a description list: each tile is a <dt> label and a <dd> number (the number shows first, as before, via
 * column-reverse). While loading, the same list and the same nodes render with an empty number line of the same height,
 * so no tile moves or grows when the numbers arrive.
 */
export function Report() {
  const w = useAsync(() => data().week(), [], { key: 'report' });
  const d = w.data;
  const live = useSession().live;
  return (
    <section aria-labelledby="h-rep2" aria-busy={!d && !w.error}>
      <header className="hd"><h1 id="h-rep2">Report</h1></header>
      <p className="muted" data-testid="report-window">{weekLabel(new Date())}</p>
      <Stale at={w.stale} />
      {w.error && <p className="muted" role="alert">Could not load this week.</p>}
      {!d && !w.error && <Busy label="Loading this week." />}
      {!w.error && (
        <dl className="grid" data-testid={d ? 'report' : 'skeleton'}>
          {TILES.map((t, i) => (
            <div key={t.key} className={t.lead ? 'stat lead' : 'stat'}>
              <dt><span className="n">{String(i + 1).padStart(2, '0')}</span>{t.key === 'meetings' ? meetingsLabel(d) : t.label}</dt>
              <dd>{d && t.value ? t.value(d) : <i className="bar" style={{ width: '3ch' }}>{NBSP}</i>}</dd>
            </div>
          ))}
        </dl>
      )}
      {live && <button type="button" className="btn text signout" data-testid="sign-out" onClick={() => { void signOut(); }}>Sign out</button>}
    </section>
  );
}
