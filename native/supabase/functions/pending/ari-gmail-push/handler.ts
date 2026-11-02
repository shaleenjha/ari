// ari-gmail-push request handler (PENDING; wiring in index.ts). Two callers:
//  1. Google Pub/Sub push (Gmail users.watch on Owner's mailbox): verify the OIDC token, check the mailbox is the allowlisted
//     address, answer 204 at once, then in the background run ari-gmail-ingest NOW (same x-ari-hook the cron uses) and
//     then ari-ai {internal: "process"} (classify -> draft_dm1 -> "DM1 ready"). The push body carries only an address and a
//     history id; mail is still read only by ari-gmail-ingest, which keeps parsed fields only.
//  2. pg_cron 'ari-gmail-watch-renew' (x-ari-hook = vault ari_ai_hook_secret): users.watch again (a watch lasts 7 days).
// Idempotent by construction: ingest dedupes by Gmail message id, ari-ai claims (accept, msg id) and (dm1, person) once.
import { safeEq } from '../_shared/ai/http.ts';
import { verifyPubsubJwt, JwksFetch } from './oidc.ts';

export const ALLOW = 'owner@example.com';
export const PUSH_RPCS = ['ari_ai_hook', 'ari_gmail_hook', 'ari_gmail_push_config', 'ari_gmail_watch_set', 'ari_gmail_watch_push',
  'ari_gmail_ingest_config'] as const;
export type PushRpc = typeof PUSH_RPCS[number];

export interface PushEnv {
  rpc<T = unknown>(fn: PushRpc, args?: Record<string, unknown>): Promise<T>;
  jwks: JwksFetch;
  callFn: (slug: 'ari-gmail-ingest' | 'ari-ai', hookSecret: string, body: Record<string, unknown>) => Promise<number>;
  googleToken: (refreshToken: string) => Promise<string | null>;
  gmailWatch: (accessToken: string, topic: string) => Promise<{ historyId?: string; expiration?: string }>;
  background: (p: Promise<unknown>) => void;
  now?: () => number;
}

export function decodePush(body: unknown): { emailAddress: string; historyId: string } | null {
  // deno-lint-ignore no-explicit-any
  const data = (body as any)?.message?.data;
  if (typeof data !== 'string' || data.length > 4096) return null;
  try {
    const j = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0))));
    if (typeof j?.emailAddress !== 'string') return null;
    return { emailAddress: j.emailAddress.toLowerCase(), historyId: String(j.historyId ?? '') };
  } catch { return null; }
}

export async function handlePush(req: Request, env: PushEnv): Promise<Response> {
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405 });
  const raw = await req.text();
  if (raw.length > 16_384) return new Response('too large', { status: 413 });
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(raw || '{}'); } catch { return new Response('bad request', { status: 400 }); }

  const hook = req.headers.get('x-ari-hook');
  if (hook !== null) {                                                       // cron: renew the watch
    if (!safeEq(hook, await env.rpc<string>('ari_ai_hook'))) return new Response('unauthorized', { status: 401 });
    if (body.internal !== 'renew_watch') return new Response('bad request', { status: 400 });
    return Response.json(await renewWatch(env));
  }

  // Pub/Sub push
  const cfg = await env.rpc<{ topic?: string; audience?: string; sa_email?: string }>('ari_gmail_push_config');
  if (!cfg?.audience || !cfg?.sa_email) return new Response('not configured', { status: 503 });
  const auth = req.headers.get('authorization') ?? '';
  const tok = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const v = tok ? await verifyPubsubJwt(tok, { audience: cfg.audience, email: cfg.sa_email }, env.jwks,
    Math.floor((env.now?.() ?? Date.now()) / 1000)) : { ok: false as const, why: 'missing' };
  if (!v.ok) return new Response('unauthorized', { status: 401 });
  const msg = decodePush(body);
  if (!msg) return new Response(null, { status: 204 });                     // ack malformed so Pub/Sub does not redeliver forever
  if (msg.emailAddress !== ALLOW) return new Response(null, { status: 204 });   // not Owner's mailbox: ack and ignore
  await env.rpc('ari_gmail_watch_push', { p_history_id: msg.historyId });
  env.background((async () => {
    const gh = await env.rpc<string>('ari_gmail_hook');
    await env.callFn('ari-gmail-ingest', gh, { source: 'push' });              // waits for ingest to finish (it returns after)
    await env.callFn('ari-ai', await env.rpc<string>('ari_ai_hook'), { internal: 'process' });
  })());
  return new Response(null, { status: 204 });
}

export async function renewWatch(env: PushEnv): Promise<{ ok: boolean; reason?: string }> {
  const cfg = await env.rpc<{ topic?: string }>('ari_gmail_push_config');
  if (!cfg?.topic) return { ok: false, reason: 'no_topic' };
  const g = await env.rpc<{ status?: string; refresh_token?: string }>('ari_gmail_ingest_config');
  if (g?.status !== 'connected' || !g.refresh_token) return { ok: false, reason: 'disconnected' };
  try {
    const at = await env.googleToken(g.refresh_token);
    if (!at) throw new Error('token');
    const w = await env.gmailWatch(at, cfg.topic);
    await env.rpc('ari_gmail_watch_set', { p_history_id: w.historyId ?? null, p_expires_ms: Number(w.expiration ?? 0), p_error: null });
    return { ok: true };
  } catch (e) {
    await env.rpc('ari_gmail_watch_set', { p_history_id: null, p_expires_ms: 0, p_error: String((e as Error)?.message ?? e).slice(0, 120) });
    return { ok: false, reason: 'renew_failed' };
  }
}
