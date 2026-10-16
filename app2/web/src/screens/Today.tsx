import { data } from '../data/client';
import { useAsync } from '../ui/useAsync';

export function Today() {
  const q = useAsync(() => data().queue());
  const r = useAsync(() => data().replies());
  return (
    <section aria-labelledby="h-today">
      <header className="hd"><h1 id="h-today">Today</h1></header>
      {(r.data?.length ?? 0) > 0 && (
        <a className="card pin" href="#/replies" data-testid="reply-pin">
          <b>{r.data!.length} new {r.data!.length === 1 ? 'reply' : 'replies'}</b><span>Answer first</span>
        </a>
      )}
      <a className="card" href="#/today15" data-testid="today15-link"><b>Today's 15</b><span>Who to connect with today</span></a>
      <h2 className="sub">Your queue</h2>
      {q.loading && !q.data ? <p className="muted">Loading your queue…</p> : (
        <ul className="rows" data-testid="queue">
          {q.data!.map((t) => (
            <li key={t.id} className="row">
              <a href={t.accountId ? `#/account/${t.accountId}` : '#/'}><b>{t.title}</b><span>{t.status === 'ready' ? 'Ready now' : 'Up next'}</span></a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
