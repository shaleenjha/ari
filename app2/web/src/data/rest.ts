// RestData: the DataLayer's reads over PostgREST against the app2 `app` schema. Reads are table/view selects that RLS
// scopes to the caller's workspaces (we also filter by workspace_id explicitly). Phase 1 is read-only: the command methods
// refuse here, and the synthetic command path lives in fixtures/syntheticRest.ts (MockPostgrest only). Lint: no-client-writes.
import type { DataLayer } from './client';
import type { CommandResult, Draft, HygieneAction, MarkField, Task, WeekReport } from './types';
import { acceptToDm1Median, today15 } from './domain';
import { toAccount, toActivity, toBrief, toDraft, toFinding, toPerson, toReply, toTask, toWho,
  type AccountRow, type ActivityRow, type BriefRow, type DraftRow, type HygieneRow, type IngestRowDb, type PersonRow, type ReplyRow, type TaskRow } from './rows';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export class RestError extends Error { constructor(public status: number, msg: string) { super(msg); } }
/** Thrown by every command in Phase 1 (read-only). */
export class ReadOnlyError extends Error { constructor() { super('read-only'); } }

export class RestData implements DataLayer {
  constructor(protected f: FetchFn, protected base: string, protected ws: string, private jwt: string) {}

  protected headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'Accept-Profile': 'app', 'Content-Profile': 'app', Authorization: `Bearer ${this.jwt}`, apikey: 'anon', 'Content-Type': 'application/json', ...extra };
  }
  async get<T>(table: string, q: Record<string, string> = {}): Promise<T[]> {
    const qs = new URLSearchParams({ select: '*', workspace_id: `eq.${this.ws}`, ...q });
    const r = await this.f(`${this.base}/rest/v1/${table}?${qs.toString()}`, { headers: this.headers() });
    if (!r.ok) throw new RestError(r.status, `${table}: ${r.status}`);
    return (await r.json()) as T[];
  }

  async queue(): Promise<Task[]> {
    return (await this.get<TaskRow>('my_queue', { status: 'not.in.(done,cancelled)', order: 'due_at.asc.nullslast' })).map(toTask);
  }
  async today15() {
    return today15((await this.get<PersonRow>('people', { stage: 'eq.connect_queued', order: 'score.desc.nullslast', limit: '300' })).map(toPerson), 3, 15);
  }
  async replies() { return (await this.get<ReplyRow>('replies', { status: 'eq.open', order: 'received_at.desc' })).map(toReply); }
  async accounts() { return (await this.get<AccountRow>('accounts', { order: 'name.asc' })).map(toAccount); }
  async person(id: string) { return (await this.get<PersonRow>('people', { id: `eq.${id}` })).map(toPerson)[0] ?? null; }
  async draft(personId: string, kind: Draft['kind']) {
    return (await this.get<DraftRow>('drafts', { person_id: `eq.${personId}`, kind: `eq.${kind}` })).map(toDraft)[0] ?? null;
  }
  async account(id: string) {
    const [a] = await this.get<AccountRow>('accounts', { id: `eq.${id}` });
    if (!a) return null;
    const [people, briefs, tasks] = await Promise.all([
      this.get<PersonRow>('people', { account_id: `eq.${id}`, stage: 'neq.connect_queued' }),
      this.get<BriefRow>('account_briefs', { account_id: `eq.${id}` }),
      this.get<TaskRow>('tasks', { account_id: `eq.${id}`, order: 'due_at.asc.nullslast' }),
    ]);
    const ids = [id, ...tasks.map((t) => t.id)];
    const activity = await this.get<ActivityRow>('activity', { subject_id: `in.(${ids.join(',')})`, order: 'created_at.desc', limit: '50' });
    return { account: toAccount(a), people: people.map(toPerson), brief: briefs[0] ? toBrief(briefs[0]) : undefined, tasks: tasks.map(toTask), activity: activity.map(toActivity) };
  }
  async week(): Promise<WeekReport> {
    const p = (await this.get<PersonRow>('people', { stage: 'neq.connect_queued' })).map(toPerson);
    return { meetingsAri: 1, meetingsGoal: 3, replies: p.filter((x) => x.repliedAt).length, accepts: p.filter((x) => x.acceptedAt).length,
      connects: p.filter((x) => x.connectSentAt).length, acceptToDm1MedianHours: acceptToDm1Median(p) };
  }
  async mark(_personId: string, _field: MarkField, _opId: string): Promise<CommandResult> { throw new ReadOnlyError(); }
  async transition(_taskId: string, _to: Task['status'], _expectedVersion: number, _opId: string): Promise<CommandResult> { throw new ReadOnlyError(); }
  async hygiene() { return (await this.get<HygieneRow>('hygiene_findings', { status: 'eq.open', order: 'first_seen.asc' })).map(toFinding); }
  async resolveHygiene(_findingId: string, _action: HygieneAction, _opId: string, _keepId?: string): Promise<CommandResult> { throw new ReadOnlyError(); }
  async whoIsThis() {
    const ev = await this.get<IngestRowDb>('ingest_events', { match_method: 'eq.none', kind: 'in.(accept,reply)', order: 'received_at.desc' });
    const ids = [...new Set(ev.flatMap((e) => e.parsed.candidates ?? []))];
    const people = ids.length ? await this.get<PersonRow>('people', { id: `in.(${ids.join(',')})` }) : [];
    const accIds = [...new Set(people.map((p) => p.account_id).filter((x): x is string => !!x))];
    const accounts = accIds.length ? await this.get<AccountRow>('accounts', { id: `in.(${accIds.join(',')})` }) : [];
    return ev.map((e) => toWho(e, people, accounts));
  }
  async confirmWho(_eventId: string, _personId: string | null, _opId: string): Promise<CommandResult> { throw new ReadOnlyError(); }
}
