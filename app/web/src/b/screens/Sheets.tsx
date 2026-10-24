// Header sheets: Accounts (search, grouped by company, each person's sequence step) and Report (this week against last).
import { useDeferredValue, useId, useMemo, useState } from 'react';
import { REPORT, accountRows } from '../demo';
import { useStore } from '../store';
import { Avatar, Icon, Sheet } from '../ui';

export function AccountsSheet({ onClose }: { onClose: () => void }) {
  const { state } = useStore();
  const id = useId();
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q.trim().toLowerCase());
  const all = useMemo(() => accountRows(state.passes), [state.passes]);
  const rows = useMemo(() => (dq ? all
    .map((a) => (a.company.toLowerCase().includes(dq) ? a : { ...a, people: a.people.filter((p) => p.person.name.toLowerCase().includes(dq)) }))
    .filter((a) => a.people.length > 0) : all), [all, dq]);
  const people = all.reduce((n, a) => n + a.people.length, 0);
  return (
    <Sheet title="Accounts" onClose={onClose} testId="accounts-sheet">
      <div className="search">
        <Icon name="search" />
        <label htmlFor={id} className="vh">Search accounts and people</label>
        <input id={id} type="search" name="q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search accounts or people…" autoComplete="off" spellCheck={false} />
      </div>
      <p className="quiet-line">{all.length} accounts, {people} people</p>
      {rows.length === 0 && <p className="quiet-line" role="status">No account or person matches “{q.trim()}”.</p>}
      {rows.map((a) => (
        <section key={a.company} className="acct" aria-labelledby={`${id}-${a.company}`}>
          <h3 className="acct-h" id={`${id}-${a.company}`}><Icon name="building" size={18} />{a.company}<span className="acct-n">{a.people.length}</span></h3>
          <ul className="list">
            {a.people.map(({ person, step }) => (
              <li key={person.id} className="row">
                <Avatar name={person.name} size="s" />
                <span className="row-main"><span className="row-label">{person.name}</span><span className="row-hint">{person.role}</span></span>
                <span className="step">{step}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Sheet>
  );
}

const fmt = new Intl.NumberFormat('en-US');
function Delta({ now, before }: { now: number; before: number }) {
  const d = now - before;
  const icon = d > 0 ? 'arrow-up' : d < 0 ? 'arrow-down' : 'equal';
  const text = d > 0 ? `Up ${fmt.format(d)}` : d < 0 ? `Down ${fmt.format(-d)}` : 'Same';
  return <span className="delta"><Icon name={icon} size={16} />{text}</span>;
}

export function ReportSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet title="Report" onClose={onClose} testId="report-sheet">
      <table className="report">
        <caption className="quiet-line">This week against last week</caption>
        <thead><tr><th scope="col">Step</th><th scope="col">This week</th><th scope="col">Last week</th><th scope="col"><span className="vh">Change</span></th></tr></thead>
        <tbody>
          {REPORT.rows.map((r) => (
            <tr key={r.label}><th scope="row">{r.label}</th><td>{fmt.format(r.now)}</td><td>{fmt.format(r.before)}</td><td><Delta now={r.now} before={r.before} /></td></tr>
          ))}
        </tbody>
      </table>
      <h3 className="group-title">DM2 A/B</h3>
      <ul className="list">
        {REPORT.ab.map((a) => (
          <li key={a.arm} className="row">
            <span className="arm" aria-hidden="true">{a.arm}</span>
            <span className="row-main"><span className="row-label">{a.name}</span><span className="row-hint">{a.replies} replies from {a.sent} sent</span></span>
            <span className="rate">{Math.round((a.replies / a.sent) * 100)}%</span>
          </li>
        ))}
      </ul>
      <p className="quiet-line">Version B is ahead. Ari keeps both running until each has 30 sends.</p>
    </Sheet>
  );
}
