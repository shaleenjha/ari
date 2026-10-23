// ari-gmail-push edge function (PENDING, not deployed; S1 R7 must be live first: it reads its own named secret key
// ari_gmail_push, apikey header only, no legacy fallback). Platform wiring only; logic in handler.ts (offline-tested).
// Deploy with Verify JWT OFF: Pub/Sub's Google OIDC token and the x-ari-hook secret are checked in code.
// Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (or ARI_SK_ARI_GMAIL_PUSH), ARI_GMAIL_CLIENT_ID, ARI_GMAIL_CLIENT_SECRET (same OAuth
// client as ari-gmail-ingest). Setup: native/supabase/functions/README.md, "Gmail push (Pub/Sub)".
import { guardedFetch } from '../_shared/ai/http.ts';
import { GOOGLE_JWKS } from './oidc.ts';
import { handlePush, PUSH_RPCS, PushEnv, PushRpc } from './handler.ts';

// S1 R7: this function's own named secret key (sb_secret_), apikey header only. Never the legacy service role key.
function secretKey(name: string): string {
  let all: Record<string, string> = {};
  try { all = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'); } catch { all = {}; }
  const k = all[name] ?? Deno.env.get(`ARI_SK_${name.toUpperCase()}`);
  if (!k || !k.startsWith('sb_secret_')) throw new Error(`secret key ${name} missing`);
  return k;
}

const url = Deno.env.get('SUPABASE_URL') ?? '';
// deno-lint-ignore no-explicit-any
const rt = (globalThis as any).EdgeRuntime;

Deno.serve(async (req) => {
  try {
    const key = secretKey('ari_gmail_push');
    const env: PushEnv = {
      async rpc<T>(fn: PushRpc, args: Record<string, unknown> = {}): Promise<T> {
        if (!(PUSH_RPCS as readonly string[]).includes(fn)) throw new Error(`rpc not allowed: ${fn}`);
        const r = await guardedFetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args),
          headers: { apikey: key, 'Content-Type': 'application/json' } }, { timeoutMs: 10_000, retries: 0 });
        const t = await r.text(); return (t ? JSON.parse(t) : null) as T;
      },
      jwks: async () => (await (await guardedFetch(GOOGLE_JWKS, {}, { timeoutMs: 5_000 })).json()).keys ?? [],
      callFn: async (slug, hookSecret, body) => {
        const r = await guardedFetch(`${url}/functions/v1/${slug}`, { method: 'POST', body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', 'x-ari-hook': hookSecret } }, { timeoutMs: 60_000, retries: 0 }).catch(() => null);
        await r?.body?.cancel().catch(() => {});
        return r?.status ?? 0;
      },
      googleToken: async (refresh) => {
        const cid = Deno.env.get('ARI_GMAIL_CLIENT_ID'), csec = Deno.env.get('ARI_GMAIL_CLIENT_SECRET');
        if (!cid || !csec) return null;
        const r = await guardedFetch('https://oauth2.googleapis.com/token', { method: 'POST',
          body: new URLSearchParams({ client_id: cid, client_secret: csec, refresh_token: refresh, grant_type: 'refresh_token' }) },
          { timeoutMs: 10_000 }).catch(() => null);
        const j = r ? await r.json().catch(() => ({})) : {};
        return typeof j.access_token === 'string' ? j.access_token : null;
      },
      gmailWatch: async (at, topic) => {
        const r = await guardedFetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', { method: 'POST',
          headers: { Authorization: `Bearer ${at}`, 'content-type': 'application/json' },
          body: JSON.stringify({ topicName: topic, labelIds: ['INBOX'], labelFilterBehavior: 'include' }) }, { timeoutMs: 10_000 });
        return await r.json();
      },
      background: (p) => { const q = p.catch(() => {}); if (rt?.waitUntil) rt.waitUntil(q); },
    };
    return await handlePush(req, env);
  } catch { return new Response('error', { status: 500 }); }
});
