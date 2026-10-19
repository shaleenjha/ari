// Ari v18.8.1: ari-gmail-ingest edge function (Supabase, Deno). SHADOW MODE: reads Owner's Gmail read-only every 10 min (pg_cron,
// header x-ari-hook), keeps ONLY parsed fields (msg id, event type, profile URL, name, exact time) in gmail_shadow_events.
// Never stores or logs bodies, snippets or tokens. Changes nothing in people/replies. Deploy with Verify JWT OFF.
// Secrets: ARI_GMAIL_CLIENT_ID / ARI_GMAIL_CLIENT_SECRET (function secrets); refresh token + hook secret in Supabase Vault (service-role RPCs).
// The parser below is copied VERBATIM from app2/jobs/src/gmail/parse.ts (keep in step; test: native/supabase/tests/gmail_ingest_port.test.ts).
// ======================= parser (verbatim) =======================
// gmail-ingest: deterministic parser for LinkedIn notification emails. No LLM.
// Input is a Gmail message reduced to headers + text/html. Output is a typed event or 'unknown' with a reason.
export interface RawEmail {
  id: string;                     // Gmail message id (idempotency key)
  from: string;                   // From header, e.g. 'LinkedIn <invitations@linkedin.com>'
  subject: string;
  date: string;                   // RFC 2822 or ISO; the event time is the email's own time
  text?: string;
  html?: string;
  authResults?: string;           // Authentication-Results header, when present
}
export type IngestKind = 'accept' | 'reply' | 'invite_sent' | 'unknown';
export interface ParsedEvent {
  sourceMsgId: string;
  kind: IngestKind;
  at: string;                     // ISO timestamp
  name?: string;                  // display name as LinkedIn wrote it
  headline?: string;              // job line when present ("VP Engineering at Ostrevanthe Co")
  company?: string;
  profileUrl?: string;            // canonical https://www.linkedin.com/in/<vanity>
  vanity?: string;
  threadUrl?: string;
  snippet?: string;
  reason?: string;                // why unknown
}

const LINKEDIN_FROM = /@([a-z0-9-]+\.)*linkedin\.com>?\s*$/i;
const ACCEPT_SUBJ = [/^(.+?) accepted your invitation/i, /^(.+?) has accepted your invitation/i, /^You and (.+?) are now connected/i];
const REPLY_SUBJ = [/^(.+?) sent you a (?:new )?message/i, /^New message from (.+?)$/i, /^(.+?) just messaged you/i, /^(.+?) replied to your message/i,
  /^Re: .*?\bfrom (.+?)$/i];
const INVITE_SUBJ = [/^You invited (.+?) to connect/i];
const VIA_LINKEDIN = /^"?(.+?)"?\s+via LinkedIn\s*</i;

