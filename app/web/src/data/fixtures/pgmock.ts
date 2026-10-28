// Fixture. MockPostgrest: an in-memory, PostgREST-like server over synthetic app rows (two workspaces, the second a canary that must
// never show). Supports the subset RestData uses: select=*, eq/neq/in/not.in filters, order, limit, and the command RPCs with
// op-id replay. RLS is simulated from the bearer token "synthetic:<workspace>:<role>". Fake names and companies only.
import { seed } from './mock';
import type { AccountRow, ActivityRow, BriefRow, DraftRow, HygieneRow, IngestRowDb, PersonRow, ReplyRow, TaskRow } from '../rows';
import type { FetchFn } from '../rest';

export const WS_A = 'aaaaaaaa-0000-0000-0000-000000000001';
export const WS_B = 'bbbbbbbb-0000-0000-0000-000000000001';
export const JWT_A = `synthetic:${WS_A}:sdr`;
type Row = Record<string, unknown> & { workspace_id: string };
export interface Db {
  accounts: AccountRow[]; people: PersonRow[]; tasks: TaskRow[]; replies: ReplyRow[]; account_briefs: BriefRow[]; drafts: DraftRow[];
  activity: ActivityRow[]; hygiene_findings: HygieneRow[]; ingest_events: IngestRowDb[];
}

