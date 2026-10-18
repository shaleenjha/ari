// LiveData: the DataLayer over the production PostgREST (`public` schema), read-only, with the signed-in user's JWT so RLS
// decides what comes back. Every read is a GET with an explicit workspace_id filter and a row limit (get() requires one).
// Every command refuses with ReadOnlyError and sends nothing (Phase 1). Lint: no-client-writes, query-unbounded.
import type { DataLayer } from './client';
import type { CommandResult, Draft, HygieneAction, MarkField, Person, Task, WeekReport } from './types';
import type { FetchFn } from './rest';
import { ReadOnlyError, RestError } from './rest';
import { today15 } from './domain';
import { deriveQueue, isLead, prodAccount, prodActivity, prodBrief, prodFinding, prodPerson, prodReply, replyDraftBody, weekFromLog, weekStart,
  type ProdAccount, type ProdBrief, type ProdFinding, type ProdLog, type ProdPerson, type ProdReply } from './liveRows';

export interface LiveConfig { url: string; apikey: string; token: () => Promise<string>; workspaceId?: string; now?: () => Date }

const PERSON_COLS = 'id,account_id,company,name,title,linkedin_url,stage,connect_day,connect_sent,accepted,dm1_sent,dm2_due,dm2_sent,dm3_due,dm3_sent,replied,withdrawn,review,lane,route,deleted_at';
const REPLY_COLS = 'id,person_id,account_id,received_at,snippet,headline,status,drafts,people(name,company,review,deleted_at)';
const ACCOUNT_COLS = 'id,company,one_liner,hook,stage,stage_override,meeting_status,deleted_at';
/** Max rows per read. Bigger than today's data (about 230 people, 41 accounts), small enough to stay cheap. */
export const LIMITS = { people: 400, replies: 50, accounts: 200, log: 2000, findings: 20, brief: 1, one: 1, activity: 50 } as const;
const MEETINGS_GOAL = 3;
const q = (v: string) => `"${v}"`;   // PostgREST in.() needs quotes around values with spaces

export class LiveData implements DataLayer {
  private ws: Promise<string> | null = null;
  private replyDrafts = new Map<string, string | null>();
  constructor(private f: FetchFn, private cfg: LiveConfig) {}

  private now(): Date { return this.cfg.now?.() ?? new Date(); }

  /** One bounded GET. `limit` is required so no read can be unbounded. */
  private async read<T>(table: string, params: Record<string, string>, limit: number, scoped = true): Promise<T[]> {
    const ws = scoped ? await this.workspace() : null;
    const qs = new URLSearchParams({ ...params, ...(ws ? { workspace_id: `eq.${ws}` } : {}), limit: String(limit) });
    const r = await this.f(`${this.cfg.url}/rest/v1/${table}?${qs.toString()}`, {
      headers: { apikey: this.cfg.apikey, Authorization: `Bearer ${await this.cfg.token()}`, 'Accept-Profile': 'public' },
    });
    if (!r.ok) throw new RestError(r.status, `${table}: ${r.status}`);
    return (await r.json()) as T[];
  }

  /**
   * The caller's workspace. app.memberships is not exposed to the client yet, so the first row RLS lets this user see
   * names it (every tenant row carries workspace_id since 0033). VITE override for tests and future multi-workspace.
   */
  workspace(): Promise<string> {
    if (this.cfg.workspaceId) return Promise.resolve(this.cfg.workspaceId);
    this.ws ??= this.read<{ workspace_id: string }>('accounts', { select: 'workspace_id' }, LIMITS.one, false).then((rows) => {
      if (!rows[0]?.workspace_id) throw new RestError(403, 'no workspace for this sign-in');
      return rows[0].workspace_id;
    });
    this.ws.catch(() => { this.ws = null; });
    return this.ws;
  }

  private async openReplies(): Promise<ProdReply[]> {
    const rows = await this.read<ProdReply>('replies', { select: REPLY_COLS, status: 'eq.new', order: 'received_at.desc' }, LIMITS.replies);
    const leads = rows.filter((r) => isLead(r.people ?? {}));
    for (const r of leads) this.replyDrafts.set(r.person_id, replyDraftBody(r));
    return leads;
  }

  async queue(): Promise<Task[]> {
    const [people, replies] = await Promise.all([
      this.read<ProdPerson>('people', { select: PERSON_COLS, stage: `in.(Accepted,${q('DM1 sent')},${q('DM2 sent')})`, deleted_at: 'is.null', order: 'accepted.desc.nullslast' }, LIMITS.people),
      this.openReplies(),
    ]);
    return deriveQueue(people, replies, this.now());
  }

  async replies() { return (await this.openReplies()).map(prodReply); }

