import { data } from '../data/client';
import { useAsync } from '../ui/useAsync';
import { Stale } from '../ui/Stale';
import { Icon } from '../ui/Icon';

const LABEL = { verified: 'Verified', inference: 'Inference', hypothesis: 'Hypothesis' } as const;

export function AccountRoom({ id }: { id: string }) {
  const a = useAsync(() => data().account(id), [id], { key: 'account' });
  if (a.loading && !a.data) return <p className="muted">Loading…</p>;
  if (!a.data) return <p className="muted">Account not found.</p>;
  const { account, people, brief, tasks, activity } = a.data;
  return (
    <section aria-labelledby="h-acc">
      <header className="hd"><a href="#/" className="back" aria-label="Back"><Icon name="chevron-right" /></a><h1 id="h-acc">{account.name}</h1></header>
      <Stale at={a.stale} />
      <p className="muted">{account.oneLiner}</p>
      {brief && (
        <div className="card col" data-testid="brief">
          <b>Brief</b><p>{brief.thesis}</p>
          <ul className="claims">{brief.whyNow.map((c) => <li key={c.text}><i className={`tag ${c.label}`}>{LABEL[c.label]}</i>{c.text}</li>)}</ul>
        </div>
      )}
      <h2 className="sub">People</h2>
      <ul className="rows">{people.map((p) => <li key={p.id} className="row"><div><b>{p.fullName}</b><span>{p.title}</span></div><em>{p.stage.replace('_', ' ')}</em></li>)}</ul>
      <h2 className="sub">Tasks (everyone)</h2>
      <ul className="rows" data-testid="acc-tasks">{tasks.map((t) => <li key={t.id} className="row"><div><b>{t.title}</b><span>{t.assigneeRole.toUpperCase()} · {t.status}</span></div></li>)}</ul>
      <h2 className="sub">Activity</h2>
      <ul className="rows">{activity.map((x) => <li key={x.id} className="row"><div><b>{x.actorKind === 'ari' ? 'Ari' : x.actorKind.toUpperCase()}</b><span>{x.verb.replace(/_/g, ' ')}</span></div></li>)}</ul>
    </section>
  );
}
