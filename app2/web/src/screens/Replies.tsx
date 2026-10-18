import { useEffect, useRef, useState } from 'react';
import { data } from '../data/client';
import type { Reply } from '../data/types';
import { tick } from '../ui/haptics';
import { copyText, inboxLink, openLink, platformOf } from '../ui/linkedin';
import { UNDO_MS, notNow, useNotNow } from '../ui/notNow';
import { useAsync } from '../ui/useAsync';
import { Stale } from '../ui/Stale';
import { useReadOnly, writeProps } from '../ui/readOnly';
import { readHints, saveHints } from '../ui/layoutHints';
import { Busy, SkelReply } from '../ui/Skeleton';
import { Icon } from '../ui/Icon';

// Ari prepares the answer, Owner sends it. "Copy and open LinkedIn" copies the text and opens the LinkedIn inbox;
// nothing is ever sent from here.
function ReplyDraft({ reply, onHide }: { reply: Reply; onHide: () => void }) {
  const d = useAsync(() => (reply.personId ? data().draft(reply.personId, 'reply') : Promise.resolve(null)), [reply.id]);
  const [text, setText] = useState('');
  const typed = useRef(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const [msg, setMsg] = useState('');
  // Once Owner types, a draft that lands later never replaces his text.
  useEffect(() => { if (d.data && !typed.current) setText(d.data.body); }, [d.data]);
  const loading = d.loading && d.data === undefined;
  const copyOpen = async () => {
    if (!(await copyText(text))) {
      box.current?.focus(); box.current?.select();
      setMsg('Copy failed. Text selected.');
      return;
    }
    tick(8);
    setMsg('Copied. Opening LinkedIn.');
    openLink(inboxLink(platformOf(navigator.userAgent, navigator.maxTouchPoints)));
  };
  return (
    <div className="draftbox" data-testid={`draft-${reply.id}`}>
      <label className="draft">
        <span className="sr-only">{loading ? 'Loading draft' : d.data ? 'Draft' : 'No draft'}</span>
        <textarea ref={box} value={text} rows={6} onChange={(e) => { typed.current = true; setText(e.target.value); }} />
      </label>
      <div className="acts">
        <button className="btn fill key" disabled={loading || !text.trim()} onClick={() => void copyOpen()}>
          <span>Copy and open LinkedIn</span><Icon name="copy" />
        </button>
        <button className="btn text" onClick={onHide}>Hide draft</button>
      </div>
      {msg && <p className="status" role="status">{msg}</p>}
    </div>
  );
}

export function Replies() {
  const r = useAsync(() => data().replies(), [], { key: 'replies' });
  const ro = useReadOnly();
  const aside = useNotNow();
  const [openId, setOpenId] = useState<string | null>(null);
  const [undo, setUndo] = useState<string | null>(null);
  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);
  const all = r.data ?? [];
  const open = all.filter((x) => !aside.has(x.id));
  const setAside = all.filter((x) => aside.has(x.id));
  useEffect(() => { if (r.data) saveHints('replies', { open: open.length }); }, [r.data, open.length]);
  const later = (id: string) => { notNow.add(id); if (openId === id) setOpenId(null); setUndo(id); tick(8); };
  const back = (id: string) => { notNow.remove(id); setUndo(null); tick(8); };
  return (
    <section aria-labelledby="h-rep" aria-busy={!r.data && !r.error}>
      <header className="hd"><h1 id="h-rep">Replies</h1>{r.data && <p className="count" data-testid="replies-count"><b>{open.length}</b> to sort</p>}</header>
      <Stale at={r.stale} />
      {!r.data && !r.error && (
        <><Busy label="Loading replies." /><ul className="rows" data-testid="skeleton">{Array.from({ length: readHints().replies.open }, (_, i) => <SkelReply key={i} />)}</ul></>
      )}
      {r.error && <p className="muted" role="alert">Could not load replies.</p>}
      {r.data && open.length === 0 && <p className="muted">Nothing to sort.</p>}
      {r.data && <ul className="rows" data-testid="replies">
        {open.map((x, i) => (
          <li key={x.id} className="row col">
            <p className="quote">{x.snippet}</p>
            {openId === x.id ? <ReplyDraft reply={x} onHide={() => setOpenId(null)} /> : (
              <div className="acts">
                <button className={i === 0 && !openId ? 'btn fill' : 'btn'} {...writeProps(ro, () => setOpenId(x.id))}>Draft an answer</button>
                <button className="btn ghost" {...writeProps(ro, () => later(x.id))}>Not now</button>
              </div>
            )}
          </li>
        ))}
      </ul>}
      {setAside.length > 0 && (
        <>
          <h2 className="sub">Not now · {setAside.length}</h2>
          <ul className="rows" data-testid="not-now">
            {setAside.map((x) => (
              <li key={x.id} className="row col">
                <p className="quote muted">{x.snippet}</p>
                <div className="acts"><button className="btn ghost" {...writeProps(ro, () => back(x.id))}>Move back to replies</button></div>
              </li>
            ))}
          </ul>
        </>
      )}
      {undo && aside.has(undo) && (
        <div className="toast" role="status" data-testid="toast">
          <span>Moved to Not now.</span>
          <button className="btn ghost" {...writeProps(ro, () => back(undo))}>Undo</button>
        </div>
      )}
    </section>
  );
}
