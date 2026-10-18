import { useEffect, useRef } from 'react';
import { data } from '../data/client';
import type { HygieneFinding, Reply, Task, WhoIsThis } from '../data/types';
import { useNotNow } from '../ui/notNow';
import { useAsync } from '../ui/useAsync';
import { Stale } from '../ui/Stale';
import { readHints, saveHints } from '../ui/layoutHints';
import { Busy, SkelPin, SkelRow, SkelTidy, SkelWho } from '../ui/Skeleton';
import { TidyUp, WhoIsThisCards } from './Cards';

type Got<T> = { ok: true; v: T } | { ok: false };
const settle = <T,>(p: Promise<T>): Promise<Got<T>> => p.then((v) => ({ ok: true as const, v }), () => ({ ok: false as const }));

/**
 * Today loads everything it shows in one step and swaps the placeholders for the real screen at once, so nothing that is
 * already on screen moves while parts arrive (layout shift check: e2e/cls.spec.ts). The placeholders take the shape of
 * the last loaded Today on this device (ui/layoutHints.ts).
 */
export function Today() {
  const t = useAsync(async () => {
    const [q, r, h, w] = await Promise.all([settle(data().queue()), settle(data().replies()), settle(data().hygiene()), settle(data().whoIsThis())]);
    return { q, replies: r.ok ? r.v : ([] as Reply[]), findings: h.ok ? h.v : ([] as HygieneFinding[]), who: w.ok ? w.v : ([] as WhoIsThis[]) };
  }, [], { key: 'today', good: (v) => v.q.ok });
  const aside = useNotNow();
  const d = t.data;
  const fresh = (d?.replies ?? []).filter((x) => !aside.has(x.id));
  const queue: Task[] | null = d?.q.ok ? d.q.v : null;
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!d) return;
    const who = [...(body.current?.querySelectorAll<HTMLElement>('[data-testid^="who-"]') ?? [])].map((e) => Math.round(e.getBoundingClientRect().height));
    saveHints('today', { pin: fresh.length > 0, who, tidy: d.findings.length > 0, queue: queue?.length ?? 0 });
  }, [d, fresh.length, queue]);
  return (
    <section aria-labelledby="h-today" aria-busy={!d}>
      <header className="hd"><h1 id="h-today">Today</h1></header>
      <Stale at={t.stale} />
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
