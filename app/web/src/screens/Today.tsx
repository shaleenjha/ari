import { useEffect, useRef } from 'react';
import { data } from '../data/client';
import type { HygieneFinding, Reply, Task, WhoIsThis } from '../data/types';
import { useNotNow } from '../ui/notNow';
import { oldestStale, useAsync } from '../ui/useAsync';
import { Stale } from '../ui/Stale';
import { readHints, saveHints } from '../ui/layoutHints';
import { Busy, SkelPin, SkelRow, SkelTidy, SkelWho } from '../ui/Skeleton';
import { TidyUp, WhoIsThisCards } from './Cards';
import { Icon } from '../ui/Icon';

/**
 * Today loads everything it shows in one step and swaps the placeholders for the real screen at once, so nothing that is
 * already on screen moves while parts arrive (layout shift check: e2e/cls.spec.ts). The placeholders take the shape of
 * the last loaded Today on this device (ui/layoutHints.ts). Each part (queue, replies, Tidy up, Who is this?) is its own
 * read with its own last good copy: a part that fails keeps what it showed, and only a part that never loaded is empty.
 * Fixed slots (data-slot: today15, upnext, row0) sit at the same y in the placeholders and the loaded screen; the first
 * visit on a device draws only generic rows, since the shape is not known yet (v18.17.2, e2e/cls.spec.ts checks both).
 */
export function Today() {
  const q = useAsync(() => data().queue(), [], { key: 'queue' });
  const r = useAsync(() => data().replies(), [], { key: 'replies' });
  const h = useAsync(() => data().hygiene(), [], { key: 'hygiene' });
  const w = useAsync(() => data().whoIsThis(), [], { key: 'who' });
  const settled = [q, r, h, w].every((x) => x.data !== undefined || x.error !== undefined);
  const d = settled ? { replies: r.data ?? ([] as Reply[]), findings: h.data ?? ([] as HygieneFinding[]), who: w.data ?? ([] as WhoIsThis[]) } : undefined;
  const stale = oldestStale(q.stale, r.stale, h.stale, w.stale);
  const aside = useNotNow();
  const fresh = (d?.replies ?? []).filter((x) => !aside.has(x.id));
  const queue: Task[] | null = q.data ?? null;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!d) return;
    const who = () => [...(body.current?.querySelectorAll<HTMLElement>('[data-testid^="who-"]') ?? [])].map((e) => Math.round(e.getBoundingClientRect().height * 100) / 100);
    const hints = { pin: fresh.length > 0, tidy: d.findings.length > 0, queue: queue?.length ?? 0 };
    // Measure after the web font is in, so a placeholder takes the height the card has once the font has swapped.
    const save = () => saveHints('today', { seen: true, ...hints, who: who() });
    void (document.fonts?.ready ?? Promise.resolve()).then(save, save);
  }, [settled, d?.findings.length, d?.who.length, fresh.length, queue]);
  return (
    <section aria-labelledby="h-today" aria-busy={!d}>
      <header className="hd"><h1 id="h-today">Today</h1><Counts queue={d ? queue : undefined} /></header>
      <Stale at={stale} />
      {d ? (
        <div key="data" ref={body}>
          {fresh.length > 0 && (
            <a className="card pin" href="#/replies" data-testid="reply-pin">
              <Icon name="nav-replies" /><b>{fresh.length} new {fresh.length === 1 ? 'reply' : 'replies'}</b><Icon name="chevron-right" className="chev" />
            </a>
          )}
          <WhoIsThisCards items={d.who} />
          <Today15Link />
          <TidyUp findings={d.findings} />
          <h2 className="sub" data-slot="upnext">Up next · {queue?.length ?? 0}</h2>
          {!queue ? <p className="muted" role="alert">Could not load your queue.</p> : (
            <ul className="rows" data-testid="queue">
              {queue.map((x, i) => (
                <li key={x.id} className="row" data-slot={i === 0 ? 'row0' : undefined}>
                  <a href={x.accountId ? `#/account/${x.accountId}` : '#/'}>
                    <span className="txt"><b>{x.title}</b><span>{x.status === 'ready' ? 'Ready now' : 'Up next'}</span></span>
                    <span className={x.status === 'ready' ? 'side ready' : 'side'}><Icon name={x.status === 'ready' ? 'ready' : 'waiting'} size={16} /></span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : <TodaySkeleton />}
    </section>
  );
}

const Today15Link = () => (
  <a className="card" href="#/today15" data-testid="today15-link" data-slot="today15"><Icon name="send" /><b>Today's 15</b><Icon name="chevron-right" className="chev" /></a>
);

/** Header counts: "9 in queue · 4 ready". While loading the same line box holds a bar, so the header never moves. */
function Counts({ queue }: { queue?: Task[] | null }) {
  if (!queue) return <p className="count" aria-hidden="true"><i className="bar" style={{ width: '9ch' }} /></p>;
  const ready = queue.filter((x) => x.status === 'ready').length;
  return <p className="count" data-testid="today-counts"><b>{queue.length} in queue</b> <i>·</i> {ready} ready</p>;
}

function TodaySkeleton() {
  const h = readHints().today;
  const rows = (n: number, slot: boolean) => Array.from({ length: n }, (_, i) => <SkelRow key={i} slot={slot && i === 0} w={['62%', '48%', '56%', '70%', '52%'][i % 5]} />);
  // First visit: replies, "Who is this?" and Tidy up may or may not land above Up next, so no card or heading is drawn
  // where it could move. Generic rows only; the loaded screen replaces them.
  if (!h.seen) return <div data-testid="skeleton"><Busy label="Loading your queue." /><ul className="rows">{rows(h.queue, false)}</ul></div>;
  return (
    <div data-testid="skeleton">
      <Busy label="Loading your queue." />
      {h.pin && <SkelPin />}
      {h.who.map((px, i) => <SkelWho key={i} px={px} />)}
      <Today15Link />
      {h.tidy && <SkelTidy />}
      <h2 className="sub" data-slot="upnext">Up next · {h.queue}</h2>
      <ul className="rows">{rows(h.queue, true)}</ul>
    </div>
  );
}