export function decodeEntities(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&nbsp;/g, ' ');
}
export function htmlToText(html: string): string {
  return decodeEntities(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

/** Profile URL from any LinkedIn link form: /in/<vanity>, /comm/in/<vanity>, with tracking params, url-encoded. */
export function extractProfile(body: string): { url: string; vanity: string } | undefined {
  const decoded = decodeEntities(body).replace(/%2F/gi, '/').replace(/%3A/gi, ':').replace(/%3F/gi, '?').replace(/%26/gi, '&').replace(/%3D/gi, '=').replace(/%23/gi, '#');
  const m = decoded.match(/https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:comm\/)?in\/([A-Za-z0-9\-_%.]+?)(?:[/?#"'\s<]|$)/i);
  if (!m || !m[1]) return undefined;
  const vanity = decodeURIComponent(m[1]).toLowerCase().replace(/\/$/, '');
  return { url: `https://www.linkedin.com/in/${vanity}`, vanity };
}
export function extractThread(body: string): string | undefined {
  const m = decodeEntities(body).match(/https?:\/\/(?:www\.)?linkedin\.com\/(?:comm\/)?messaging\/thread\/([A-Za-z0-9\-_=%.]+)/i);
  return m ? `https://www.linkedin.com/messaging/thread/${m[1]}` : undefined;
}
const firstMatch = (s: string, res: RegExp[]): string | undefined => {
  for (const r of res) { const m = s.match(r); if (m?.[1]) return m[1].trim(); }
  return undefined;
};
function toIso(d: string): string {
  const t = Date.parse(d);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
}
function headlineAfterName(text: string, name: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => l.toLowerCase() === name.toLowerCase());
  const next = i >= 0 ? lines[i + 1] : undefined;
  return next && next.length < 160 && !/linkedin|accept|view|message|unsubscribe/i.test(next) ? next : undefined;
}
function snippetFrom(text: string, name: string, headline?: string): string | undefined {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/^(view|reply|see|unsubscribe|this email|you are receiving|©|linkedin|help|learn why)/i.test(l) && !/https?:\/\//.test(l));
  const i = lines.findIndex((l) => l.toLowerCase().startsWith(name.toLowerCase()));
  const pick = (i >= 0 ? lines.slice(i + 1) : lines).find((l) => l.length > 3 && l.toLowerCase() !== name.toLowerCase() && l !== headline && !/^\S+ (sent you|just messaged)/i.test(l));
  return pick ? pick.slice(0, 280) : undefined;
}
export function companyFromHeadline(h?: string): string | undefined {
  const m = h?.match(/\s(?:at|@)\s+(.+)$/i);
  return m?.[1]?.trim();
}

export function parseLinkedInEmail(e: RawEmail): ParsedEvent {
  const base = { sourceMsgId: e.id, at: toIso(e.date) };
  if (!LINKEDIN_FROM.test(e.from)) return { ...base, kind: 'unknown', reason: 'not_from_linkedin' };
  if (e.authResults && !/dkim=pass[^;]*header\.(?:d|i)=@?(?:[a-z0-9-]+\.)*linkedin\.com/i.test(e.authResults)) {
    return { ...base, kind: 'unknown', reason: 'auth_fail' };
  }
  const body = (e.text ?? '') + '\n' + (e.html ?? '');
  const text = e.text?.trim() ? e.text : htmlToText(e.html ?? '');
  const prof = extractProfile(body);
  const subj = e.subject.trim();

  let name = firstMatch(subj, ACCEPT_SUBJ);
  if (name) {
    const headline = headlineAfterName(text, name);
    return { ...base, kind: 'accept', name, headline, company: companyFromHeadline(headline), profileUrl: prof?.url, vanity: prof?.vanity };
  }
  name = firstMatch(subj, REPLY_SUBJ) ?? e.from.match(VIA_LINKEDIN)?.[1]?.trim();
  if (name && (firstMatch(subj, REPLY_SUBJ) || /message/i.test(subj))) {
    const headline = headlineAfterName(text, name);
    return { ...base, kind: 'reply', name, headline, company: companyFromHeadline(headline), profileUrl: prof?.url, vanity: prof?.vanity,
      threadUrl: extractThread(body), snippet: snippetFrom(text, name, headline) };
  }
  name = firstMatch(subj, INVITE_SUBJ);
  if (name) return { ...base, kind: 'invite_sent', name, profileUrl: prof?.url, vanity: prof?.vanity };
  return { ...base, kind: 'unknown', reason: 'unrecognised_subject' };
}

// ======================= Gmail message JSON -> RawEmail (port of app2/jobs/src/gmail/fetch.ts gmailToRaw, Deno) =======================
const MAX_BODY = 200_000;
export function b64urlDecode(data: string): string {
  const s = data.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
// deno-lint-ignore no-explicit-any
type Part = any;
const header = (hs: Array<{ name: string; value: string }> | undefined, name: string): string | undefined =>
  hs?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
function collect(part: Part, out: { text: string[]; html: string[] }): void {
  if (!part) return;
  const isAttachment = !!part.filename || !!part.body?.attachmentId;
  if (!isAttachment && part.body?.data) {
    if (part.mimeType === 'text/plain') out.text.push(b64urlDecode(part.body.data));
    else if (part.mimeType === 'text/html') out.html.push(b64urlDecode(part.body.data));
  }
  for (const p of part.parts ?? []) collect(p, out);
}
export function gmailToRaw(m: Part): RawEmail {
  const hs = m.payload?.headers;
  const out = { text: [] as string[], html: [] as string[] };
  collect(m.payload, out);
  const auths = (hs ?? []).filter((h: { name: string }) => h.name.toLowerCase() === 'authentication-results').map((h: { value: string }) => h.value);
  const auth = auths.find((a: string) => /^\s*mx\.google\.com/i.test(a)) ?? auths[0];
  const dateHdr = header(hs, 'Date');
  const date = dateHdr && !Number.isNaN(Date.parse(dateHdr)) ? dateHdr
    : m.internalDate ? new Date(Number(m.internalDate)).toISOString() : (dateHdr ?? '');
  const text = out.text.join('\n').slice(0, MAX_BODY);
  const html = out.html.join('\n').slice(0, MAX_BODY);
  return { id: m.id, from: header(hs, 'From') ?? '', subject: header(hs, 'Subject') ?? '', date,
    text: text || undefined, html: html || undefined, authResults: auth };
}

/** Only these parsed fields ever leave the function: no body, headline, snippet or thread URL. */
export function toShadowRow(e: ParsedEvent): { msg_id: string; kind: string; profile_url: string | null; name: string | null; event_at: string } | null {
  if (e.kind !== 'accept' && e.kind !== 'reply') return null;
  return { msg_id: e.sourceMsgId, kind: e.kind, profile_url: e.profileUrl ?? null, name: e.name ?? null, event_at: e.at };
}

// LinkedIn notification senders only, accepts + messages. Gmail search does the sender filter; the parser re-checks sender + DKIM.
export const QUERY = 'from:linkedin.com (subject:accepted OR subject:connected OR subject:message OR subject:messaged OR subject:replied)';
export function buildQuery(cursorMs: number, nowMs: number): string {
  // forward-only cursor with a 1 h overlap (Gmail's after: is second-granular and mail can index late); first run reads 2 days
  const after = cursorMs > 0 ? Math.floor(cursorMs / 1000) - 3600 : Math.floor(nowMs / 1000) - 2 * 86400;
  return `${QUERY} after:${after}`;
}

// constant-time comparison (no early exit on the first differing byte)
export function safeEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length === y.length;
}

const MAX_MESSAGES = 200;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';

async function handle(req: Request): Promise<Response> {
  const url = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args),
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`${fn}: ${r.status}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  };
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  if (!safeEq(req.headers.get('x-ari-hook'), await rpc('ari_gmail_hook'))) return new Response('unauthorized', { status: 401 });

  const cfg = await rpc('ari_gmail_ingest_config');
  if (cfg?.status !== 'connected' || !cfg.refresh_token) return Response.json({ skipped: cfg?.status ?? 'disconnected' });
  try {
    const cid = Deno.env.get('ARI_GMAIL_CLIENT_ID'), csec = Deno.env.get('ARI_GMAIL_CLIENT_SECRET');
    if (!cid || !csec) throw new Error('oauth client not configured');
    const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
      body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: cfg.refresh_token, grant_type: 'refresh_token' }) });
    const tj = await tr.json().catch(() => ({}));
    if (!tr.ok || !tj.access_token) {
      const reconnect = tj.error === 'invalid_grant';
      await rpc('ari_gmail_ingest_fail', { p_error: `token ${tr.status} ${tj.error ?? ''}`.trim(), p_reconnect: reconnect });
      return Response.json({ ok: false, reconnect }, { status: 200 });
    }
    const auth = { Authorization: `Bearer ${tj.access_token}` };
    const q = buildQuery(Number(cfg.cursor_ms ?? 0), Date.now());
    const ids: string[] = []; let token: string | undefined;
    do {
      const u = new URL(`${GMAIL}/messages`); u.searchParams.set('q', q); u.searchParams.set('maxResults', '100');
      if (token) u.searchParams.set('pageToken', token);
      const r = await fetch(u, { headers: auth });
      if (!r.ok) throw new Error(`list ${r.status}`);
      const j = await r.json(); for (const m of j.messages ?? []) ids.push(m.id); token = j.nextPageToken;
    } while (token && ids.length < MAX_MESSAGES);
    const known = new Set<string>(ids.length ? await rpc('ari_gmail_known_ids', { p_ids: ids }) : []);
    const events: unknown[] = []; let cursor = 0, fetched = 0;
    for (const id of ids.slice(0, MAX_MESSAGES)) {
      if (known.has(id)) continue;
      const r = await fetch(`${GMAIL}/messages/${encodeURIComponent(id)}?format=full`, { headers: auth });
      if (r.status === 404) continue;
      if (!r.ok) throw new Error(`get ${r.status}`);
      const m = await r.json(); fetched++;
      if ((m.labelIds ?? []).some((l: string) => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT' || l === 'SENT')) continue;
      cursor = Math.max(cursor, Number(m.internalDate ?? 0));
      const row = toShadowRow(parseLinkedInEmail(gmailToRaw(m)));   // body is parsed in memory and dropped here
      if (row) events.push(row);
    }
    // truncated pass: do not move the cursor past what was not read
    const res = await rpc('ari_gmail_ingest_record', { p_events: events, p_cursor_ms: ids.length > MAX_MESSAGES ? 0 : cursor,
      p_listed: ids.length, p_fetched: fetched });
    return Response.json({ ok: true, listed: ids.length, fetched, stored: res?.stored ?? 0 });
  } catch (e) {
    await rpc('ari_gmail_ingest_fail', { p_error: String((e as Error)?.message ?? e).slice(0, 200), p_reconnect: false }).catch(() => {});
    return Response.json({ ok: false }, { status: 200 });
  }
}

if (typeof Deno !== 'undefined' && (Deno as { serve?: unknown }).serve) {
  Deno.serve((req) => handle(req).catch(() => new Response('error', { status: 500 })));
}
