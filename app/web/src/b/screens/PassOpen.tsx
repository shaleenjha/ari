// An open pass: the person, the draft, "Copy and open LinkedIn", then "Sent it?" Yes / Not yet. Yes plays the done burst,
// the pass flies away, and the Stack shows a toast with Undo. Ari never sends anything; the rep sends on LinkedIn.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { KINDS, KIND_META, type Kind } from '../demo';
import { back } from '../route';
import { useStore } from '../store';
import { reducedMotion } from '../theme';
import { useNotify } from '../notify';
import { Avatar, Chip, Icon } from '../ui';

/** The done moment, the one motion allowed past 300 ms (tokens: --dur-done). */
const DONE_MS = 720;
const BURST = 10;

export const profileUrl = (name: string) => `https://www.linkedin.com/in/demo-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`;
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const clock = (d: Date) => timeFmt.format(d);

export function PassOpen({ kind: raw }: { kind: string }) {
  const { state, dispatch } = useStore();
  const notify = useNotify();
  const kind = (KINDS as readonly string[]).includes(raw) ? (raw as Kind) : null;
  const items = kind ? state.passes[kind] : [];
  const [phase, setPhase] = useState<'idle' | 'ask' | 'done'>('idle');
  const [copiedAt, setCopiedAt] = useState('');
  const head = useRef<HTMLHeadingElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { head.current?.focus(); }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') back('#/stack'); };
    addEventListener('keydown', esc);
    return () => { removeEventListener('keydown', esc); if (timer.current) clearTimeout(timer.current); };
  }, []);

  if (!kind || items.length === 0) {
    return (
      <section className="pass-open empty-pass" aria-labelledby="pass-h">
        <h1 id="pass-h" ref={head} tabIndex={-1}>This pass is clear</h1>
        <button type="button" className="btn" onClick={() => back('#/stack')}>Back to the stack</button>
      </section>
    );
  }
  const m = KIND_META[kind];
  const it = items[0]!;
  const close = () => back('#/stack');

  const open = async () => {
    if (it.draft) { try { await navigator.clipboard.writeText(it.draft); } catch { /* copy can fail outside a secure page; LinkedIn still opens */ } }
    window.open(profileUrl(it.person.name), '_blank', 'noopener,noreferrer');
    setCopiedAt(clock(new Date()));
    setPhase('ask');
  };
  const yes = () => {
    setPhase('done');
    timer.current = setTimeout(() => {
      dispatch({ type: 'sent', kind });
      notify(`${m.label} to ${it.person.first} marked sent. ${it.next}`, true);
      back('#/stack');
    }, reducedMotion() ? 0 : DONE_MS);
  };

  if (kind === 'waiting') {
    return (
      <section className="pass-open" aria-labelledby="pass-h" data-testid="pass-open">
        <PassHead chip={<Chip tone={m.tone} icon={m.icon}>{m.label}</Chip>} count={items.length} head={head} title="Waiting on them" onClose={close} />
        <p className="pass-note">Nothing to send here. Ari moves each person back into your stack when it is time.</p>
        <ul className="wait-list">
          {items.map((w) => (
            <li key={w.id} className="wait-row">
              <Avatar name={w.person.name} size="s" />
              <span className="row-main"><span className="row-label">{w.person.name}</span><span className="row-hint">{w.context}</span></span>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return (
    <section className={`pass-open${phase === 'done' ? ' fly' : ''}`} aria-labelledby="pass-h" data-testid="pass-open">
      <PassHead chip={<Chip tone={m.tone} icon={m.icon}>{m.label}</Chip>} count={items.length} head={head} title={it.person.name} onClose={close} />
      <div className="who">
        <Avatar name={it.person.name} size="l" />
        <span className="who-text"><span className="who-role">{it.person.role}</span><span className="who-co">{it.person.company}</span></span>
      </div>
      <p className="pass-note">{it.context}</p>
      {it.draft ? (
        <figure className="draft">
          <figcaption>{m.draftLabel}</figcaption>
          <p data-testid="draft">{it.draft}</p>
        </figure>
      ) : (
        <p className="draft draft-none">No note. The request goes out on its own.</p>
      )}
      {items.length > 1 && <p className="pass-next">Next in this pass: {items.slice(1, 3).map((x) => x.person.name).join(', ')}{items.length > 3 ? `, and ${items.length - 3} more` : ''}</p>}
      <div className="pass-actions">
        {phase === 'idle' && (
          <button type="button" className="btn btn-pass" data-testid="copy-open" onClick={open}>
            <Icon name={it.draft ? 'copy' : 'brand-linkedin'} />{it.draft ? 'Copy and open LinkedIn' : 'Open LinkedIn'}
          </button>
        )}
        {phase !== 'idle' && (
          <div className="ask" role="group" aria-labelledby="ask-h" data-testid="sent-it">
            <h2 id="ask-h">Sent it?</h2>
            <p className="ask-sub">{m.label} to {it.person.first}{it.draft ? `, copied at ${copiedAt}` : `, opened at ${copiedAt}`}.</p>
            <div className="ask-btns">
              <button type="button" className="btn btn-pass" onClick={yes} disabled={phase === 'done'} aria-disabled={phase === 'done'}><Icon name="check" />Yes, sent</button>
              <button type="button" className="btn btn-pass-ghost" onClick={() => setPhase('idle')} disabled={phase === 'done'} aria-disabled={phase === 'done'}>Not yet</button>
            </div>
          </div>
        )}
      </div>
      {phase === 'done' && (
        <span className="burst" aria-hidden="true" data-testid="burst">
          {Array.from({ length: BURST }, (_, i) => <span key={i} style={{ ['--a' as string]: `${(360 / BURST) * i}deg` }} />)}
        </span>
      )}
    </section>
  );
}

function PassHead({ chip, count, title, head, onClose }: { chip: ReactNode; count: number; title: string; head: RefObject<HTMLHeadingElement | null>; onClose: () => void }) {
  return (
    <header className="pass-head">
      <span className="pass-chip">{chip}<span className="strip-count">{count}</span></span>
      <button type="button" className="icon-btn on-pass" aria-label="Close pass" onClick={onClose}><Icon name="chevron-down" /></button>
      <h1 id="pass-h" className="pass-title" ref={head} tabIndex={-1}>{title}</h1>
    </header>
  );
}
