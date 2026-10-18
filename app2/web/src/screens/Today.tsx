import { useEffect, useRef } from 'react';
import { data } from '../data/client';
import type { HygieneFinding, Reply, Task, WhoIsThis } from '../data/types';
import { useNotNow } from '../ui/notNow';
import { oldestStale, useAsync } from '../ui/useAsync';
import { Stale } from '../ui/Stale';
import { readHints, saveHints } from '../ui/layoutHints';
import { Busy, SkelPin, SkelRow, SkelTidy, SkelWho } from '../ui/Skeleton';
import { TidyUp, WhoIsThisCards } from './Cards';

/**
 * Today loads everything it shows in one step and swaps the placeholders for the real screen at once, so nothing that is
 * already on screen moves while parts arrive (layout shift check: e2e/cls.spec.ts). The placeholders take the shape of
 * the last loaded Today on this device (ui/layoutHints.ts). Each part (queue, replies, Tidy up, Who is this?) is its own
 * read with its own last good copy: a part that fails keeps what it showed, and only a part that never loaded is empty.
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
    const who = [...(body.current?.querySelectorAll<HTMLElement>('[data-testid^="who-"]') ?? [])].map((e) => Math.round(e.getBoundingClientRect().height));
    saveHints('today', { pin: fresh.length > 0, who, tidy: d.findings.length > 0, queue: queue?.length ?? 0 });
  }, [settled, d?.findings.length, d?.who.length, fresh.length, queue]);
  return (
    <section aria-labelledby="h-today" aria-busy={!d}>
      <header className="hd"><h1 id="h-today">Today</h1></header>
      <Stale at={stale} />
      {d ? (
        <div key="data" ref={body}>
          {fresh.length > 0 && (
            <a className="card pin" href="#/replies" data-testid="reply-pin">
              <b>{fresh.length} new {fresh.length === 1 ? 'reply' : 'replies'}</b><span>Answer first</span>
            </a>
          )}
          <WhoIsThisCards items={d.who} />
          <Today15Link />
          <TidyUp findings={d.findings} />
          <h2 className="sub">Your queue</h2>
          {!queue ? <p className="muted" role="alert">Could not load your queue.</p> : (
            <ul className="rows" data-testid="queue">
              {queue.map((x) => (
                <li key={x.id} className="row">
                  <a href={x.accountId ? `#/account/${x.accountId}` : '#/'}><b>{x.title}</b><span>{x.status === 'ready' ? 'Ready now' : 'Up next'}</span></a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : <TodaySkeleton />}
    </section>
  );
}

const Today15Link = () => <a className="card" href="#/today15" data-testid="today15-link"><b>Today's 15</b><span>Who to connect with today</span></a>;

function TodaySkeleton() {
  const h = readHints().today;
  return (
    <div data-testid="skeleton">
      <Busy label="Loading your queue." />
      {h.pin && <SkelPin />}
      {h.who.map((px, i) => <SkelWho key={i} px={px} />)}
      <Today15Link />
      {h.tidy && <SkelTidy />}
      <h2 className="sub">Your queue</h2>
      <ul className="rows">{Array.from({ length: h.queue }, (_, i) => <SkelRow key={i} w={['62%', '48%', '56%', '70%', '52%'][i % 5]} />)}</ul>
    </div>
  );
}
