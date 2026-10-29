// Live AI layer (PENDING). The ONLY network path the AI layer uses. Two guarantees live here:
//  1. Host allowlist: model providers, this project's own Supabase host and Google (Gmail / OAuth / certs). LinkedIn (or any
//     other host) is refused before a socket opens, so no code path in ari-ai or ari-gmail-push can send to LinkedIn.
//  2. Timeout per attempt and exactly ONE retry, only on a network error, a timeout, 429 or 5xx.
// Keys are passed in headers by the caller and never appear in an error message (errors carry host + status only).

export const PROVIDER_HOSTS = ['api.anthropic.com', 'api.x.ai', 'api.openai.com'] as const;
const GOOGLE_HOSTS = ['gmail.googleapis.com', 'oauth2.googleapis.com', 'www.googleapis.com'];
// Lookups for import fixes: a licensed people-data vendor and a search-engine API. Never LinkedIn itself (a search engine
// returns public result titles and URLs; no request ever reaches linkedin.com).
// Fact check (Oct 28 2026): Parallel Decisions API, sent only public company-level claims (see factcheck.ts).
export const DATA_HOSTS = ['api.lemlist.com', 'api.search.brave.com', 'api.parallel.ai'] as const;

export function allowedHost(url: string, supabaseUrl = safeEnv('SUPABASE_URL')): boolean {
  let h: string;
  try { const u = new URL(url); if (u.protocol !== 'https:') return false; h = u.hostname.toLowerCase(); } catch { return false; }
  if (/(^|\.)linkedin\.com$|(^|\.)licdn\.com$|(^|\.)lnkd\.in$/.test(h)) return false;   // explicit, belt and braces
  if ((PROVIDER_HOSTS as readonly string[]).includes(h) || GOOGLE_HOSTS.includes(h) || (DATA_HOSTS as readonly string[]).includes(h)) return true;
  if (supabaseUrl) {
    try {
      const own = new URL(supabaseUrl).hostname.toLowerCase();               // <ref>.supabase.co
      const ref = own.split('.')[0];
      if (h === own || h === `${ref}.functions.supabase.co`) return true;
    } catch { /* no own host */ }
  }
  return false;
}

function safeEnv(k: string): string | undefined {
  try { return typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined; } catch { return undefined; }
}

export class HttpError extends Error {
  constructor(public status: number, public host: string, public retryable: boolean, msg: string, public detail = '') { super(msg); }
}

/** The provider's own error text (Anthropic / xAI / OpenAI {"error": {"message"}} or {"message"}), short, with anything key-like
 *  redacted, so the ledger says "credit balance is too low" instead of a bare 400. Never returned to the app (errorBody maps errors
 *  to fixed codes). */
export async function providerMessage(r: Response): Promise<string> {
  let t = '';
  try { t = (await r.text()).slice(0, 4000); } catch { return ''; }
  let m = t;
  try { const j = JSON.parse(t); m = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : '') ?? ''; } catch { /* not JSON */ }
  return String(m).replace(/\s+/g, ' ').replace(/(sk|xai|key|sb_secret|sb_publishable|Bearer)[-_ ][A-Za-z0-9_.-]{6,}/gi, '[redacted]')
    .replace(/<[^>]*>/g, ' ').trim().slice(0, 160);
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let impl: FetchLike = (u, i) => fetch(u, i);
/** Tests swap the transport; production never calls this. */
export function setTransport(f: FetchLike | null): void { impl = f ?? ((u, i) => fetch(u, i)); }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fetch with host allowlist, per-attempt timeout and one retry. Returns the Response for 2xx; throws HttpError otherwise. */
export async function guardedFetch(url: string, init: RequestInit, opt: { timeoutMs: number; retries?: number }): Promise<Response> {
  if (!allowedHost(url)) throw new HttpError(0, hostOf(url), false, `host not allowed: ${hostOf(url)}`);
  const retries = opt.retries ?? 1;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), opt.timeoutMs);
    try {
      const r = await impl(url, { ...init, signal: ac.signal });
      clearTimeout(t);                     // a stream's idle timeout is the reader's job (providers.ts readSse)
      if (r.ok) return r;
      // 4xx other than 429 is never retried (a bad request or an empty credit balance will not fix itself); 429 / 5xx once.
      const retryable = r.status === 429 || r.status >= 500;
      const detail = await providerMessage(r);
      last = new HttpError(r.status, hostOf(url), retryable, `${hostOf(url)} ${r.status}${detail ? ': ' + detail : ''}`, detail);
      if (!retryable) throw last;
    } catch (e) {
      clearTimeout(t);
      if (e instanceof HttpError && !e.retryable) throw e;
      last = e instanceof HttpError ? e : new HttpError(0, hostOf(url), true, `${hostOf(url)} ${(e as Error)?.name === 'AbortError' ? 'timeout' : 'network error'}`);
    }
    if (attempt < retries) await sleep(400 + Math.floor(Math.random() * 400));
  }
  throw last;
}

function hostOf(url: string): string { try { return new URL(url).hostname; } catch { return 'invalid-url'; } }

/** constant-time comparison for hook secrets (no early exit on the first differing byte) */
export function safeEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length === y.length;
}
