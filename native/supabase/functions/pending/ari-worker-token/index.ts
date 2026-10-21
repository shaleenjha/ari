// ari-worker-token (S1 R7, design D; PENDING, not deployed). The worker's token broker.
// Called ONLY on the functions host: POST https://<ref>.functions.supabase.co/ari-worker-token
// Deploy with Verify JWT OFF (the caller has no Supabase token yet; this function checks its own caller).
//
// 1. Kill switch: env ARI_BROKER_DISABLED=1 refuses everything (503) without touching Auth.
// 2. Caller: header x-ari-worker-caller must equal env ARI_WORKER_CALLER_SECRET (constant-time). In Hark the sandbox
//    proxy injects it on the functions host only, so it never rides on PostgREST calls. Wrong or missing: 401, not logged
//    (anyone on the internet can hit this URL; logging them would let them fill the table and spam Owner).
// 3. Gate: rpc ari_broker_gate (migration 0040) decides in one transaction: broker enabled, inside the worker windows,
//    fewer than max_per_hour mints in the last hour. Every gate call is logged (time, request id, outcome, reason).
//    A refusal also queues ONE generic push to Owner per hour (kind ops_alert, no infrastructure words).
// 4. Sign-in: password grant for the worker Auth user (env ARI_WORKER_EMAIL / ARI_WORKER_PASSWORD; the password exists
//    only as this function's secret). Auth issues a 1-hour ES256 token whose role claim is ari_worker.
// 5. The token is checked (ES256, role ari_worker, sub = ARI_WORKER_UID, ttl <= 1 h) and only the access token and its
//    expiry are returned. The refresh token is dropped and never leaves this function.
// It uses its own named secret key ari_worker_token (apikey only) for the gate RPC and the Auth call.
import { checkToken, parseGate, safeEq } from "./guard.ts";

function secretKey(name: string): string {
  let all: Record<string, string> = {};
  try { all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"); } catch { all = {}; }
  const k = all[name] ?? Deno.env.get(`ARI_SK_${name.toUpperCase()}`);
  if (!k || !k.startsWith("sb_secret_")) throw new Error(`secret key ${name} missing`);
  return k;
}

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function handle(req: Request, env = (k: string) => Deno.env.get(k), now = () => Date.now()): Promise<Response> {
  if (env("ARI_BROKER_DISABLED") === "1") return json(503, { error: "disabled" });
  if (req.method !== "POST") return json(405, { error: "method not allowed" });
  if (!safeEq(req.headers.get("x-ari-worker-caller"), env("ARI_WORKER_CALLER_SECRET"))) return json(401, { error: "unauthorized" });

  const url = env("SUPABASE_URL")!, key = secretKey("ari_worker_token");
  const rid = crypto.randomUUID();
  const rpc = async (fn: string, args: Record<string, unknown>) => {
    const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: "POST", body: JSON.stringify(args),
      headers: { apikey: key, "Content-Type": "application/json" } });
    if (!r.ok) throw new Error(`${fn}: ${r.status}`);
    const t = await r.text(); return t ? JSON.parse(t) : null;
  };

  const gate = parseGate(await rpc("ari_broker_gate", { p_request_id: rid }));
  if (!gate.allow) return json(403, { error: "refused", reason: gate.reason, request_id: rid });

  const email = env("ARI_WORKER_EMAIL"), password = env("ARI_WORKER_PASSWORD"), uid = env("ARI_WORKER_UID") ?? "";
  if (!email || !password || !uid) {
    await rpc("ari_broker_note", { p_request_id: rid, p_outcome: "error", p_reason: "broker not configured" });
    return json(500, { error: "not configured", request_id: rid });
  }
  const r = await fetch(`${url}/auth/v1/token?grant_type=password`, { method: "POST",
    headers: { apikey: key, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
  if (!r.ok) {
    await rpc("ari_broker_note", { p_request_id: rid, p_outcome: "error", p_reason: `auth ${r.status}` });
    return json(502, { error: "sign-in failed", status: r.status, request_id: rid });
  }
  const s = await r.json();
  const c = checkToken(s?.access_token ?? "", uid, Math.floor(now() / 1000));
  if (!c.ok) {
    await rpc("ari_broker_note", { p_request_id: rid, p_outcome: "error", p_reason: `bad token: ${c.reason}` });
    return json(502, { error: "unexpected token", reason: c.reason, request_id: rid });
  }
  await rpc("ari_broker_note", { p_request_id: rid, p_outcome: "minted", p_reason: null });
  return json(200, { access_token: s.access_token, expires_at: c.exp, request_id: rid });
}

// Tests import this module with ARI_BROKER_TEST=1 so no server starts.
if (typeof Deno !== "undefined" && Deno.serve && Deno.env.get("ARI_BROKER_TEST") !== "1") {
  Deno.serve(async (req) => {
    try { return await handle(req); }
    catch (e) { return json(500, { error: String(e).slice(0, 200) }); }
  });
}
