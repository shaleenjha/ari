// Fixture. A tiny PostgREST over production-shaped (`public` schema) synthetic rows, for LiveData's unit tests. Two
// workspaces, the second a canary that must never show. RLS is simulated from the bearer "synthetic-live:<workspace>".
// Supports what LiveData sends: eq, neq, in, is.null, gte, order (first key), limit, and the people(...) embed on replies.
// Records every request with its method. Fake names and companies only.
import type { FetchFn } from '../rest';
import type { ProdAccount, ProdBrief, ProdFinding, ProdLog, ProdPerson, ProdReply } from '../liveRows';

export const LWS_A = 'f5a1e000-0000-4000-8000-0000000000aa';
export const LWS_B = 'f5a1e000-0000-4000-8000-0000000000bb';
export const LIVE_JWT_A = `synthetic-live:${LWS_A}`;
/** Fixed clock: Wed 2026-10-21 10:00 in the workspace clock. */
export const LIVE_NOW = new Date('2026-10-21T04:30:00.000Z');

type W<T> = T & { workspace_id: string };
export interface LiveDb { people: W<ProdPerson>[]; accounts: W<ProdAccount>[]; replies: W<ProdReply>[]; account_briefs: W<ProdBrief>[];
  log_entries: W<ProdLog>[]; hygiene_findings: W<ProdFinding>[] }

