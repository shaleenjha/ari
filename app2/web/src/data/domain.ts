// Pure domain rules shared by the client and tests (mirrors the SQL in app2/db/migrations/0002).
import type { Person, PersonStage, MarkField, TaskStatus } from './types';

const ORDER: Record<PersonStage, number> = {
  connect_queued: 0, connect_sent: 1, accepted: 2, dm1_sent: 3, dm2_sent: 4, dm3_sent: 5,
  withdrawn: 5, replied: 6, meeting_set: 7, meeting_held: 8, hold: -1,
};

/** Stage follows the furthest fact (same precedence as app.person_mark). */
export function stageFromFacts(p: Person): PersonStage {
  if (p.repliedAt) return 'replied';
  if (p.withdrawnAt) return 'withdrawn';
  if (p.dm3SentAt) return 'dm3_sent';
  if (p.dm2SentAt) return 'dm2_sent';
  if (p.dm1SentAt) return 'dm1_sent';
  if (p.acceptedAt) return 'accepted';
  if (p.connectSentAt) return 'connect_sent';
  return p.stage;
}
export const stageRank = (s: PersonStage): number => ORDER[s];

const addDays = (iso: string, d: number): string => {
  const t = new Date(iso); t.setUTCDate(t.getUTCDate() + d); return t.toISOString().slice(0, 10);
};

/** Apply a mark locally (optimistic patch). First tap wins, like the server. */
export function applyMark(p: Person, field: MarkField, at: string): Person {
  const key = ({ connect_sent: 'connectSentAt', accepted: 'acceptedAt', dm1_sent: 'dm1SentAt', dm2_sent: 'dm2SentAt',
    dm3_sent: 'dm3SentAt', replied: 'repliedAt', withdrawn: 'withdrawnAt' } as const)[field];
  const next: Person = { ...p, [key]: p[key] ?? at };
  if (next.dm1SentAt && !next.dm2Due) next.dm2Due = addDays(next.dm1SentAt, 4);
  if (next.dm2SentAt && !next.dm3Due) next.dm3Due = addDays(next.dm2SentAt, 7);
  next.stage = stageFromFacts(next);
  return next;
}

/** Today's 15: highest score first, at most `cap` per account, only people not yet connected. */
export function today15<T extends Pick<Person, 'id' | 'accountId' | 'stage' | 'score'>>(people: T[], cap = 3, n = 15): T[] {
  const per = new Map<string, number>();
  const out: T[] = [];
  for (const p of [...people].filter((x) => x.stage === 'connect_queued').sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    const k = p.accountId ?? `solo:${p.id}`;
    const c = per.get(k) ?? 0;
    if (c >= cap) continue;
    per.set(k, c + 1);
    out.push(p);
    if (out.length === n) break;
  }
  return out;
}

const ALLOWED: Array<[TaskStatus, TaskStatus]> = [
  ['proposed', 'todo'], ['proposed', 'cancelled'], ['todo', 'ready'], ['todo', 'in_progress'], ['todo', 'blocked'],
  ['todo', 'done'], ['todo', 'cancelled'], ['ready', 'in_progress'], ['ready', 'done'], ['ready', 'blocked'], ['ready', 'cancelled'],
  ['in_progress', 'done'], ['in_progress', 'blocked'], ['in_progress', 'todo'], ['in_progress', 'cancelled'],
  ['blocked', 'ready'], ['blocked', 'cancelled'], ['done', 'todo'], ['cancelled', 'todo'],
];
export const canTransition = (from: TaskStatus, to: TaskStatus): boolean => ALLOWED.some(([f, t]) => f === from && t === to);

/** Median hours from accept to DM1 over people with both times. */
export function acceptToDm1Median(people: Person[]): number | null {
  const h = people.filter((p) => p.acceptedAt && p.dm1SentAt)
    .map((p) => (Date.parse(p.dm1SentAt!) - Date.parse(p.acceptedAt!)) / 36e5).sort((a, b) => a - b);
  if (!h.length) return null;
  const m = Math.floor(h.length / 2);
  return h.length % 2 ? h[m]! : (h[m - 1]! + h[m]!) / 2;
}
