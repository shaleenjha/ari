import { describe, expect, it } from 'vitest';
import { initialState, reducer, workload } from './store';
import { splitTasks } from './tasks';
import { pickTheme } from './theme';
import { parse } from './route';
import { accountRows, DEMO_PASSES } from './demo';
import { greeting, workLine } from './screens/Stack';

describe('B+ store', () => {
  it('marks the front person sent and Undo puts them back first', () => {
    const s0 = initialState();
    const first = s0.passes.dm1[0]!;
    const s1 = reducer(s0, { type: 'sent', kind: 'dm1' });
    expect(s1.passes.dm1).toHaveLength(s0.passes.dm1.length - 1);
    expect(s1.sent.at(-1)?.item.id).toBe(first.id);
    const s2 = reducer(s1, { type: 'undo' });
    expect(s2.passes.dm1[0]!.id).toBe(first.id);
    expect(s2.sent).toHaveLength(0);
  });
  it('ignores sent on an empty pass and undo with nothing sent', () => {
    let s = initialState();
    for (let i = 0; i < 5; i++) s = reducer(s, { type: 'sent', kind: 'reply' });
    expect(s.passes.reply).toHaveLength(0);
    expect(s.sent).toHaveLength(1);
    expect(reducer(initialState(), { type: 'undo' }).sent).toHaveLength(0);
  });
  it('counts everything but Waiting and rounds minutes up', () => {
    const w = workload(initialState().passes);
    expect(w.count).toBe(13);
    expect(w.minutes).toBe(17);
  });
  it('keeps outreach rules inside their limits', () => {
    let s = initialState();
    for (let i = 0; i < 40; i++) s = reducer(s, { type: 'rule', key: 'dailyConnects', by: 1 });
    expect(s.settings.rules.dailyConnects).toBe(30);
    for (let i = 0; i < 40; i++) s = reducer(s, { type: 'rule', key: 'dailyConnects', by: -1 });
    expect(s.settings.rules.dailyConnects).toBe(5);
  });
  it('starts a motion on day 1 and closes it', () => {
    const s1 = reducer(initialState(), { type: 'motion', id: 'tolvessine', to: 'running' });
    expect(s1.motions.find((m) => m.id === 'tolvessine')).toMatchObject({ state: 'running', day: 1 });
    const s2 = reducer(s1, { type: 'motion', id: 'halvenquist', to: 'closed' });
    expect(s2.motions.find((m) => m.id === 'halvenquist')?.state).toBe('closed');
  });
});

describe('B+ helpers', () => {
  it('splits Ask Ari text into tasks', () => {
    expect(splitTasks('research Kelvarrow Labs and then draft DM2 for Daniel. Withdraw old invites\nbook time with Priya;')).toEqual(
      ['Research Kelvarrow Labs', 'Draft DM2 for Daniel', 'Withdraw old invites', 'Book time with Priya']);
    expect(splitTasks('   ')).toEqual([]);
  });
  it('turns dark from 18:00 to 06:00, with the system, or when pinned', () => {
    expect(pickTheme(false, 12, null)).toBe('light');
    expect(pickTheme(false, 18, null)).toBe('dark');
    expect(pickTheme(false, 5, null)).toBe('dark');
    expect(pickTheme(true, 12, null)).toBe('dark');
    expect(pickTheme(true, 20, 'light')).toBe('light');
  });
  it('parses routes', () => {
    expect(parse('#/stack?pass=dm1')).toMatchObject({ place: 'stack', pass: 'dm1', sheet: null });
    expect(parse('#/desk?sheet=report')).toMatchObject({ place: 'desk', sheet: 'report' });
    expect(parse('#/motion/halvenquist')).toMatchObject({ place: 'motion', id: 'halvenquist' });
    expect(parse('')).toMatchObject({ place: 'stack' });
    expect(parse('#/nope?sheet=x')).toMatchObject({ place: 'stack', sheet: null });
  });
  it('groups accounts by company with one row per person', () => {
    const rows = accountRows(DEMO_PASSES);
    const names = rows.flatMap((r) => r.people.map((p) => p.person.id));
    expect(new Set(names).size).toBe(names.length);
    expect(rows.map((r) => r.company)).toEqual([...rows.map((r) => r.company)].sort());
  });
  it('writes plain copy', () => {
    expect(greeting(9, 'Alex')).toBe('Good morning, Alex');
    expect(greeting(14, 'Alex')).toBe('Good afternoon, Alex');
    expect(workLine(1, 1)).toBe('1 thing to send, about 1 minute');
    expect(workLine(0, 0)).toBe('Nothing left to send today');
  });
});