export function seedLive(): LiveDb {
  const A = LWS_A; const B = LWS_B;
  const acc = 'a0000000-0000-4000-8000-000000000001';
  return {
    accounts: [
      { workspace_id: A, id: acc, company: 'Ostrevanthe Co', one_liner: 'Payments platform', stage: 'Engaged' },
      { workspace_id: A, id: 'a0000000-0000-4000-8000-000000000002', company: 'Brennuvia Labs', stage: 'Meeting set', stage_override: true },
      { workspace_id: B, id: 'b0000000-0000-4000-8000-000000000001', company: 'CANARY-B-ACCOUNT', stage: 'Target' },
    ],
    people: [
      { workspace_id: A, id: 'P001', account_id: acc, name: 'Alex Doe', title: 'VP Engineering', stage: 'Accepted', connect_sent: '2026-10-19T02:00:00Z', accepted: '2026-10-20T03:00:00Z', linkedin_url: 'https://www.linkedin.com/in/x', dm: 'Hi Alex, thanks for connecting.' },
      { workspace_id: A, id: 'P002', account_id: acc, name: 'Sam Roe', title: 'Head of Security', stage: 'DM1 sent', connect_sent: '2026-10-18T10:00:00Z', accepted: '2026-10-15T03:00:00Z', dm1_sent: '2026-10-15T05:00:00Z', dm2_due: '2026-10-19' },
      { workspace_id: A, id: 'P003', account_id: acc, name: 'Jamie Poe', title: 'CTO', stage: 'DM1 sent', accepted: '2026-10-19T03:00:00Z', dm1_sent: '2026-10-19T09:00:00Z', dm2_due: '2026-10-22' },
      { workspace_id: A, id: 'P004', account_id: acc, name: 'Riley Coe', title: 'Head of Data', stage: 'Accepted', accepted: '2026-10-20T03:00:00Z', review: 'personal' },
      { workspace_id: A, id: 'P005', account_id: acc, name: 'Casey Loe', title: 'Architect', stage: 'Replied', accepted: '2026-10-10T03:00:00Z', dm1_sent: '2026-10-10T04:00:00Z', replied: '2026-10-20T08:00:00Z', meeting: '2026-10-20T09:00:00Z' },
      // Backfill placeholder times (ts_approx): counted, but kept out of the accept to DM1 median.
      { workspace_id: A, id: 'P006', name: 'Noon Placeholder', stage: 'DM1 sent', accepted: '2026-10-20T06:30:00Z', dm1_sent: '2026-10-21T02:00:00Z', ts_approx: ['accepted'] },
      // Dated after "now": outside the window.
      { workspace_id: A, id: 'P007', name: 'Future Date', stage: 'Replied', replied: '2026-10-22T06:30:00Z' },
      ...Array.from({ length: 8 }, (_, i): W<ProdPerson> => ({ workspace_id: A, id: `P1${i}`, account_id: i < 5 ? acc : null, company: i < 5 ? 'Ostrevanthe Co' : `Solo ${i}`,
        name: `Test Person ${i}`, title: 'Staff Engineer', stage: 'Connect queued', linkedin_url: `https://www.linkedin.com/in/t${i}`, connect_day: `2026-10-${10 + i}` })),
      { workspace_id: A, id: 'P20', name: 'No Link', stage: 'Connect queued' },
      { workspace_id: A, id: 'P21', name: 'Gone Person', stage: 'Accepted', accepted: '2026-10-20T03:00:00Z', deleted_at: '2026-10-20T04:00:00Z' },
      { workspace_id: B, id: 'PB1', name: 'CANARY-B-PERSON', stage: 'Accepted', accepted: '2026-10-20T03:00:00Z', linkedin_url: 'x' },
    ],
    replies: [
      { workspace_id: A, id: 11, person_id: 'P005', account_id: acc, received_at: '2026-10-20T08:00:00Z', snippet: 'Thanks, how does this work with our stack?', status: 'new',
        drafts: [{ key: 'book', body: 'Worth 20 minutes?' }, { key: 'answer', body: 'Short version: the sensitive fields move to a vault.' }, { key: 'soft', body: 'Happy to share a one pager.' }] },
      { workspace_id: A, id: 12, person_id: 'P003', received_at: '2026-10-21T02:00:00Z', snippet: null, status: 'new' },
      { workspace_id: A, id: 13, person_id: 'P004', received_at: '2026-10-21T02:00:00Z', snippet: 'personal hello', status: 'new' },
      { workspace_id: A, id: 14, person_id: 'P002', received_at: '2026-10-18T02:00:00Z', snippet: 'done already', status: 'answered' },
      { workspace_id: B, id: 99, person_id: 'PB1', received_at: '2026-10-21T02:00:00Z', snippet: 'CANARY-B-REPLY', status: 'new' },
    ],
    account_briefs: [{ workspace_id: A, account_id: acc, status: 'ready', thesis: 'Moving card data out of core apps.', why_now: [{ text: 'Hiring a residency lead', label: 'Verified' }, { text: 'EU launch', label: 'Inference' }] }],
    log_entries: [
      { workspace_id: A, id: 1, ts: '2026-10-19T03:00:00Z', person_id: 'P003', event: 'Accepted', source: 'sheet' },
      { workspace_id: A, id: 2, ts: '2026-10-19T09:00:00Z', person_id: 'P003', event: 'DM1 sent', source: 'app' },
      { workspace_id: A, id: 3, ts: '2026-10-20T03:00:00Z', person_id: 'P001', event: 'Accepted', source: 'hark' },
      { workspace_id: A, id: 4, ts: '2026-10-20T08:00:00Z', person_id: 'P005', event: 'Replied', source: 'hark' },
      { workspace_id: A, id: 5, ts: '2026-10-19T02:00:00Z', person_id: 'P10', event: 'Connect sent', source: 'app' },
      { workspace_id: A, id: 6, ts: '2026-10-18T10:00:00Z', person_id: 'P11', event: 'Connect sent', source: 'app' },   // Sunday: last week
      { workspace_id: A, id: 8, ts: '2026-10-20T10:00:00Z', person_id: null, event: 'Meeting set', source: 'backfill' },
      { workspace_id: A, id: 9, ts: '2026-10-18T10:00:00Z', person_id: null, event: 'Meeting set', source: 'backfill' },   // Sunday: last week
      { workspace_id: A, id: 10, ts: '2026-10-20T09:00:00Z', person_id: 'P005', event: 'Meeting', source: 'app' },        // same meeting as people.meeting
      { workspace_id: B, id: 7, ts: '2026-10-20T03:00:00Z', person_id: 'PB1', event: 'Accepted', source: 'app' },
    ],
    hygiene_findings: [
      { workspace_id: A, id: 'f0000000-0000-4000-8000-000000000001', check_key: 'no_account_link', entity_type: 'person', entity_id: 'P20', status: 'open', first_seen: '2026-10-20T00:00:00Z',
        detail: { name: 'No Link', note: 'company written as "Brennuvia Labs Inc"', suggestion: { id: 'a0000000-0000-4000-8000-000000000002', name: 'Brennuvia Labs' } } },
      { workspace_id: B, id: 'f0000000-0000-4000-8000-0000000000bb', check_key: 'stale_stage', entity_type: 'person', entity_id: 'PB1', status: 'open', first_seen: '2026-10-20T00:00:00Z', detail: { label: 'CANARY-B' } },
    ],
  };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const unq = (s: string) => s.replace(/^"|"$/g, '');
const list = (s: string) => s.replace(/^\(|\)$/g, '').match(/"[^"]*"|[^,]+/g)?.map(unq) ?? [];

export class LivePostgrest {
  db = seedLive();
  requests: { method: string; path: string; params: URLSearchParams }[] = [];
  fetch: FetchFn = async (url, init) => {
    const u = new URL(url);
    this.requests.push({ method: init?.method ?? 'GET', path: u.pathname, params: u.searchParams });
    if ((init?.method ?? 'GET') !== 'GET') return json({ message: 'fixture is read-only' }, 405);
    const h = (init?.headers ?? {}) as Record<string, string>;
    const m = (h.Authorization ?? '').match(/^Bearer synthetic-live:([0-9a-f-]+)$/);
    if (!m || !h.apikey) return json({ message: 'JWT invalid' }, 401);
    const table = u.pathname.replace(/^\/rest\/v1\//, '') as keyof LiveDb;
    const all = this.db[table] as unknown as Record<string, unknown>[] | undefined;
    if (!all) return json({ message: `relation public.${table} does not exist` }, 404);
    let rows = all.filter((r) => r.workspace_id === m[1]);                       // RLS
    for (const [k, v] of u.searchParams) {
      if (['select', 'order', 'limit'].includes(k)) continue;
      const i = v.indexOf('.'); const op = v.slice(0, i); const arg = v.slice(i + 1);
      rows = rows.filter((r) => {
        const val = r[k] == null ? null : String(r[k]);
        if (op === 'eq') return val === arg;
        if (op === 'neq') return val !== null && val !== arg;
        if (op === 'in') return val !== null && list(arg).includes(val);
        if (op === 'is') return arg === 'null' ? val === null : true;
        if (op === 'gte') return val !== null && val >= arg;
        throw new Error(`unsupported filter ${k}=${v}`);
      });
    }
    const [col, dir, nulls] = (u.searchParams.get('order') ?? '').split(',')[0]!.split('.');
    if (col) rows = [...rows].sort((a, b) => {
      const x = a[col] as string | null | undefined; const y = b[col] as string | null | undefined;
      if (x == null || y == null) return x == null && y == null ? 0 : (x == null ? 1 : -1) * (nulls === 'nullsfirst' ? -1 : 1);
      return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1);
    });
    const limit = u.searchParams.get('limit');
    if (limit) rows = rows.slice(0, Number(limit));
    if (table === 'replies' && /people\(/.test(u.searchParams.get('select') ?? '')) {
      rows = rows.map((r) => {
        const p = this.db.people.find((x) => x.id === r.person_id && x.workspace_id === m[1]);
        return { ...r, people: p ? { name: p.name, company: p.company ?? null, review: p.review ?? null, deleted_at: p.deleted_at ?? null } : null };
      });
    }
    return json(rows);
  };
}
