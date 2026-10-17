import { useEffect, useRef, useState } from 'react';
import { data } from '../data/client';
import type { Reply } from '../data/types';
import { tick } from '../ui/haptics';
import { copyText, inboxLink, openLink, platformOf } from '../ui/linkedin';
import { UNDO_MS, notNow, useNotNow } from '../ui/notNow';
import { useAsync } from '../ui/useAsync';

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
        <span>{loading ? "Loading Ari's draft." : d.data ? "Ari's draft. Edit it if you like, then send it yourself on LinkedIn."
          : 'Ari has no draft for this yet. Write your answer, then send it yourself on LinkedIn.'}</span>
        <textarea ref={box} value={text} rows={6} onChange={(e) => { typed.current = true; setText(e.target.value); }} />
      </label>
      <div className="acts">
        <button className="btn" disabled={loading || !text.trim()} onClick={() => void copyOpen()}>Copy and open LinkedIn</button>
        <button className="btn ghost" onClick={onHide}>Hide draft</button>
      </div>
      {msg && <p className="status" role="status">{msg}</p>}
    </div>
  );
}

export function Replies() {
  const r = useAsync(() => data().replies());
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
  const later = (id: string) => { notNow.add(id); if (openId === id) setOpenId(null); setUndo(id); tick(8); };
  const back = (id: string) => { notNow.remove(id); setUndo(null); tick(8); };
  return (
    <section aria-labelledby="h-rep">
      <header className="hd"><h1 id="h-rep">Replies</h1></header>
      {r.data && open.length === 0 && <p className="muted">No new replies.</p>}
      <ul className="rows" data-testid="replies">
        {open.map((x) => (
          <li key={x.id} className="row col">
            <p className="quote">{x.snippet}</p>
            {openId === x.id ? <ReplyDraft reply={x} onHide={() => setOpenId(null)} /> : (
              <div className="acts">
                <button className="btn" onClick={() => setOpenId(x.id)}>Draft an answer</button>
                <button className="btn ghost" onClick={() => later(x.id)}>Not now</button>
              </div>
            )}
          </li>
        ))}
      </ul>
      {setAside.length > 0 && (
        <>
          <h2 className="sub">Not now</h2>
          <ul className="rows" data-testid="not-now">
            {setAside.map((x) => (
              <li key={x.id} className="row col">
                <p className="quote muted">{x.snippet}</p>
                <div className="acts"><button className="btn ghost" onClick={() => back(x.id)}>Move back to replies</button></div>
              </li>
            ))}
          </ul>
        </>
      )}
      {undo && aside.has(undo) && (
        <div className="toast" role="status" data-testid="toast">
          <span>Moved to Not now.</span>
          <button className="btn ghost" onClick={() => back(undo)}>Undo</button>
        </div>
      )}
    </section>
  );
}
