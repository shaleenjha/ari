import { useState } from 'react';
import { data, opId } from '../data/client';
import { useAsync } from '../ui/useAsync';
import { Stale } from '../ui/Stale';
import { useReadOnly, writeProps } from '../ui/readOnly';
import { Icon } from '../ui/Icon';

export function Today15() {
  const l = useAsync(() => data().today15(), [], { key: 'today15' });
  const ro = useReadOnly();
  const [sent, setSent] = useState<Set<string>>(new Set());
  const mark = async (id: string) => {
    const r = await data().mark(id, 'connect_sent', opId());
    if (r.ok) setSent((s) => new Set(s).add(id));
  };
  return (
    <section aria-labelledby="h-15">
      <header className="hd"><a href="#/" className="back" aria-label="Back"><Icon name="chevron-right" /></a><h1 id="h-15">Today's 15</h1>
        {l.data && <p className="count" data-testid="today15-count"><b>{sent.size} of {l.data.length}</b> sent</p>}</header>
      <p className="muted">Max 3 per account</p>
      <Stale at={l.stale} />
      {l.error && <p className="muted" role="alert">Could not load Today's 15.</p>}
      <ol className="rows tall" data-testid="today15">
        {(l.data ?? []).map((p) => (
          <li key={p.id} className={sent.has(p.id) ? 'row sent' : 'row'}>
            <div className="txt"><b>{p.fullName}</b><span>{p.title}</span></div>
            {sent.has(p.id)
              ? <span className="sentmark" role="status"><Icon name="check" size={16} />Sent</span>
              : <button className="btn" {...writeProps(ro, () => void mark(p.id))}>Mark sent</button>}
          </li>
        ))}
      </ol>
    </section>
  );
}
