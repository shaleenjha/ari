// S1 R7 (PENDING, not deployed): reads its own named secret key ari_gmail_oauth (apikey header only) instead of the legacy
// SUPABASE_SERVICE_ROLE_KEY. Deploy staging first (work/r7/runbook.md step b); the live source is ../../ari-gmail-oauth/index.ts.
// Ari v18.8.1: ari-gmail-oauth edge function (Supabase, Deno). Connects Owner's Gmail READ-ONLY for shadow ingest.
//   GET .../ari-gmail-oauth/start?t=<ticket>  ticket = one-time, 10-minute value the app gets from rpc ari_gmail_connect_ticket
//                                              (owner only). Stores state + PKCE verifier, redirects to Google consent.
//   GET .../ari-gmail-oauth/callback          Google redirect: one-time state, code exchange with the PKCE verifier, checks the
//                                              granted scope is exactly gmail.readonly, reads the address (users.getProfile),
//                                              allowlist owner@example.com only (else the grant is revoked at Google),
//                                              refresh token -> Supabase Vault via rpc ari_gmail_connect. Nothing is logged.
// Deploy with Verify JWT OFF (a browser navigation carries no JWT; the ticket + state are the authentication).
// Secrets: ARI_GMAIL_CLIENT_ID / ARI_GMAIL_CLIENT_SECRET (function secrets). Never echoed in any response.
// v18.10.1: every browser outcome is a 302 back to the app (/ops?gmail=connected | /ops?gmail=failed&r=<reason>), because the
// platform serves function HTML as text/plain (Owner saw raw HTML after connecting). The app shows the result as a toast.

export const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
// The one mailbox allowed to connect comes from function secret ARI_GMAIL_ALLOW (no address in code); empty = nobody.
export const ALLOW = (typeof Deno !== 'undefined' && Deno.env?.get('ARI_GMAIL_ALLOW')) || '';
const APP = 'https://ari-web.vercel.app/ops';

export function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export const rand = (n: number) => b64u(crypto.getRandomValues(new Uint8Array(n)));
export async function challenge(verifier: string): Promise<string> {
  return b64u(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
}
export function safeEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length === y.length;
}
/** Granted scopes must be exactly gmail.readonly (Google may list scopes space-separated). */
export function scopeOk(granted: string | undefined): boolean {
  const s = (granted ?? '').split(/\s+/).filter(Boolean);
  return s.length === 1 && s[0] === SCOPE;
}

export const REASONS = ['expired', 'denied', 'google', 'scope', 'account', 'retry', 'setup', 'error'] as const;
export function backTo(r: string | null): string {
  if (!r) return `${APP}?gmail=connected`;
  return `${APP}?gmail=failed&r=${(REASONS as readonly string[]).includes(r) ? r : 'error'}`;
}
const back = (r: string | null) => new Response(null, { status: 302, headers: { location: backTo(r), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
// S1 R7 (Oct 2026): this function's own named secret key, sent as apikey ONLY (an sb_secret_ key is not a JWT; the
// gateway turns it into the internal service token). Supabase injects SUPABASE_SECRET_KEYS (JSON, name -> key); if a
// project does not, the deploy sets ARI_SK_<NAME> as a function secret instead. Never falls back to the legacy
// SUPABASE_SERVICE_ROLE_KEY. Function secrets are project-wide, so per-function keys buy separate revocation and
// attribution, not isolation.
function secretKey(name: string): string {
  let all: Record<string, string> = {};
  try { all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); } catch { all = {}; }
  const k = all[name] ?? Deno.env.get(`ARI_SK_${name.toUpperCase()}`);
  if (!k || !k.startsWith("sb_secret_")) throw new Error(`secret key ${name} missing`);
  return k;
}

async function handle(req: Request): Promise<Response> {
  const url = Deno.env.get('SUPABASE_URL')!, key = secretKey('ari_gmail_oauth');
  const cid = Deno.env.get('ARI_GMAIL_CLIENT_ID'), csec = Deno.env.get('ARI_GMAIL_CLIENT_SECRET');
  const rpc = async (fn: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args),
      headers: { apikey: key, 'Content-Type': 'application/json' } });
    if (!r.ok) throw new Error(`${fn}: ${r.status}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  };
  const u = new URL(req.url);
  const redirectUri = `${url}/functions/v1/ari-gmail-oauth/callback`;
  if (req.method !== 'GET') return new Response('method not allowed', { status: 405 });
  if (!cid || !csec) return back('setup');

  if (u.pathname.endsWith('/start')) {
    const t = u.searchParams.get('t') ?? '';
    if (!/^[0-9a-f]{48}$/.test(t) || !(await rpc('ari_gmail_ticket_take', { p_ticket: t }))) {
      return back('expired');
    }
    const state = rand(32), verifier = rand(48);
    await rpc('ari_gmail_state_put', { p_state: state, p_verifier: verifier });
    const g = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    g.search = new URLSearchParams({ client_id: cid, redirect_uri: redirectUri, response_type: 'code', scope: SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', login_hint: ALLOW, state,
      code_challenge: await challenge(verifier), code_challenge_method: 'S256' }).toString();
    return new Response(null, { status: 302, headers: { location: g.toString(), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }

  if (u.pathname.endsWith('/callback')) {
    const state = u.searchParams.get('state') ?? '', code = u.searchParams.get('code') ?? '';
    if (u.searchParams.get('error')) return back('denied');
    const verifier = state && code ? await rpc('ari_gmail_state_take', { p_state: state }) : null;
    if (!verifier) return back('expired');
    const tr = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({
      code, client_id: cid, client_secret: csec, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verifier }) });
    const tj = await tr.json().catch(() => ({}));
    if (!tr.ok || !tj.access_token) return back('google');
    const revoke = () => fetch('https://oauth2.googleapis.com/revoke', { method: 'POST',
      body: new URLSearchParams({ token: tj.refresh_token ?? tj.access_token }) }).catch(() => {});
    if (!scopeOk(tj.scope)) { await revoke(); return back('scope'); }
    const pr = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${tj.access_token}` } });
    const email = String((await pr.json().catch(() => ({}))).emailAddress ?? '').toLowerCase();
    if (!ALLOW) { console.error('ARI_GMAIL_ALLOW is not set'); await revoke(); return back('setup'); }
    if (!pr.ok || !safeEq(email, ALLOW)) { await revoke(); return back('account'); }
    if (!tj.refresh_token) return back('retry');
    await rpc('ari_gmail_connect', { p_address: email, p_refresh_token: tj.refresh_token });
    return back(null);
  }
  return new Response('not found', { status: 404 });
}

if (typeof Deno !== 'undefined' && (Deno as { serve?: unknown }).serve) {
  Deno.serve((req) => handle(req).catch(() => back('error')));
}
