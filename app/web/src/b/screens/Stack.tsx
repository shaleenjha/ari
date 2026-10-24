// Stack (Home): the greeting, today's workload, and one pass per kind. The front pass (most urgent) rests at the bottom,
// like a wallet; the list is in priority order for screen readers and reversed only visually.
import { KINDS, KIND_META, REP } from '../demo';
import { go } from '../route';
import { useStore, workload } from '../store';
import { Chip, Icon } from '../ui';

export function greeting(hour: number, first: string) {
  const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  return `${part}, ${first}`;
}

export function workLine(count: number, minutes: number) {
  if (count === 0) return 'Nothing left to send today';
  return `${count} ${count === 1 ? 'thing' : 'things'} to send, about ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

export function Stack() {
  const { state } = useStore();
  const { count, minutes } = workload(state.passes);
  const kinds = KINDS.filter((k) => state.passes[k].length > 0);
  const front = kinds.find((k) => k !== 'waiting');
  return (
    <section className="stack-place" aria-labelledby="stack-h">
      <div className="hello">
        <p className="hello-greet">{greeting(new Date().getHours(), REP.first)}</p>
        <h1 id="stack-h" className="hello-line" data-testid="workload">{workLine(count, minutes)}</h1>
      </div>
      {count === 0 && (
        <div className="empty" data-testid="stack-empty">
          <Icon name="check" size={28} />
          <p>New accepts and replies show up here.</p>
        </div>
      )}
      <ol className="stack" aria-label="Passes">
        {kinds.map((k, i) => {
          const m = KIND_META[k];
          const items = state.passes[k];
          const first = items[0]!;
          const isFront = k === front;
          return (
            <li key={k} className={`strip${isFront ? ' front' : ''}${k === 'waiting' ? ' quiet' : ''}`} style={{ zIndex: kinds.length - i }}>
              <button type="button" className="strip-btn" data-testid={`pass-${k}`} onClick={() => go(`#/stack?pass=${k}`)}
                aria-label={`${m.label}, ${items.length} ${items.length === 1 ? 'person' : 'people'}. Next: ${first.person.name}, ${first.person.company}`}>
                <span className="strip-row">
                  <Chip tone={m.tone} icon={m.icon}>{m.label}</Chip>
                  <span className="strip-count">{items.length}</span>
                  <span className="strip-who">{k === 'waiting' ? 'Nothing to send' : first.person.company}</span>
                </span>
                {isFront && (
                  <span className="glance">
                    <span className="glance-name">{first.person.name}</span>
                    <span className="glance-draft">{first.draft || first.context}</span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
