// Synthetic, in-memory data layer. Fake people and companies only; never real prospect data.
import type { DataLayer } from './client';
import type { Account, Activity, Brief, CommandResult, Draft, Person, Reply, Task, WeekReport } from './types';
import { acceptToDm1Median, applyMark, canTransition, today15 } from './domain';

const now = Date.parse('2026-10-24T09:00:00+05:30');
const h = (n: number): string => new Date(now - n * 36e5).toISOString();

export function seed() {
  const accounts: Account[] = [
    { id: 'acc-1', name: 'Ostrevanthe Co', domain: 'example.com', stage: 'engaged', stagePinned: false, oneLiner: 'Payments platform, 400 people', hook: 'New data residency hire', window: 'ET' },
    { id: 'acc-2', name: 'Brennuvia Labs', stage: 'mapped', stagePinned: false, oneLiner: 'Health records API', window: 'PT' },
    { id: 'acc-3', name: 'Dravequin Systems', stage: 'researching', stagePinned: false, oneLiner: 'Insurance claims SaaS', window: 'CT' },
  ];
  const people: Person[] = [
    { id: 'p-1', accountId: 'acc-1', fullName: 'Alex Doe', title: 'VP Engineering', stage: 'accepted', connectSentAt: h(72), acceptedAt: h(3) },
    { id: 'p-2', accountId: 'acc-1', fullName: 'Sam Roe', title: 'Head of Security', stage: 'dm1_sent', connectSentAt: h(200), acceptedAt: h(150), dm1SentAt: h(148), dm2Due: '2026-10-22' },
    { id: 'p-3', accountId: 'acc-2', fullName: 'Jamie Poe', title: 'CTO', stage: 'replied', acceptedAt: h(90), dm1SentAt: h(88), repliedAt: h(2) },
    ...Array.from({ length: 20 }, (_, i): Person => ({
      id: `q-${i + 1}`, accountId: `acc-${(i % 3) + 1}`, fullName: `Test Person ${i + 1}`, title: i % 2 ? 'Director, Platform' : 'Staff Engineer',
      stage: 'connect_queued', score: 100 - i,
    })),
  ];
  const replies: Reply[] = [{ id: 'r-1', personId: 'p-3', snippet: 'Thanks for reaching out, can you share more on how this works with our stack?', receivedAt: h(2), status: 'open' }];
  const briefs: Brief[] = [{ accountId: 'acc-1', status: 'ready', thesis: 'Moving card data out of app databases before a regional launch.',
    whyNow: [{ text: 'Hiring a data residency lead', label: 'verified' }, { text: 'EU launch planned next quarter', label: 'inference' }], angle: 'Residency without re-architecture' }];
  const tasks: Task[] = [
    { id: 't-1', kind: 'dm', title: 'Send DM1 to Alex Doe', status: 'ready', assigneeRole: 'sdr', accountId: 'acc-1', personId: 'p-1', dueAt: h(-1), version: 1, createdByKind: 'ari' },
    { id: 't-2', kind: 'follow_up', title: 'Send DM2 to Sam Roe', status: 'todo', assigneeRole: 'sdr', accountId: 'acc-1', personId: 'p-2', dueAt: h(24), version: 1, createdByKind: 'ari' },
    { id: 't-3', kind: 'reply', title: 'Answer Jamie Poe', status: 'todo', assigneeRole: 'sdr', accountId: 'acc-2', personId: 'p-3', dueAt: h(-2), version: 1, createdByKind: 'ari' },
    { id: 't-4', kind: 'ask', title: 'Warm path into Ostrevanthe Co?', status: 'todo', assigneeRole: 'ae', accountId: 'acc-1', version: 1, createdByKind: 'sdr' },
  ];
  const drafts: Draft[] = [{ personId: 'p-1', kind: 'dm1', body: 'Hi Alex, thanks for connecting. Saw the data residency hire ...', authorKind: 'ari' }];
  const activity: Activity[] = [
    { id: 1, actorKind: 'ari', verb: 'brief_ready', subjectType: 'account', subjectId: 'acc-1', createdAt: h(5) },
    { id: 2, actorKind: 'sdr', verb: 'marked_dm1_sent', subjectType: 'person', subjectId: 'p-2', createdAt: h(148) },
    { id: 3, actorKind: 'ae', verb: 'task_created', subjectType: 'task', subjectId: 't-4', createdAt: h(20) },
  ];
  return { accounts, people, replies, briefs, tasks, drafts, activity };
}

export class MockData implements DataLayer {
  private s = seed();
  private ops = new Map<string, CommandResult>();
  async queue() { return this.s.tasks.filter((t) => t.assigneeRole === 'sdr' && !['done', 'cancelled'].includes(t.status)); }
  async today15() { return today15(this.s.people, 3, 15); }
  async replies() { return this.s.replies.filter((r) => r.status === 'open'); }
  async accounts() { return this.s.accounts; }
  async person(id: string) { return this.s.people.find((p) => p.id === id) ?? null; }
  async draft(personId: string, kind: Draft['kind']) { return this.s.drafts.find((d) => d.personId === personId && d.kind === kind) ?? null; }
  async account(id: string) {
    const account = this.s.accounts.find((a) => a.id === id);
    if (!account) return null;
    return {
      account, people: this.s.people.filter((p) => p.accountId === id && p.stage !== 'connect_queued'),
      brief: this.s.briefs.find((b) => b.accountId === id), tasks: this.s.tasks.filter((t) => t.accountId === id),
      activity: this.s.activity.filter((a) => a.subjectId === id || this.s.tasks.some((t) => t.id === a.subjectId && t.accountId === id)),
    };
  }
  async week(): Promise<WeekReport> {
    const p = this.s.people;
    return { meetingsAri: 1, meetingsGoal: 3, replies: p.filter((x) => x.repliedAt).length, accepts: p.filter((x) => x.acceptedAt).length,
      connects: p.filter((x) => x.connectSentAt).length, acceptToDm1MedianHours: acceptToDm1Median(p) };
  }
  async mark(personId: string, field: Parameters<DataLayer['mark']>[1], op: string): Promise<CommandResult> {
    if (this.ops.has(op)) return this.ops.get(op) as CommandResult;
    const i = this.s.people.findIndex((p) => p.id === personId);
    if (i < 0) return { ok: false };
    this.s.people[i] = applyMark(this.s.people[i]!, field, new Date(now).toISOString());
    const res = { ok: true }; this.ops.set(op, res); return res;
  }
  async transition(taskId: string, to: Task['status'], expectedVersion: number, op: string): Promise<CommandResult> {
    if (this.ops.has(op)) return this.ops.get(op) as CommandResult;
    const t = this.s.tasks.find((x) => x.id === taskId);
    if (!t) return { ok: false };
    if (t.version !== expectedVersion) return { ok: false, conflict: true, version: t.version, status: t.status };
    if (!canTransition(t.status, to)) return { ok: false };
    t.status = to; t.version += 1;
    const res = { ok: true, version: t.version, status: to }; this.ops.set(op, res); return res;
  }
}
