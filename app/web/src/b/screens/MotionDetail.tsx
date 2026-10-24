// Motion detail: why now, the people, the 14 day plan, pacing rules, and start or close the motion.
import { useEffect, useRef, useState } from 'react';
import { back } from '../route';
import { useStore } from '../store';
import { useNotify } from '../notify';
import { Avatar, Chip, Icon } from '../ui';

export function MotionDetail({ id }: { id: string }) {
  const { state, dispatch } = useStore();
  const notify = useNotify();
  const m = state.motions.find((x) => x.id === id);
  const [confirm, setConfirm] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, []);
  const leave = () => back('#/desk');

  return (
    <main className="sub" id="main" data-testid="motion-detail">
      <header className="sub-top">
        <button type="button" className="back-btn" onClick={leave}><Icon name="chevron-left" />Desk</button>
      </header>
      {!m ? <h1 className="place-title" ref={head} tabIndex={-1}>This motion is gone</h1> : (
        <>
          <h1 className="place-title" ref={head} tabIndex={-1}>{m.account}</h1>
          <p className="sub-state">
            {m.state === 'running' && <Chip tone="ready" icon="player-play">{`Running, day ${m.day} of 14`}</Chip>}
            {m.state === 'suggested' && <Chip tone="due" icon="bulb">Suggested</Chip>}
            {m.state === 'closed' && <Chip tone="quiet" icon="player-stop">Closed</Chip>}
          </p>

          <h2 className="group-title">Why now</h2>
          <p className="card prose">{m.whyNow}</p>

          <h2 className="group-title">People</h2>
          <ul className="list">
            {m.people.map(({ person, step }) => (
              <li key={person.id} className="row">
                <Avatar name={person.name} size="s" />
                <span className="row-main"><span className="row-label">{person.name}</span><span className="row-hint">{person.role}</span></span>
                <span className="step">{step}</span>
              </li>
            ))}
          </ul>

          <h2 className="group-title">14 day plan</h2>
          <ol className="list plan">
            {m.plan.map((s) => {
              const now = m.state === 'running' && s.day <= m.day && (m.plan.find((x) => x.day > s.day)?.day ?? 15) > m.day;
              return (
                <li key={s.day} className={`row${now ? ' now' : ''}`} aria-current={now ? 'step' : undefined}>
                  <span className="day">Day {s.day}</span>
                  <span className="row-main"><span className="row-label">{s.what}</span>{now && <span className="row-hint">Today</span>}</span>
                </li>
              );
            })}
          </ol>

          <h2 className="group-title">Pacing rules</h2>
          <ul className="list">
            {m.pacing.map((p) => <li key={p} className="row"><Icon name="clock" /><span className="row-main"><span className="row-label">{p}</span></span></li>)}
          </ul>

          <div className="sub-actions">
            {m.state === 'suggested' && (
              <button type="button" className="btn" onClick={() => { dispatch({ type: 'motion', id: m.id, to: 'running' }); notify(`Motion started for ${m.account}.`); }}>
                <Icon name="player-play" />Start motion
              </button>
            )}
            {m.state === 'running' && !confirm && (
              <button type="button" className="btn btn-ghost danger" onClick={() => setConfirm(true)}><Icon name="player-stop" />Close motion</button>
            )}
            {m.state === 'running' && confirm && (
              <div className="confirm" role="group" aria-labelledby="close-h">
                <p id="close-h">Close this motion? Ari stops every step and withdraws open invites. You can start it again later.</p>
                <div className="card-actions">
                  <button type="button" className="btn danger-fill" onClick={() => { dispatch({ type: 'motion', id: m.id, to: 'closed' }); setConfirm(false); notify(`Motion closed for ${m.account}.`); }}>Close motion</button>
                  <button type="button" className="btn btn-ghost" onClick={() => setConfirm(false)}>Keep it running</button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </main>
  );
}
