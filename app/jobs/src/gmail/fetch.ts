// gmail-ingest fetcher (shadow mode). Turns Gmail API message JSON (users.messages.get, format=full) into RawEmail for the
// parser, walks users.history.list from a stored historyId cursor, and writes one ingest row per Gmail message id.
// No network here: the Gmail API sits behind the GmailApi interface (see docs/gmail-fetch.md for how it authenticates later).
import type { RawEmail } from './parse';
import { ingest, type IngestRow } from './handler';
import type { Candidate } from './match';

// ---- Gmail API shapes (subset of users.messages.get format=full and users.history.list) ----
export interface GmailHeader { name: string; value: string }
export interface GmailPart {
  partId?: string; mimeType?: string; filename?: string; headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string }; parts?: GmailPart[];
}
export interface GmailMessage { id: string; threadId?: string; historyId?: string; internalDate?: string; labelIds?: string[]; snippet?: string; payload?: GmailPart }
export interface GmailHistoryPage {
  history?: Array<{ id?: string; messagesAdded?: Array<{ message: { id: string; labelIds?: string[] } }> }>;
  historyId: string; nextPageToken?: string;
}
export interface GmailListPage { messages?: Array<{ id: string }>; nextPageToken?: string; resultSizeEstimate?: number }

/** What the fetcher needs from Gmail. The real adapter (later) calls the REST API with a short-lived access token. */
export interface GmailApi {
  profile(): Promise<{ historyId: string }>;
  historyList(startHistoryId: string, pageToken?: string): Promise<GmailHistoryPage>;   // throws HistoryExpiredError on 404
  messagesList(q: string, pageToken?: string): Promise<GmailListPage>;
  getMessage(id: string): Promise<GmailMessage>;
}
export class HistoryExpiredError extends Error { constructor() { super('history_expired'); } }

export interface CursorStore {
  get(ws: string, mailbox: string): Promise<string | null>;
  /** Compare-and-set (app.ingest_cursor_advance): true only if the cursor still equals `from`. */
  advance(ws: string, mailbox: string, from: string | null, to: string, resync?: boolean): Promise<boolean>;
}
export interface IngestSink {
  /** Which of these Gmail ids already have an ingest row (so we skip the messages.get call). */
  seen(ws: string, ids: string[]): Promise<Set<string>>;
  /** app.ingest_record: idempotent on (workspace, source, source_msg_id); returns rows actually inserted. */
  write(ws: string, rows: IngestRow[]): Promise<number>;
}

// ---- message JSON -> RawEmail ----
const MAX_BODY = 200_000;
export function b64urlDecode(data: string): string {
  return Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}
const header = (hs: GmailHeader[] | undefined, name: string): string | undefined =>
  hs?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;

function collect(part: GmailPart | undefined, out: { text: string[]; html: string[] }): void {
  if (!part) return;
  const isAttachment = !!part.filename || !!part.body?.attachmentId;
  if (!isAttachment && part.body?.data) {
    if (part.mimeType === 'text/plain') out.text.push(b64urlDecode(part.body.data));
    else if (part.mimeType === 'text/html') out.html.push(b64urlDecode(part.body.data));
  }
  for (const p of part.parts ?? []) collect(p, out);
}

/** Gmail message JSON -> the parser's RawEmail. Uses Gmail's own Authentication-Results (mx.google.com) when there are several. */
export function gmailToRaw(m: GmailMessage): RawEmail {
  const hs = m.payload?.headers;
  const out = { text: [] as string[], html: [] as string[] };
  collect(m.payload, out);
  const auths = (hs ?? []).filter((h) => h.name.toLowerCase() === 'authentication-results').map((h) => h.value);
  const auth = auths.find((a) => /^\s*mx\.google\.com/i.test(a)) ?? auths[0];
  const dateHdr = header(hs, 'Date');
  const date = dateHdr && !Number.isNaN(Date.parse(dateHdr)) ? dateHdr
    : m.internalDate ? new Date(Number(m.internalDate)).toISOString() : (dateHdr ?? '');
  const text = out.text.join('\n').slice(0, MAX_BODY);
  const html = out.html.join('\n').slice(0, MAX_BODY);
  return { id: m.id, from: header(hs, 'From') ?? '', subject: header(hs, 'Subject') ?? '', date,
    text: text || undefined, html: html || undefined, authResults: auth };
}

// ---- the fetch + ingest pass ----
export const LINKEDIN_QUERY = 'from:linkedin.com';
export interface FetchOptions {
  workspaceId: string; mailbox: string; api: GmailApi; cursor: CursorStore; sink: IngestSink; people: Candidate[];
  mode?: 'shadow' | 'live'; maxMessages?: number; resyncWindow?: string;   // e.g. 'newer_than:7d'
}
export interface FetchResult {
  cursorFrom: string | null; cursorTo: string | null; advanced: boolean; resync: boolean; bootstrap: boolean; truncated: boolean;
  listed: number; skippedSeen: number; fetched: number; written: number; ignored: number; conflict: boolean;
}

