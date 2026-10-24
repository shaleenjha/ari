// B+ shell state (demo only). A pure reducer, so the view stays thin and the logic is unit tested (store.test.ts).
import { createContext, useContext, type Dispatch } from 'react';
import { DEMO_MOTIONS, DEMO_PASSES, DEMO_RESEARCH, KINDS, KIND_META, type Kind, type Motion, type PassItem, type Research } from './demo';

export interface Settings {
  notify: { accepts: boolean; replies: boolean; dmReady: boolean; digest: boolean; needsLook: boolean; quiet: boolean };
  rules: { dailyConnects: number; withdrawDays: number; dm2Days: number; dm3Days: number };
  twoStep: boolean;
  gmail: 'connected' | 'off';
}

export interface Sent { kind: Kind; item: PassItem }
export interface State {
  passes: Record<Kind, PassItem[]>;
  /** Most recent last. The toast's Undo puts the last one back at the front of its pass. */
  sent: Sent[];
  motions: Motion[];
  research: Research[];
  hidden: string[];
  tasks: string[];
  settings: Settings;
}

export type Action =
  | { type: 'sent'; kind: Kind }
  | { type: 'undo' }
  | { type: 'motion'; id: string; to: Motion['state'] }
  | { type: 'hide'; id: string }
  | { type: 'tasks'; tasks: string[] }
  | { type: 'notify'; key: keyof Settings['notify'] }
  | { type: 'rule'; key: keyof Settings['rules']; by: number }
  | { type: 'twoStep' }
  | { type: 'gmail'; to: Settings['gmail'] };

export const RULE_LIMITS: Record<keyof Settings['rules'], [number, number]> = {
  dailyConnects: [5, 30], withdrawDays: [7, 30], dm2Days: [2, 10], dm3Days: [3, 14],
};

export function initialState(): State {
  return {
    passes: Object.fromEntries(KINDS.map((k) => [k, [...DEMO_PASSES[k]]])) as Record<Kind, PassItem[]>,
    sent: [],
    motions: DEMO_MOTIONS.map((m) => ({ ...m })),
    research: [...DEMO_RESEARCH],
    hidden: [],
    tasks: [],
    settings: {
      notify: { accepts: true, replies: true, dmReady: true, digest: true, needsLook: true, quiet: true },
      rules: { dailyConnects: 15, withdrawDays: 14, dm2Days: 4, dm3Days: 7 },
      twoStep: true,
      gmail: 'connected',
    },
  };
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'sent': {
      const [item, ...rest] = s.passes[a.kind];
      if (!item) return s;
      return { ...s, passes: { ...s.passes, [a.kind]: rest }, sent: [...s.sent, { kind: a.kind, item }] };
    }
    case 'undo': {
      const last = s.sent.at(-1);
      if (!last) return s;
      return { ...s, passes: { ...s.passes, [last.kind]: [last.item, ...s.passes[last.kind]] }, sent: s.sent.slice(0, -1) };
    }
    case 'motion':
      return { ...s, motions: s.motions.map((m) => (m.id === a.id ? { ...m, state: a.to, day: a.to === 'running' && m.day === 0 ? 1 : m.day } : m)) };
    case 'hide':
      return s.hidden.includes(a.id) ? s : { ...s, hidden: [...s.hidden, a.id] };
    case 'tasks':
      return { ...s, tasks: [...s.tasks, ...a.tasks] };
    case 'notify':
      return { ...s, settings: { ...s.settings, notify: { ...s.settings.notify, [a.key]: !s.settings.notify[a.key] } } };
    case 'rule': {
      const [lo, hi] = RULE_LIMITS[a.key];
      const v = Math.min(hi, Math.max(lo, s.settings.rules[a.key] + a.by));
      return { ...s, settings: { ...s.settings, rules: { ...s.settings.rules, [a.key]: v } } };
    }
    case 'twoStep':
      return { ...s, settings: { ...s.settings, twoStep: !s.settings.twoStep } };
    case 'gmail':
      return { ...s, settings: { ...s.settings, gmail: a.to } };
  }
}

/** Things to send (every pass but Waiting) and the minutes they take, rounded up. */
export function workload(passes: Record<Kind, PassItem[]>): { count: number; minutes: number } {
  let count = 0; let min = 0;
  for (const k of KINDS) {
    if (k === 'waiting') continue;
    count += passes[k].length;
    min += passes[k].length * KIND_META[k].minutes;
  }
  return { count, minutes: Math.ceil(min) };
}

export const StoreContext = createContext<{ state: State; dispatch: Dispatch<Action> } | null>(null);
export function useStore() {
  const v = useContext(StoreContext);
  if (!v) throw new Error('useStore outside StoreContext');
  return v;
}
