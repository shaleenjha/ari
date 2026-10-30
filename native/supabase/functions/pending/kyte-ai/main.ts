// kyte-ai edge function body (PENDING; was ari-ai until Oct 30 2026, naming plan A+). Platform wiring only; the request
// handling is in handler.ts (offline-tested). Two entry points serve it: kyte-ai/index.ts (slug kyte-ai) and the legacy
// alias ari-ai/index.ts (slug ari-ai: staging runs it, and the database kicks in 0041/0047 plus ari-gmail-push call that
// slug). Deploy with Verify JWT OFF. Env: SUPABASE_URL, SUPABASE_SECRET_KEYS (or ARI_SK_ARI_AI) with the named key ari_ai,
// SUPABASE_PUBLISHABLE_KEYS (or ARI_PUBLISHABLE_KEY), ANTHROPIC_API_KEY, XAI_API_KEY, ARI_APP_ORIGINS. Legacy ari names:
// docs/engineering/code-names.md.
import { guardedFetch } from '../_shared/ai/http.ts';
import { ledgerFor, restDb } from './db.ts';
import { Env, handle } from './handler.ts';

const url = Deno.env.get('SUPABASE_URL') ?? '';
const origins = (Deno.env.get('ARI_APP_ORIGINS') ?? 'https://ari-web.vercel.app').split(',').map((s) => s.trim()).filter(Boolean);
// deno-lint-ignore no-explicit-any
const rt = (globalThis as any).EdgeRuntime;

/** The slugs this code is deployed under; kicks go back to the same slug, so each deployment only ever calls itself. */
export type AiSlug = 'kyte-ai' | 'ari-ai';

/** keyCheck: the entry point's secretKey('ari_ai') call; it throws (500, fail closed) when the named key is missing. */
export function serveAi(slug: AiSlug, keyCheck: () => unknown): void {
  Deno.serve(async (req) => {
    try {
      keyCheck();                                           // fail closed before anything else when the named key is missing
      const db = restDb(url);
      const env: Env = {
        db, deps: { ledger: ledgerFor(db) }, origins,
        background: (p) => { const q = p.catch(() => {}); if (rt?.waitUntil) rt.waitUntil(q); },
        kick: async (b) => {
          const secret = await db.rpc<string>('ari_ai_hook');
          const r = await guardedFetch(`${url}/functions/v1/${slug}`, { method: 'POST', body: JSON.stringify(b),
            headers: { 'content-type': 'application/json', 'x-ari-hook': secret } }, { timeoutMs: 8_000, retries: 1 }).catch(() => null);
          await r?.body?.cancel().catch(() => {});
        },
      };
      return await handle(req, env);
    } catch { return Response.json({ error: 'failed' }, { status: 500 }); }
  });
}
