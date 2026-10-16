import { useState } from 'react';
import { data, opId } from '../data/client';
import { useAsync } from '../ui/useAsync';

export function Today15() {
  const l = useAsync(() => data().today15());
  const [sent, setSent] = useState<Set<string>>(new Set());
  const mark = async (id: string) => {
    const r = await data().mark(id, 'connect_sent', opId());
    if (r.ok) setSent((s) => new Set(s).add(id));
  };
  return (
    <section aria-labelledby="h-15">
      <header className="hd"><a href="#/" className="back" aria-label="Back">‹</a><h1 id="h-15">Today's 15</h1></header>
      <p className="muted">At most 3 per account. Mark each one once you have sent the invite on LinkedIn.</p>
      <ol className="rows" data-testid="today15">
        {(l.data ?? []).map((p) => (
          <li key={p.id} className="row">
            <div><b>{p.fullName}</b><span>{p.title}</span></div>
            <button className="btn" disabled={sent.has(p.id)} onClick={() => void mark(p.id)}>{sent.has(p.id) ? 'Sent' : 'Mark sent'}</button>
          </li>
        ))}
      </ol>
    </section>
  );
}
