// RestData: the DataLayer over PostgREST (Supabase) against the app2 `app` schema. Reads are table/view selects that RLS
// scopes to the caller's workspaces (we also filter by workspace_id explicitly); writes are command RPCs only.
// Locally and in e2e it talks to MockPostgrest (in-memory, synthetic); later the same code points at an app2 project.
import type { DataLayer } from './client';
import type { CommandResult, Draft, HygieneAction, MarkField, Task, WeekReport } from './types';
import { acceptToDm1Median, today15 } from './domain';
import { toAccount, toActivity, toBrief, toDraft, toFinding, toPerson, toReply, toTask, toWho,
  type AccountRow, type ActivityRow, type BriefRow, type DraftRow, type HygieneRow, type IngestRowDb, type PersonRow, type ReplyRow, type TaskRow } from './rows';

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;
export class RestError extends Error { constructor(public status: number, msg: string) { super(msg); } }

export class RestData implements DataLayer {
  constructor(private f: FetchFn, private base: string, private ws: string, private jwt: string) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { 'Accept-Profile': 'app', 'Content-Profile': 'app', Authorization: `Bearer ${this.jwt}`, apikey: 'anon', 'Content-Type': 'application/json', ...extra };
  }
  async get<T>(table: string, q: Record<string, string> = {}): Promise<T[]> {
    const qs = new URLSearchParams({ select: '*', workspace_id: `eq.${this.ws}`, ...q });
    const r = await this.f(`${this.base}/rest/v1/${table}?${qs.toString()}`, { headers: this.headers() });
    if (!r.ok) throw new RestError(r.status, `${table}: ${r.status}`);
    return (await r.json()) as T[];
  }
  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    const r = await this.f(`${this.base}/rest/v1/rpc/${fn}`, { method: 'POST', headers: this.headers(), body: JSON.stringify({ p_ws: this.ws, ...args }) });
    if (!r.ok) throw new RestError(r.status, `${fn}: ${r.status}`);
    return (await r.json()) as T;
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
  async mark(personId: string, field: MarkField, opId: string): Promise<CommandResult> {
    return this.rpc<CommandResult>('person_mark', { p_person: personId, p_field: field, p_op: opId });
  }
  async transition(taskId: string, to: Task['status'], expectedVersion: number, opId: string): Promise<CommandResult> {
    return this.rpc<CommandResult>('task_transition', { p_task: taskId, p_to: to, p_expected_version: expectedVersion, p_op: opId });
  }
  async hygiene() { return (await this.get<HygieneRow>('hygiene_findings', { status: 'eq.open', order: 'first_seen.asc' })).map(toFinding); }
  async resolveHygiene(findingId: string, action: HygieneAction, opId: string, keepId?: string): Promise<CommandResult> {
    return this.rpc<CommandResult>('hygiene_resolve', { p_finding: findingId, p_action: action, p_keep: keepId ?? null, p_op: opId });
  }
  async whoIsThis() {
    const ev = await this.get<IngestRowDb>('ingest_events', { match_method: 'eq.none', kind: 'in.(accept,reply)', order: 'received_at.desc' });
    const ids = [...new Set(ev.flatMap((e) => e.parsed.candidates ?? []))];
    const people = ids.length ? await this.get<PersonRow>('people', { id: `in.(${ids.join(',')})` }) : [];
    const accIds = [...new Set(people.map((p) => p.account_id).filter((x): x is string => !!x))];
    const accounts = accIds.length ? await this.get<AccountRow>('accounts', { id: `in.(${accIds.join(',')})` }) : [];
    return ev.map((e) => toWho(e, people, accounts));
  }
  async confirmWho(eventId: string, personId: string | null, opId: string): Promise<CommandResult> {
    return this.rpc<CommandResult>('ingest_confirm_match', { p_event: eventId, p_person: personId, p_op: opId });
  }
}