  async today15(): Promise<Person[]> {
    const rows = await this.read<ProdPerson>('people', { select: PERSON_COLS, stage: `eq.${'Connect queued'}`, connect_sent: 'is.null',
      deleted_at: 'is.null', order: 'connect_day.asc.nullslast,id.asc' }, LIMITS.people);
    const elig = rows.filter((p) => (p.review ?? 'lead') === 'lead' && !!p.linkedin_url?.trim() && (p.lane ?? 'shal') === 'shal' && !/founder/i.test(p.route ?? ''));
    return today15(elig.map(prodPerson), 3, 15);
  }

  async accounts() {
    return (await this.read<ProdAccount>('accounts', { select: ACCOUNT_COLS, deleted_at: 'is.null', order: 'company.asc' }, LIMITS.accounts)).map(prodAccount);
  }

  async person(id: string) {
    return (await this.read<ProdPerson>('people', { select: PERSON_COLS, id: `eq.${id}` }, LIMITS.one)).map(prodPerson)[0] ?? null;
  }

  async draft(personId: string, kind: Draft['kind']): Promise<Draft | null> {
    if (kind === 'reply') {
      if (!this.replyDrafts.has(personId)) {
        const [r] = await this.read<ProdReply>('replies', { select: 'person_id,drafts', person_id: `eq.${personId}`, status: 'eq.new', order: 'received_at.desc' }, LIMITS.one);
        this.replyDrafts.set(personId, r ? replyDraftBody(r) : null);
      }
      const body = this.replyDrafts.get(personId);
      return body ? { personId, kind, body, authorKind: 'ari' } : null;
    }
    const col = kind === 'dm1' ? 'dm' : kind === 'dm2' ? 'dm2_text' : 'dm3_text';
    const [p] = await this.read<Record<string, string | null>>('people', { select: col, id: `eq.${personId}` }, LIMITS.one);
    const body = p?.[col]?.trim();
    return body ? { personId, kind, body, authorKind: 'ari' } : null;
  }

  async account(id: string) {
    const [a] = await this.read<ProdAccount>('accounts', { select: ACCOUNT_COLS, id: `eq.${id}`, deleted_at: 'is.null' }, LIMITS.one);
    if (!a) return null;
    const [people, briefs, replies] = await Promise.all([
      this.read<ProdPerson>('people', { select: PERSON_COLS, account_id: `eq.${id}`, stage: `neq.${'Connect queued'}`, deleted_at: 'is.null', order: 'name.asc' }, LIMITS.people),
      this.read<ProdBrief>('account_briefs', { select: 'account_id,status,thesis,angle,why_now', account_id: `eq.${id}` }, LIMITS.brief),
      this.openReplies(),
    ]);
    const leads = people.filter(isLead);
    const ids = leads.map((p) => p.id);
    const activity = ids.length
      ? await this.read<ProdLog>('log_entries', { select: 'id,ts,person_id,event,source', person_id: `in.(${ids.map(q).join(',')})`, order: 'ts.desc' }, LIMITS.activity)
      : [];
    return { account: prodAccount(a), people: leads.map(prodPerson), brief: briefs[0] ? prodBrief(briefs[0]) : undefined,
      tasks: deriveQueue(leads, replies.filter((r) => ids.includes(r.person_id)), this.now()), activity: activity.map(prodActivity) };
  }

  async week(): Promise<WeekReport> {
    const from = weekStart(this.now());
    const [log, accepted] = await Promise.all([
      this.read<ProdLog>('log_entries', { select: 'id,ts,event', ts: `gte.${from}`, event: `in.(${['Connect sent', 'Accepted', 'Replied', 'Meeting', 'Meeting set'].map(q).join(',')})`, order: 'ts.asc' }, LIMITS.log),
      this.read<ProdPerson>('people', { select: 'id,name,stage,accepted,dm1_sent', accepted: `gte.${from}`, deleted_at: 'is.null', order: 'accepted.asc' }, LIMITS.people),
    ]);
    return weekFromLog(log, accepted, MEETINGS_GOAL);
  }

  async hygiene() {
    return (await this.read<ProdFinding>('hygiene_findings', { select: 'id,check_key,entity_type,entity_id,status,first_seen,detail', status: 'eq.open', order: 'first_seen.asc' }, LIMITS.findings)).map(prodFinding);
  }

  /** gmail_events has no workspace_id and no member read path yet (0032), so "Who is this?" stays empty in Phase 1. */
  async whoIsThis() { return []; }

  async mark(_p: string, _f: MarkField, _o: string): Promise<CommandResult> { throw new ReadOnlyError(); }
  async transition(_t: string, _to: Task['status'], _v: number, _o: string): Promise<CommandResult> { throw new ReadOnlyError(); }
  async resolveHygiene(_f: string, _a: HygieneAction, _o: string, _k?: string): Promise<CommandResult> { throw new ReadOnlyError(); }
  async confirmWho(_e: string, _p: string | null, _o: string): Promise<CommandResult> { throw new ReadOnlyError(); }
}
