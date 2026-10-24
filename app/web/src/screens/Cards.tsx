// Two cards Ari puts on Today: "Tidy up" (data hygiene findings with one-tap fixes) and "Who is this?" (an accept or reply
// gmail-ingest could not match to one person). People decide; Ari only proposes. Synthetic data only.
import { useState } from 'react';
import { data, opId } from '../data/client';
import type { HygieneAction, HygieneFinding, WhoIsThis } from '../data/types';
import { useReadOnly, writeProps } from '../ui/readOnly';
import { Icon } from '../ui/Icon';

const ACTION_LABEL: Record<HygieneAction, string> = { tick_connect: 'Tick invite sent', link: 'Link', merge: 'Merge', dismiss: 'Not an issue' };

function Finding({ f, onDone }: { f: HygieneFinding; onDone: (msg: string) => void }) {
  const ro = useReadOnly();
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (a: HygieneAction, keep?: string) => {
    setBusy(true);
    const r = await data().resolveHygiene(f.id, a, opId(), keep);
    setBusy(false);
    if (r.ok) onDone(a === 'dismiss' ? 'Dismissed' : a === 'merge' ? `Merged into ${keep === f.entityId ? (f.detail?.split(' · ')[0] ?? 'this one') : f.suggestion?.name}` : 'Fixed');
  };
  return (
    <li className="row col" data-testid={`finding-${f.id}`}>
      <div><b>{f.title}</b>{f.detail && <span>{f.detail}</span>}</div>
      {!confirm ? (
        <div className="acts">
          {f.actions.map((a) => (
            <button key={a} className={a === 'dismiss' ? 'btn ghost' : 'btn'} disabled={busy}
              {...writeProps(ro, () => (a === 'merge' ? setConfirm(true) : void run(a)))}>
              {a === 'link' && f.suggestion ? `Link to ${f.suggestion.name}` : ACTION_LABEL[a]}
            </button>
          ))}
        </div>
      ) : (
        <div className="confirm" role="group" aria-label="Which one stays?">
          <span>Which one stays? People move to it; the other is removed.</span>
          <div className="acts">
            <button className="btn" disabled={busy} onClick={() => void run('merge', f.suggestion!.id)}>Keep {f.suggestion!.name}</button>
            <button className="btn" disabled={busy} onClick={() => void run('merge', f.entityId)}>Keep {f.detail?.split(' · ')[0]}</button>
            <button className="btn ghost" disabled={busy} onClick={() => setConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}
    </li>
  );
}

/** Ari's "Tidy up" checks. Today loads the findings (one step with the rest of the screen) and passes them in. */
export function TidyUp({ findings }: { findings: HygieneFinding[] }) {
  const h = { data: findings };
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState<Record<string, string>>({});
  const left = findings.filter((f) => !done[f.id]);
  if (findings.length === 0) return null;
  return (
    <div className="card col" data-testid="tidy-up">
      <button className="cardhead" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="tidy-up" /><b>Tidy up</b><span data-testid="tidy-count">{left.length === 0 ? '0 to check' : `${left.length} to check`}</span>
        <Icon name="chevron-right" className={open ? 'chev open' : 'chev'} />
      </button>
      {open && (
        <ul className="rows">
          {h.data.map((f) => done[f.id]
            ? <li key={f.id} className="row done" data-testid={`finding-${f.id}`}><span>{done[f.id]}</span></li>
            : <Finding key={f.id} f={f} onDone={(m) => setDone((d) => ({ ...d, [f.id]: m }))} />)}
        </ul>
      )}
    </div>
  );
}

function Who({ w }: { w: WhoIsThis }) {
  const ro = useReadOnly();
  const [res, setRes] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (personId: string | null, label: string) => {
    setBusy(true);
    const r = await data().confirmWho(w.eventId, personId, opId());
    setBusy(false);
    setRes(r.ok ? label : r.conflict ? 'Someone already answered this' : 'Could not save, try again');
  };
  return (
    <div className="card col who" data-testid={`who-${w.eventId}`}>
      <b>Who is this?</b>
      <span>{w.name} {w.kind === 'accept' ? 'accepted your invite' : 'replied'}{w.headline ? ` · ${w.headline}` : ''}</span>
      {res ? <p className="muted" role="status">{res}</p> : (
        <div className="acts col">
          {w.candidates.map((c) => {
            const meta = [c.accountName, c.title].filter(Boolean).join(' · ');
            // Two lines: the name, then company · role. The spoken name keeps the separators the visual lines drop.
            return (
              <button key={c.personId} className="btn ghost opt" disabled={busy} aria-label={[c.fullName, meta].filter(Boolean).join(' · ')}
                {...writeProps(ro, () => void pick(c.personId, `Linked to ${c.fullName}${c.accountName ? ` at ${c.accountName}` : ''}`))}>
                <b>{c.fullName}</b>{meta && <span className="m">{meta}</span>}
              </button>
            );
          })}
          <button className="btn ghost opt" disabled={busy} {...writeProps(ro, () => void pick(null, 'Marked as none of these'))}>None of these</button>
        </div>
      )}
    </div>
  );
}

export function WhoIsThisCards({ items }: { items: WhoIsThis[] }) {
  return <>{items.map((x) => <Who key={x.eventId} w={x} />)}</>;
}
