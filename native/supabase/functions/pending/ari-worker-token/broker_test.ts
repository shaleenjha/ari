// Offline tests for ari-worker-token: deno test --allow-env native/supabase/functions/pending/ari-worker-token/
// No network: fetch is replaced by a scripted fake. Synthetic values only.
import { assertEquals } from "jsr:@std/assert@1";
import { checkToken, safeEq, parseGate } from "./guard.ts";

Deno.env.set("ARI_BROKER_TEST", "1");
const { handle } = await import("./index.ts");

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const UID = "00000000-0000-4000-8000-00000000a1a1";
const NOW = 1_800_000_000;
const jwt = (h: Record<string, unknown>, p: Record<string, unknown>) => `${b64(h)}.${b64(p)}.sig`;
const good = jwt({ alg: "ES256", kid: "k1" }, { role: "ari_worker", sub: UID, iat: NOW, exp: NOW + 3600 });

Deno.test("safeEq", () => {
  assertEquals(safeEq("abc", "abc"), true);
  assertEquals(safeEq("abc", "abd"), false);
  assertEquals(safeEq("abc", "abcd"), false);
  assertEquals(safeEq(null, "x"), false);
  assertEquals(safeEq("", ""), false);
});

Deno.test("checkToken accepts only ES256 ari_worker for the worker uid, <= 1h", () => {
  assertEquals(checkToken(good, UID, NOW).ok, true);
  assertEquals(checkToken(jwt({ alg: "HS256" }, { role: "ari_worker", sub: UID, iat: NOW, exp: NOW + 3600 }), UID, NOW), { ok: false, reason: "alg HS256" });
  assertEquals(checkToken(jwt({ alg: "ES256" }, { role: "authenticated", sub: UID, iat: NOW, exp: NOW + 3600 }), UID, NOW), { ok: false, reason: "role authenticated" });
  assertEquals(checkToken(jwt({ alg: "ES256" }, { role: "service_role", sub: UID, iat: NOW, exp: NOW + 3600 }), UID, NOW).ok, false);
  assertEquals(checkToken(jwt({ alg: "ES256" }, { role: "ari_worker", sub: "other", iat: NOW, exp: NOW + 3600 }), UID, NOW), { ok: false, reason: "sub mismatch" });
  assertEquals(checkToken(good, "", NOW).ok, false);
  assertEquals(checkToken(jwt({ alg: "ES256" }, { role: "ari_worker", sub: UID, iat: NOW, exp: NOW + 86400 }), UID, NOW).ok, false);
  assertEquals(checkToken(good, UID, NOW + 4000), { ok: false, reason: "expired" });
  assertEquals(checkToken("garbage", UID, NOW).ok, false);
});

Deno.test("parseGate is fail-closed", () => {
  assertEquals(parseGate({ allow: true, reason: "ok" }), { allow: true, reason: "ok" });
  assertEquals(parseGate({ allow: "true" }).allow, false);
  assertEquals(parseGate(null).allow, false);
});

type Call = { url: string; body: unknown };
function fakeFetch(script: { gate?: unknown; auth?: { status: number; body?: unknown } }) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body });
    const hdrs = new Headers(init?.headers);
    if (hdrs.get("authorization")) throw new Error("secret key must go as apikey only");
    if (url.endsWith("/rpc/ari_broker_gate")) return new Response(JSON.stringify(script.gate ?? { allow: true, reason: "ok" }));
    if (url.endsWith("/rpc/ari_broker_note")) return new Response("");
    if (url.includes("/auth/v1/token")) {
      const a = script.auth ?? { status: 200, body: { access_token: good, refresh_token: "r-secret", expires_in: 3600 } };
      return new Response(JSON.stringify(a.body ?? {}), { status: a.status });
    }
    return new Response("nope", { status: 404 });
  }) as typeof fetch;
  return calls;
}
const ENV: Record<string, string> = {
  SUPABASE_URL: "https://example.supabase.co", ARI_SK_ARI_WORKER_TOKEN: "sb_secret_test",
  ARI_WORKER_CALLER_SECRET: "caller-s3cret", ARI_WORKER_EMAIL: "worker-synthetic", ARI_WORKER_PASSWORD: "pw", ARI_WORKER_UID: UID,
};
for (const [k, v] of Object.entries(ENV)) Deno.env.set(k, v);
const env = (over: Record<string, string> = {}) => (k: string) => over[k] ?? ENV[k] ?? Deno.env.get(k);
const post = (caller?: string) => new Request("https://example.functions.supabase.co/ari-worker-token",
  { method: "POST", headers: caller ? { "x-ari-worker-caller": caller } : {} });
