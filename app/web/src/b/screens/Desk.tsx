// Desk: suggested motions, what is running, Ask Ari (splits text into tasks, demo only) and Ari suggests.
import { useId, useState, type FormEvent } from 'react';
import { DEMO_SUGGESTIONS, type Motion } from '../demo';
import { go } from '../route';
import { useStore } from '../store';
import { splitTasks } from '../tasks';
import { useNotify } from '../notify';
import { Avatar, Chip, Icon } from '../ui';

export function Desk() {
  const { state } = useStore();
  const suggested = state.motions.filter((m) => m.state === 'suggested' && !state.hidden.includes(m.id));
  const running = state.motions.filter((m) => m.state === 'running');
  const tips = DEMO_SUGGESTIONS.filter((s) => !state.hidden.includes(s.id));
  return (
    <section className="desk" aria-labelledby="desk-h">
      <h1 id="desk-h" className="place-title">Desk</h1>

      <h2 className="group-title">Suggested motions</h2>
      {suggested.length === 0 ? <p className="quiet-line">No new motions. Ari looks again tomorrow morning.</p>
        : suggested.map((m) => <MotionCard key={m.id} m={m} />)}

      <h2 className="group-title">Running</h2>
      <ul className="list" data-testid="running">
        {state.research.map((r) => (
          <li key={r.id} className="row">
            <span className="row-main">
              <span className="row-label">Research, {r.account}</span>
              <span className="row-hint">{r.done} of {r.total} people</span>
              <Progress value={r.done} max={r.total} label={`Research, ${r.account}`} />
            </span>
          </li>
        ))}
        {running.map((m) => (
          <li key={m.id}>
            <button type="button" className="row row-btn" onClick={() => go(`#/motion/${m.id}`)}>
              <span className="row-main">
                <span className="row-label">Motion, {m.account}</span>
                <span className="row-hint">Day {m.day} of 14</span>
                <Progress value={m.day} max={14} label={`Motion, ${m.account}`} />
              </span>
              <Icon name="chevron-right" />
            </button>
          </li>
        ))}
        {state.tasks.map((t, i) => (
          <li key={`${t}-${i}`} className="row">
            <span className="row-main"><span className="row-label">{t}</span><span className="row-hint">Queued</span></span>
          </li>
        ))}
      </ul>

      <AskAri />

      <h2 className="group-title">Ari suggests</h2>
      {tips.length === 0 ? <p className="quiet-line">Nothing else right now.</p> : (
        <ul className="list">
          {tips.map((s) => <Tip key={s.id} id={s.id} text={s.text} done={s.done} />)}
        </ul>
      )}
    </section>
  );
}

function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  return <span className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}><span style={{ transform: `scaleX(${value / max})` }} /></span>;
}

function MotionCard({ m }: { m: Motion }) {
  const { dispatch } = useStore();
  const notify = useNotify();
  const first = m.plan[0]!; const last = m.plan.at(-1)!;
  return (
    <article className="card motion-card" aria-labelledby={`mc-${m.id}`} data-testid={`motion-${m.id}`}>
      <button type="button" className="motion-head" onClick={() => go(`#/motion/${m.id}`)}>
        <span className="row-main"><span className="motion-acct" id={`mc-${m.id}`}>{m.account}</span><span className="row-hint">Why now: {m.whyNow}</span></span>
        <Icon name="chevron-right" />
      </button>
      <ul className="faces" aria-label="4 people">
        {m.people.map(({ person }) => (
          <li key={person.id}><Avatar name={person.name} size="s" /><span className="face-text"><span className="face-name">{person.name}</span><span className="face-role">{person.role}</span></span></li>
        ))}
      </ul>
      <p className="plan-line"><Icon name="calendar" size={18} />14 day plan: day {first.day} {first.what.toLowerCase()}, day {last.day} {last.what.toLowerCase()}.</p>
      <div className="card-actions">
        <button type="button" className="btn" onClick={() => { dispatch({ type: 'motion', id: m.id, to: 'running' }); notify(`Motion started for ${m.account}. Day 1 shows up in your stack.`); }}>
          <Icon name="player-play" />Start motion
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => { dispatch({ type: 'hide', id: m.id }); notify(`${m.account} hidden for now.`); }}>Not now</button>
      </div>
    </article>
  );
}

function AskAri() {
  const { dispatch } = useStore();
  const notify = useNotify();
  const id = useId();
  const [text, setText] = useState('');
  const [last, setLast] = useState<string[]>([]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const tasks = splitTasks(text);
    if (tasks.length === 0) return;
    dispatch({ type: 'tasks', tasks });
    setLast(tasks); setText('');
    notify(`${tasks.length} ${tasks.length === 1 ? 'task' : 'tasks'} added to Running.`);
  };
  return (
    <form className="card ask-ari" onSubmit={submit} data-testid="ask-ari">
      <label htmlFor={id} className="group-title as-label">Ask Ari</label>
      <textarea id={id} name="ask" rows={3} value={text} onChange={(e) => setText(e.target.value)} autoComplete="off"
        placeholder="Research Kelvarrow Labs and then draft DM2 for Daniel…" />
      <div className="card-actions">
        <button type="submit" className="btn" disabled={!text.trim()} aria-disabled={!text.trim()}><Icon name="list-check" />Split into tasks</button>
      </div>
      {last.length > 0 && (
        <ol className="task-list" aria-label="Tasks Ari made" data-testid="tasks">
          {last.map((t, i) => <li key={`${t}-${i}`}><Chip tone="ready">{`Task ${i + 1}`}</Chip><span>{t}</span></li>)}
        </ol>
      )}
    </form>
  );
}

function Tip({ id, text, done }: { id: string; text: string; done: string }) {
  const { dispatch } = useStore();
  const notify = useNotify();
  return (
    <li className="row tip">
      <Icon name="bulb" />
      <span className="row-main"><span className="row-label">{text}</span>
        <span className="tip-btns">
          <button type="button" className="btn btn-s" onClick={() => { dispatch({ type: 'hide', id }); notify(done); }}>Do it</button>
          <button type="button" className="btn btn-s btn-ghost" onClick={() => dispatch({ type: 'hide', id })}>Not now</button>
        </span>
      </span>
    </li>
  );
}
