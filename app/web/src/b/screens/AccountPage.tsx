// Account page (from the avatar): profile, connected Gmail, notifications, outreach rules, security, your data, about.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { REP } from '../demo';
import { back, go } from '../route';
import { RULE_LIMITS, useStore, type Settings } from '../store';
import { useNotify } from '../notify';
import { Avatar, Chip, Icon, Stepper, Switch, type IconName } from '../ui';

function Group({ title, icon, children }: { title: string; icon: IconName; children: ReactNode }) {
  return (
    <section className="grp" aria-label={title}>
      <h2 className="group-title"><Icon name={icon} size={18} />{title}</h2>
      <div className="list">{children}</div>
    </section>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return <div className="row"><span className="row-main"><span className="row-label">{label}</span></span><span className="row-value">{value}</span></div>;
}

/** An action that needs a second tap (sign out everywhere, disconnect, delete). */
function Confirmed({ label, ask, yes, icon, onYes, danger }: { label: string; ask: string; yes: string; icon: IconName; onYes: () => void; danger?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!open) return <button type="button" className={`row row-btn${danger ? ' danger' : ''}`} onClick={() => setOpen(true)}><Icon name={icon} /><span className="row-main"><span className="row-label">{label}</span></span></button>;
  return (
    <div className="row confirm" role="group" aria-label={label}>
      <span className="row-main"><span className="row-label">{ask}</span>
        <span className="tip-btns">
          <button type="button" className={`btn btn-s${danger ? ' danger-fill' : ''}`} onClick={() => { setOpen(false); onYes(); }}>{yes}</button>
          <button type="button" className="btn btn-s btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
        </span>
      </span>
    </div>
  );
}

const NOTIFY: { key: keyof Settings['notify']; label: string; hint?: string }[] = [
  { key: 'accepts', label: 'Accepts' }, { key: 'replies', label: 'Replies' }, { key: 'dmReady', label: 'DM ready' },
  { key: 'digest', label: 'Daily digest', hint: 'Each morning at the start of your hours' },
  { key: 'needsLook', label: 'Ari needs a look', hint: 'When a draft or a person needs your call' },
  { key: 'quiet', label: 'Quiet hours', hint: 'Nothing outside your hours' },
];
const RULES: { key: keyof Settings['rules']; label: string; unit: string }[] = [
  { key: 'dailyConnects', label: 'Daily connects', unit: 'a day' },
  { key: 'withdrawDays', label: 'Withdraw invites after', unit: 'days' },
  { key: 'dm2Days', label: 'DM2 after', unit: 'days' },
  { key: 'dm3Days', label: 'DM3 after', unit: 'days' },
];
const ABOUT: { title: string; icon: IconName; body: string }[] = [
  { title: 'About', icon: 'info-circle', body: 'Ari prepares your LinkedIn outreach each day. You send every message yourself. Version 2, demo.' },
  { title: 'Privacy', icon: 'lock', body: 'Ari reads only LinkedIn notification emails in your Gmail. It never posts, sends or signs in to LinkedIn for you.' },
  { title: 'Terms', icon: 'file-text', body: 'You stay in charge of what you send. Ari suggests drafts and timing only.' },
  { title: 'Support', icon: 'lifebuoy', body: 'Write to the team from the email you signed in with and you hear back within one working day.' },
];

export function AccountPage() {
  const { state, dispatch } = useStore();
  const notify = useNotify();
  const s = state.settings;
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, []);
  const connected = s.gmail === 'connected';
  return (
    <main className="sub" id="main" data-testid="account-page">
      <header className="sub-top"><button type="button" className="back-btn" onClick={() => back('#/stack')}><Icon name="chevron-left" />Back</button></header>
      <h1 className="place-title" ref={head} tabIndex={-1}>Your account</h1>

      <Group title="Profile" icon="user">
        <div className="row"><Avatar name={REP.name} size="l" /><span className="row-main"><span className="row-label">{REP.name}</span><span className="row-hint">Photo</span></span>
          <button type="button" className="btn btn-s btn-ghost" onClick={() => notify('Photo change is not in the demo yet.')}>Change photo</button></div>
        <Value label="Role" value={REP.role} />
        <Value label="Your hours" value={REP.hours} />
        <Value label="Time zone" value="Set from this phone" />
      </Group>

      <Group title="Connected" icon="mail">
        <div className="row"><Icon name="mail" /><span className="row-main"><span className="row-label">Gmail</span><span className="row-hint">Reads LinkedIn notification emails only</span></span>
          {connected ? <Chip tone="ready" icon="check">Connected</Chip> : <Chip tone="needs" icon="alert-circle">Not connected</Chip>}</div>
        {connected ? (
          <>
            <button type="button" className="row row-btn" onClick={() => notify('Gmail reconnected.')}><Icon name="refresh" /><span className="row-main"><span className="row-label">Reconnect</span></span></button>
            <Confirmed label="Disconnect" icon="x" danger ask="Disconnect Gmail? Ari stops seeing accepts and replies." yes="Disconnect" onYes={() => { dispatch({ type: 'gmail', to: 'off' }); notify('Gmail disconnected.'); }} />
          </>
        ) : (
          <button type="button" className="row row-btn" onClick={() => { dispatch({ type: 'gmail', to: 'connected' }); notify('Gmail connected.'); }}><Icon name="mail" /><span className="row-main"><span className="row-label">Connect Gmail</span></span></button>
        )}
      </Group>

      <Group title="Notifications" icon="bell">
        {NOTIFY.map((n) => <Switch key={n.key} label={n.label} hint={n.hint} on={s.notify[n.key]} onChange={() => dispatch({ type: 'notify', key: n.key })} />)}
      </Group>

      <Group title="Outreach rules" icon="list-check">
        {RULES.map((r) => <Stepper key={r.key} label={r.label} unit={r.unit} value={s.rules[r.key]} min={RULE_LIMITS[r.key][0]} max={RULE_LIMITS[r.key][1]} onStep={(by) => dispatch({ type: 'rule', key: r.key, by })} />)}
        <Value label="Connect note" value="None" />
      </Group>

      <Group title="Security" icon="shield-lock">
        <Switch label="Two step verification" on={s.twoStep} onChange={() => dispatch({ type: 'twoStep' })} />
        <div className="row"><Icon name="device-mobile" /><span className="row-main"><span className="row-label">Devices</span><span className="row-hint">This phone and 1 laptop</span></span></div>
        <Confirmed label="Sign out everywhere" icon="logout" ask="Sign out on every device?" yes="Sign out" onYes={() => go('#/signin')} />
      </Group>

      <Group title="Your data" icon="download">
        <button type="button" className="row row-btn" onClick={() => notify('Export started. Ari emails you the file.')}><Icon name="download" /><span className="row-main"><span className="row-label">Export my data</span></span></button>
        <Confirmed label="Delete my account" icon="trash" danger ask="Delete your account and every draft? This cannot be undone." yes="Delete" onYes={() => notify('Delete is not in the demo.')} />
      </Group>

      <section className="grp" aria-label="About Ari">
        <div className="list">
          {ABOUT.map((a) => (
            <details key={a.title} className="row-details">
              <summary className="row row-btn"><Icon name={a.icon} /><span className="row-main"><span className="row-label">{a.title}</span></span><Icon name="chevron-down" /></summary>
              <p className="prose">{a.body}</p>
            </details>
          ))}
        </div>
      </section>
      <footer className="foot">Built by Owner</footer>
    </main>
  );
}