const now = () => NOW * 1000;

Deno.test("kill switch env refuses before anything", async () => {
  const calls = fakeFetch({});
  const r = await handle(post("caller-s3cret"), env({ ARI_BROKER_DISABLED: "1" }), now);
  assertEquals(r.status, 503); assertEquals(calls.length, 0);
});

Deno.test("no or wrong caller secret: 401, nothing logged", async () => {
  const calls = fakeFetch({});
  assertEquals((await handle(post(), env(), now)).status, 401);
  assertEquals((await handle(post("caller-s3creT"), env(), now)).status, 401);
  assertEquals(calls.length, 0);
});

Deno.test("GET is refused", async () => {
  fakeFetch({});
  const r = await handle(new Request("https://x/ari-worker-token", { headers: { "x-ari-worker-caller": "caller-s3cret" } }), env(), now);
  assertEquals(r.status, 405);
});

Deno.test("gate refusal: 403, no sign-in", async () => {
  const calls = fakeFetch({ gate: { allow: false, reason: "rate" } });
  const r = await handle(post("caller-s3cret"), env(), now);
  assertEquals(r.status, 403); assertEquals((await r.json()).reason, "rate");
  assertEquals(calls.some((c) => c.url.includes("/auth/v1/")), false);
});

Deno.test("happy path: only the access token leaves, mint noted", async () => {
  const calls = fakeFetch({});
  const r = await handle(post("caller-s3cret"), env(), now);
  assertEquals(r.status, 200);
  const b = await r.json();
  assertEquals(b.access_token, good); assertEquals(b.expires_at, NOW + 3600);
  assertEquals("refresh_token" in b, false);
  assertEquals(JSON.stringify(b).includes("r-secret"), false);
  const note = calls.find((c) => c.url.endsWith("/rpc/ari_broker_note"));
  assertEquals((note!.body as Record<string, unknown>).p_outcome, "minted");
});

Deno.test("wrong token from Auth (e.g. role not mapped): 502, noted as error, token not returned", async () => {
  const bad = jwt({ alg: "ES256" }, { role: "authenticated", sub: UID, iat: NOW, exp: NOW + 3600 });
  const calls = fakeFetch({ auth: { status: 200, body: { access_token: bad } } });
  const r = await handle(post("caller-s3cret"), env(), now);
  assertEquals(r.status, 502);
  assertEquals((await r.text()).includes(bad), false);
  const note = calls.find((c) => c.url.endsWith("/rpc/ari_broker_note"));
  assertEquals((note!.body as Record<string, unknown>).p_outcome, "error");
});

Deno.test("Auth sign-in failure (banned user = kill switch): 502", async () => {
  fakeFetch({ auth: { status: 400, body: { error: "user_banned" } } });
  assertEquals((await handle(post("caller-s3cret"), env(), now)).status, 502);
});

Deno.test("missing named secret key fails closed (no legacy fallback)", async () => {
  fakeFetch({});
  Deno.env.delete("ARI_SK_ARI_WORKER_TOKEN");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "eyJlegacy");
  let threw = false;
  try { await handle(post("caller-s3cret"), env({ ARI_SK_ARI_WORKER_TOKEN: "" }), now); } catch { threw = true; }
  assertEquals(threw, true);
  Deno.env.set("ARI_SK_ARI_WORKER_TOKEN", "sb_secret_test");
});