async function idsFromHistory(api: GmailApi, start: string): Promise<{ ids: string[]; historyId: string }> {
  const ids: string[] = []; let token: string | undefined; let historyId = start;
  do {
    const page = await api.historyList(start, token);
    for (const h of page.history ?? []) for (const a of h.messagesAdded ?? []) {
      if (!(a.message.labelIds ?? []).some((l) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT' || l === 'SENT')) ids.push(a.message.id);
    }
    historyId = page.historyId; token = page.nextPageToken;
  } while (token);
  return { ids, historyId };
}
async function idsFromSearch(api: GmailApi, q: string): Promise<string[]> {
  const ids: string[] = []; let token: string | undefined;
  do { const page = await api.messagesList(q, token); for (const m of page.messages ?? []) ids.push(m.id); token = page.nextPageToken; } while (token);
  return ids;
}

/**
 * One pass. First run (no cursor) and an expired cursor both take the profile's historyId FIRST, then backfill by search,
 * so nothing that arrives during the pass is lost. The cursor only moves when every listed message was handled; a truncated
 * pass leaves it in place and the next pass skips what is already written (idempotent on message id).
 */
export async function fetchAndIngest(o: FetchOptions): Promise<FetchResult> {
  const max = o.maxMessages ?? 200;
  const from = await o.cursor.get(o.workspaceId, o.mailbox);
  let target: string; let ids: string[]; let resync = false; const bootstrap = from === null;
  if (from === null) {
    target = (await o.api.profile()).historyId;
    ids = await idsFromSearch(o.api, `${LINKEDIN_QUERY} ${o.resyncWindow ?? 'newer_than:2d'}`);
  } else {
    try {
      const h = await idsFromHistory(o.api, from); target = h.historyId; ids = h.ids;
    } catch (e) {
      if (!(e instanceof HistoryExpiredError)) throw e;
      resync = true;
      target = (await o.api.profile()).historyId;
      ids = await idsFromSearch(o.api, `${LINKEDIN_QUERY} ${o.resyncWindow ?? 'newer_than:7d'}`);
    }
  }
  const unique = [...new Set(ids)];
  const already = await o.sink.seen(o.workspaceId, unique);
  const todo = unique.filter((id) => !already.has(id));
  const batch = todo.slice(0, max);
  const truncated = todo.length > batch.length;
  const msgs: RawEmail[] = [];
  for (const id of batch) msgs.push(gmailToRaw(await o.api.getMessage(id)));
  const { rows } = ingest(o.workspaceId, msgs, o.people, o.mode ?? 'shadow', new Set(already));
  const written = rows.length ? await o.sink.write(o.workspaceId, rows) : 0;
  let advanced = false; let conflict = false;
  if (!truncated) {
    advanced = await o.cursor.advance(o.workspaceId, o.mailbox, from, target, resync);
    conflict = !advanced && from !== target;
  }
  return { cursorFrom: from, cursorTo: advanced ? target : from, advanced, resync, bootstrap, truncated, listed: unique.length,
    skippedSeen: already.size, fetched: batch.length, written, ignored: batch.length - rows.length, conflict };
}

/** Runtime handler for job kind 'gmail-ingest' (payload: { mailbox }). Deps are injected so tests and the real adapter share it. */
export function gmailIngestHandler(deps: { api: (ws: string, mailbox: string) => Promise<GmailApi>; cursor: CursorStore; sink: IngestSink;
  people: (ws: string) => Promise<Candidate[]>; mode: (ws: string) => Promise<'shadow' | 'live'> }) {
  return async (job: { workspaceId: string; payload: unknown }): Promise<FetchResult> => {
    const mailbox = (job.payload as { mailbox?: string } | null)?.mailbox;
    if (!mailbox) throw new Error('payload.mailbox required');
    return fetchAndIngest({ workspaceId: job.workspaceId, mailbox, api: await deps.api(job.workspaceId, mailbox), cursor: deps.cursor,
      sink: deps.sink, people: await deps.people(job.workspaceId), mode: await deps.mode(job.workspaceId) });
  };
}

// ---- in-memory stores (tests, local runs); the Postgres ones call the 0004 functions with the same contract ----
export class MemoryCursor implements CursorStore {
  m = new Map<string, string>();
  async get(ws: string, mb: string) { return this.m.get(`${ws}|${mb}`) ?? null; }
  async advance(ws: string, mb: string, from: string | null, to: string, resync = false) {
    const k = `${ws}|${mb}`; const cur = this.m.get(k) ?? null;
    if (cur !== from) return false;
    if (cur !== null && !resync && BigInt(to) < BigInt(cur)) return false;
    this.m.set(k, to); return true;
  }
}
export class MemorySink implements IngestSink {
  rows = new Map<string, IngestRow>();
  async seen(ws: string, ids: string[]) { return new Set(ids.filter((id) => this.rows.has(`${ws}|${id}`))); }
  async write(ws: string, rows: IngestRow[]) {
    let n = 0; for (const r of rows) { const k = `${ws}|${r.sourceMsgId}`; if (!this.rows.has(k)) { this.rows.set(k, r); n++; } } return n;
  }
}

/** Row shape app.ingest_record expects (snake_case jsonb). */
export const toRecordJson = (r: IngestRow) => ({ source: 'gmail', source_msg_id: r.sourceMsgId, kind: r.kind,
  parsed: r.candidates ? { ...r.parsed, candidates: r.candidates } : r.parsed,
  matched_person_id: r.matchedPersonId ?? null, match_method: r.matchMethod, mode: r.mode, received_at: r.receivedAt });
