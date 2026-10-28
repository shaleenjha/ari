// ari-ai (PENDING). Database access: PostgREST RPCs only, through an ALLOWLIST. The function's own named secret key ari_ai
// (S1 R7 pattern: sb_secret_ key, apikey header only, no legacy fallback) for service RPCs; the caller's own JWT for the one
// owner check. No table writes, no app_config / app_changes access: the allowlist below is the whole write surface.
import { guardedFetch } from '../_shared/ai/http.ts';
import type { Ledger } from '../_shared/ai/run.ts';

export const SERVICE_RPCS = [
  'ari_ai_hook', 'ari_ai_budget_reserve', 'ari_ai_call_finish', 'ari_ai_budget_headroom', 'ari_ai_context', 'ari_ai_reply_context',
  'ari_ai_save_draft', 'ari_ai_save_triage', 'ari_ai_save_reply_draft', 'ari_ai_save_research', 'ari_ai_job_enqueue',
  'ari_ai_job_claim', 'ari_ai_job_update', 'ari_ai_job_event', 'ari_ai_job_events', 'ari_ai_trigger_claim', 'ari_ai_trigger_done', 'ari_ai_pending_events',
  'ari_ai_notify_dm_ready', 'ari_ai_import_book',
  // 0047 pipeline job line
  'ari_pipeline_enqueue', 'ari_pipeline_read', 'ari_pipeline_start', 'ari_pipeline_finish', 'ari_pipeline_brief_context',
  'ari_pipeline_brief_write', 'ari_pipeline_save_checks', 'ari_pipeline_fact_get', 'ari_pipeline_fact_put',
] as const;
export type ServiceRpc = typeof SERVICE_RPCS[number];

// S1 R7: this function's own named secret key, sent as apikey ONLY (an sb_secret_ key is not a JWT). Supabase injects
// SUPABASE_SECRET_KEYS (JSON, name -> key); otherwise the deploy sets ARI_SK_<NAME>. Never the legacy service role key.
export function secretKey(name: string): string {
  let all: Record<string, string> = {};
  try { all = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'); } catch { all = {}; }
  const k = all[name] ?? Deno.env.get(`ARI_SK_${name.toUpperCase()}`);
  if (!k || !k.startsWith('sb_secret_')) throw new Error(`secret key ${name} missing`);
  return k;
}
/** Public by design (the app ships it). Used only to call ari_ai_caller() as the signed-in user. */
export function publishableKey(): string {
  let all: Record<string, string> = {};
  try { all = JSON.parse(Deno.env.get('SUPABASE_PUBLISHABLE_KEYS') ?? '{}'); } catch { all = {}; }
  const k = all['default'] ?? Object.values(all)[0] ?? Deno.env.get('ARI_PUBLISHABLE_KEY');
  if (!k || !k.startsWith('sb_publishable_')) throw new Error('publishable key missing');
  return k;
}

export interface Db {
  rpc<T = unknown>(fn: ServiceRpc, args?: Record<string, unknown>): Promise<T>;
  isOwner(userJwt: string): Promise<boolean>;
}

export class RpcError extends Error { constructor(public fn: string, public status: number, public code?: string) { super(`${fn}: ${status}${code ? ' ' + code : ''}`); } }

export function restDb(url = Deno.env.get('SUPABASE_URL') ?? ''): Db {
  const key = secretKey('ari_ai');
  return {
    async rpc<T>(fn: ServiceRpc, args: Record<string, unknown> = {}): Promise<T> {
      if (!(SERVICE_RPCS as readonly string[]).includes(fn)) throw new Error(`rpc not allowed: ${fn}`);
      let r: Response;
      try {
        r = await guardedFetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args),
          headers: { apikey: key, 'Content-Type': 'application/json' } }, { timeoutMs: 10_000, retries: 0 });
      } catch (e) {
        // PostgREST errors arrive as non-2xx: surface the SQLSTATE only (no row data)
        throw new RpcError(fn, (e as { status?: number }).status ?? 0);
      }
      const t = await r.text(); return (t ? JSON.parse(t) : null) as T;
    },
    async isOwner(jwt: string): Promise<boolean> {
      if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(jwt)) return false;
      try {
        const r = await guardedFetch(`${url}/rest/v1/rpc/ari_ai_caller`, { method: 'POST', body: '{}',
          headers: { apikey: publishableKey(), Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' } }, { timeoutMs: 8_000, retries: 0 });
        const j = await r.json();
        return j?.owner === true;
      } catch { return false; }
    },
  };
}

/** The spend ledger (ai_calls + caps) over the allowlisted RPCs. */
export function ledgerFor(db: Db): Ledger & { headroom(): Promise<{ enabled: boolean; month_left: number; day_left: number }> } {
  return {
    async reserve(a) {
      const r = await db.rpc<{ ok: boolean; call_id?: number; reason?: string }>('ari_ai_budget_reserve', { p_task: a.task,
        p_provider: a.provider, p_model: a.model, p_est: a.estUsd, p_person: a.personId ?? null, p_account: a.accountId ?? null,
        p_job: a.jobId ?? null, p_request_key: a.requestKey ?? null });
      return { ok: !!r?.ok, callId: r?.call_id, reason: r?.reason };
    },
    async finish(id, a) {
      await db.rpc('ari_ai_call_finish', { p_id: id, p_status: a.status, p_in: a.tokensIn, p_out: a.tokensOut, p_cost: a.costUsd,
        p_error: a.error ?? null });
    },
    async headroom() {
      const h = await db.rpc<{ enabled: boolean; month_left: number; day_left: number }>('ari_ai_budget_headroom');
      return { enabled: !!h?.enabled, month_left: Number(h?.month_left ?? 0), day_left: Number(h?.day_left ?? 0) };
    },
  };
}