export function seedDb(): Db {
  const s = seed(); const A = WS_A;
  const db: Db = {
    accounts: s.accounts.map((a) => ({ workspace_id: A, id: a.id, name: a.name, domain: a.domain ?? null, stage: a.stage, stage_pinned: a.stagePinned,
      one_liner: a.oneLiner ?? null, hook: a.hook ?? null, send_window: a.window ?? null })),
    people: s.people.map((p) => ({ workspace_id: A, id: p.id, account_id: p.accountId ?? null, full_name: p.fullName, title: p.title ?? null, stage: p.stage,
      score: p.score ?? null, connect_sent_at: p.connectSentAt ?? null, accepted_at: p.acceptedAt ?? null, dm1_sent_at: p.dm1SentAt ?? null,
      dm2_due: p.dm2Due ?? null, replied_at: p.repliedAt ?? null })),
    tasks: s.tasks.map((t) => ({ workspace_id: A, id: t.id, kind: t.kind, title: t.title, status: t.status, assignee_role: t.assigneeRole,
      account_id: t.accountId ?? null, person_id: t.personId ?? null, due_at: t.dueAt ?? null, version: t.version, created_by_kind: t.createdByKind })),
    replies: s.replies.map((r) => ({ workspace_id: A, id: r.id, person_id: r.personId ?? null, snippet: r.snippet, received_at: r.receivedAt, status: r.status })),
    account_briefs: s.briefs.map((b) => ({ workspace_id: A, account_id: b.accountId, status: b.status, body: { thesis: b.thesis, why_now: b.whyNow, angle: b.angle } })),
    drafts: s.drafts.map((d) => ({ workspace_id: A, person_id: d.personId, kind: d.kind, body: d.body, author_kind: d.authorKind })),
    activity: s.activity.map((x) => ({ workspace_id: A, id: x.id, actor_kind: x.actorKind, verb: x.verb, subject_type: x.subjectType, subject_id: x.subjectId ?? null, created_at: x.createdAt })),
    hygiene_findings: [], ingest_events: [],
  };
  const at = '2026-10-23T10:00:00.000Z';
  db.accounts.push({ workspace_id: A, id: 'acc-4', name: 'Ostrevanthe Company', domain: 'example.com', stage: 'target', stage_pinned: false });
  db.people.push(
    { workspace_id: A, id: 'p-4', account_id: 'acc-3', full_name: 'Riley Coe', title: 'Head of Data', stage: 'accepted', accepted_at: at },
    { workspace_id: A, id: 'p-5', account_id: null, full_name: 'Casey Loe', title: 'Security Architect', stage: 'connect_sent', connect_sent_at: at },
    { workspace_id: A, id: 'p-6', account_id: 'acc-1', full_name: 'Jordan Leesynth', title: 'Director, Platform', stage: 'connect_sent', connect_sent_at: at },
    { workspace_id: A, id: 'p-7', account_id: 'acc-3', full_name: 'Jordan Leesynth', title: 'Engineering Manager', stage: 'connect_sent', connect_sent_at: at },
    { workspace_id: A, id: 'p-8', account_id: 'acc-4', full_name: 'Morgan Kaysynth', title: 'Platform Lead', stage: 'connect_sent', connect_sent_at: at },
  );
  db.hygiene_findings.push(
    { workspace_id: A, id: 'f-1', check_key: 'accept_no_connect', entity_type: 'person', entity_id: 'p-4', status: 'open', first_seen: at, detail: { label: 'Riley Coe · Dravequin Systems' } },
    { workspace_id: A, id: 'f-2', check_key: 'duplicate_account', entity_type: 'account', entity_id: 'acc-4', status: 'open', first_seen: at,
      detail: { label: 'Ostrevanthe Company', note: 'same domain as Ostrevanthe Co', suggestion: { id: 'acc-1', name: 'Ostrevanthe Co' } } },
    { workspace_id: A, id: 'f-3', check_key: 'no_account_link', entity_type: 'person', entity_id: 'p-5', status: 'open', first_seen: at,
      detail: { label: 'Casey Loe', note: 'company written as "Brennuvia Labs Inc"', suggestion: { id: 'acc-2', name: 'Brennuvia Labs' } } },
  );
  db.ingest_events.push({ workspace_id: A, id: 'ev-1', kind: 'accept', match_method: 'none', matched_person_id: null, mode: 'shadow', received_at: '2026-10-24T02:10:00.000Z',
    parsed: { name: 'Jordan Leesynth', headline: 'Director, Platform at Ostrevanthe Co', candidates: ['p-6', 'p-7'] } });
  // workspace B canary rows: must never reach workspace A's screens
  db.accounts.push({ workspace_id: WS_B, id: 'acc-b', name: 'CANARY-B-ACCOUNT', stage: 'target', stage_pinned: false });
  db.people.push({ workspace_id: WS_B, id: 'p-b', account_id: 'acc-b', full_name: 'CANARY-B-PERSON', stage: 'connect_queued', score: 1000 });
  db.replies.push({ workspace_id: WS_B, id: 'r-b', person_id: 'p-b', snippet: 'CANARY-B-REPLY', received_at: at, status: 'open' });
  db.hygiene_findings.push({ workspace_id: WS_B, id: 'f-b', check_key: 'no_account_link', entity_type: 'person', entity_id: 'p-b', status: 'open', first_seen: at, detail: { label: 'CANARY-B' } });
  db.ingest_events.push({ workspace_id: WS_B, id: 'ev-b', kind: 'reply', match_method: 'none', mode: 'shadow', received_at: at, parsed: { name: 'CANARY-B', candidates: ['p-b'] } });
  return db;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function filterRows(rows: Row[], params: URLSearchParams): Row[] {
  let out = rows;
  for (const [k, v] of params) {
    if (k === 'select' || k === 'order' || k === 'limit') continue;
    const [op, ...rest] = v.split('.'); const arg = rest.join('.');
    const list = () => arg.replace(/^\(|\)$/g, '').split(',');
    out = out.filter((r) => {
      const val = r[k] == null ? null : String(r[k]);
      if (op === 'eq') return val === arg;
      if (op === 'neq') return val !== arg;
      if (op === 'in') return val !== null && list().includes(val);
      if (op === 'not' && arg.startsWith('in.')) { const l = arg.slice(3).replace(/^\(|\)$/g, '').split(','); return val === null || !l.includes(val); }
      if (op === 'is') return arg === 'null' ? val === null : true;
      throw new Error(`unsupported filter ${k}=${v}`);
    });
  }
  const order = params.get('order');
  if (order) {
    const [col, dir = 'asc'] = order.split('.');
    out = [...out].sort((a, b) => {
      const x = a[col!] as string | number | null; const y = b[col!] as string | number | null;
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
    });
  }
  const limit = params.get('limit');
  return limit ? out.slice(0, Number(limit)) : out;
}

export class MockPostgrest {
  db = seedDb();
  private ops = new Map<string, unknown>();
  requests: string[] = [];
  private nextActivity = 1000;

  fetch: FetchFn = async (url, init) => {
    const u = new URL(url, 'http://mock.local');
    this.requests.push(`${init?.method ?? 'GET'} ${u.pathname}${u.search}`);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? '';
    const m = auth.match(/^Bearer synthetic:([0-9a-f-]+):(\w+)$/);
    if (!m) return json({ message: 'JWT invalid' }, 401);
    const [, ws, role] = m as unknown as [string, string, string];
    if ((init?.headers as Record<string, string>)['Accept-Profile'] !== 'app') return json({ message: 'schema must be app' }, 406);
    const path = u.pathname.replace(/^\/rest\/v1\//, '');
    if (path.startsWith('rpc/')) {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      if (body.p_ws !== ws) return json({ message: 'not a member', code: '42501' }, 403);
      return this.rpc(path.slice(4), ws, role, body);
    }
    const table = path === 'my_queue' ? 'tasks' : path;
    let rows = (this.db as unknown as Record<string, Row[]>)[table];
    if (!rows) return json({ message: `relation app.${path} does not exist` }, 404);
    rows = rows.filter((r) => r.workspace_id === ws);                        // RLS: app.is_member(workspace_id)
    if (path === 'my_queue') rows = rows.filter((r) => r.assignee_role === role && ['todo', 'ready', 'in_progress', 'blocked', 'proposed'].includes(String(r.status)));
    try { return json(filterRows(rows, u.searchParams)); } catch (e) { return json({ message: String(e) }, 400); }
  };

  private log(ws: string, verb: string, subject_type: string, subject_id: string) {
    this.db.activity.push({ workspace_id: ws, id: this.nextActivity++, actor_kind: 'sdr', verb, subject_type, subject_id, created_at: new Date().toISOString() });
  }
  private rpc(fn: string, ws: string, role: string, a: Record<string, unknown>): Response {
    const op = a.p_op ? `${ws}|${String(a.p_op)}` : null;
    if (op && this.ops.has(op)) return json(this.ops.get(op));
    const done = (res: unknown) => { if (op) this.ops.set(op, res); return json(res); };
    const people = this.db.people.filter((p) => p.workspace_id === ws);
    if (fn === 'person_mark') {
      if (role === 'agent' && !['accepted', 'replied'].includes(String(a.p_field))) return json({ message: 'Ari records accepts and replies only', code: '42501' }, 403);
      const p = people.find((x) => x.id === a.p_person);
      if (!p) return json({ message: 'no such person' }, 400);
      const col = `${String(a.p_field)}_at` as keyof PersonRow;
      (p as unknown as Record<string, unknown>)[col] ??= new Date().toISOString();
      if (a.p_field === 'connect_sent' && p.stage === 'connect_queued') p.stage = 'connect_sent';
      this.log(ws, `marked_${String(a.p_field)}`, 'person', p.id);
      return done({ ok: true });
    }
    if (fn === 'task_transition') {
      const t = this.db.tasks.find((x) => x.workspace_id === ws && x.id === a.p_task);
      if (!t) return json({ message: 'no such task' }, 400);
      if (t.version !== a.p_expected_version) return json({ ok: false, conflict: true, version: t.version, status: t.status });
      t.status = a.p_to as TaskRow['status']; t.version++;
      return done({ ok: true, version: t.version, status: t.status });
    }
    if (fn === 'hygiene_resolve') {
      const f = this.db.hygiene_findings.find((x) => x.workspace_id === ws && x.id === a.p_finding);
      if (!f) return json({ message: 'no such finding' }, 400);
      if (f.status !== 'open') return json({ ok: false, conflict: true });
      const act = String(a.p_action);
      if (act === 'tick_connect') { const p = people.find((x) => x.id === f.entity_id); if (p) p.connect_sent_at ??= p.accepted_at ?? new Date().toISOString(); }
      else if (act === 'link') { const p = people.find((x) => x.id === f.entity_id); if (p && f.detail.suggestion) p.account_id = f.detail.suggestion.id; }
      else if (act === 'merge') {
        const keep = String(a.p_keep ?? ''); const other = keep === f.entity_id ? f.detail.suggestion?.id : f.entity_id;
        if (!keep || ![f.entity_id, f.detail.suggestion?.id].includes(keep) || !other) return json({ message: 'merge needs keep = one of the two accounts' }, 400);
        for (const p of people) if (p.account_id === other) p.account_id = keep;
        this.db.accounts = this.db.accounts.filter((x) => !(x.workspace_id === ws && x.id === other));
      } else if (act !== 'dismiss') return json({ message: 'bad action' }, 400);
      f.status = act === 'dismiss' ? 'dismissed' : 'fixed';
      this.log(ws, `hygiene_${act}`, f.entity_type, f.entity_id);
      return done({ ok: true });
    }
    if (fn === 'ingest_confirm_match') {
      if (role === 'agent') return json({ message: 'members confirm matches; Ari proposes them', code: '42501' }, 403);
      const e = this.db.ingest_events.find((x) => x.workspace_id === ws && x.id === a.p_event);
      if (!e) return json({ message: 'no such event' }, 400);
      if (e.match_method !== 'none') return done({ ok: false, conflict: true, person: e.matched_person_id });
      if (a.p_person && !people.some((p) => p.id === a.p_person)) return json({ message: 'no such person' }, 400);
      e.matched_person_id = (a.p_person as string | null) ?? null; e.match_method = a.p_person ? 'confirmed' : 'rejected';
      return done({ ok: true });
    }
    return json({ message: `function app.${fn} does not exist` }, 404);
  }
}
