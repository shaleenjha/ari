// ari-worker-token guard logic (S1 R7, design D). Pure functions, no Deno APIs, so deno test runs them offline.

export const EXPECT_ROLE = "ari_worker";
export const MAX_TTL = 3600; // Auth issues 1-hour tokens; anything longer means the project expiry changed: refuse

// Constant-time comparison (same shape as ari-push's safeEq): no early exit on the first differing byte.
export function safeEq(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length === y.length;
}

function b64json(part: string): Record<string, unknown> {
  const s = part.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s + "=".repeat((4 - (s.length % 4)) % 4);
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(pad), (c) => c.charCodeAt(0))));
}

export type TokenCheck = { ok: true; exp: number } | { ok: false; reason: string };

// The token Auth just issued must be exactly what the worker is allowed to hold: ES256 (asymmetric, Supabase-held key),
// role ari_worker, the worker user's own id, at most 1 hour. Anything else is never handed out.
export function checkToken(tok: string, workerUid: string, nowSec: number): TokenCheck {
  const parts = (tok || "").split(".");
  if (parts.length !== 3) return { ok: false, reason: "not a jwt" };
  let h: Record<string, unknown>, p: Record<string, unknown>;
  try { h = b64json(parts[0]); p = b64json(parts[1]); } catch { return { ok: false, reason: "undecodable" }; }
  if (h.alg !== "ES256") return { ok: false, reason: `alg ${h.alg}` };
  if (p.role !== EXPECT_ROLE) return { ok: false, reason: `role ${p.role}` };
  if (!workerUid || p.sub !== workerUid) return { ok: false, reason: "sub mismatch" };
  const exp = Number(p.exp), iat = Number(p.iat);
  if (!Number.isFinite(exp) || !Number.isFinite(iat)) return { ok: false, reason: "no exp/iat" };
  if (exp - iat > MAX_TTL + 60) return { ok: false, reason: `ttl ${exp - iat}` };
  if (exp <= nowSec) return { ok: false, reason: "expired" };
  return { ok: true, exp };
}

export type Gate = { allow: boolean; reason: string };

export function parseGate(v: unknown): Gate {
  const g = (v ?? {}) as Record<string, unknown>;
  return { allow: g.allow === true, reason: typeof g.reason === "string" ? g.reason : "no gate answer" };
}
