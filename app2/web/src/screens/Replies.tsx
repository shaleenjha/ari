import { data } from '../data/client';
import { useAsync } from '../ui/useAsync';

export function Replies() {
  const r = useAsync(() => data().replies());
  return (
    <section aria-labelledby="h-rep">
      <header className="hd"><h1 id="h-rep">Replies</h1></header>
      {r.data && r.data.length === 0 && <p className="muted">No new replies.</p>}
      <ul className="rows" data-testid="replies">
        {(r.data ?? []).map((x) => (
          <li key={x.id} className="row col">
            <p className="quote">{x.snippet}</p>
            <div className="acts"><button className="btn">Draft an answer</button><button className="btn ghost">Not now</button></div>
          </li>
        ))}
      </ul>
    </section>
  );
}
