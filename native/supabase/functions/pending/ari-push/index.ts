// S1 R7 (PENDING, not deployed): reads its own named secret key ari_push (apikey header only) instead of the legacy
// SUPABASE_SERVICE_ROLE_KEY. Deploy staging first (work/r7/runbook.md step b); the live source is ../../ari-push/index.ts.
// Ari v17: ari-push edge function (Supabase, Deno). Zero dependencies: Web Push (RFC 8291 aes128gcm)
// and VAPID (RFC 8292) implemented on WebCrypto, PostgREST called with fetch.
// Invoked by pg_net from the notifications trigger and the 5-minute retry cron (header x-ari-hook).
// Deploy with "Verify JWT" OFF: the function authenticates the caller with the hook secret from Supabase Vault.
// Secrets live in Supabase Vault (read through rpc ari_push_config with the auto-provided service role key).
// Plain JS syntax on purpose so the same file is unit-tested in Node (work/v17/test_push_local.mjs).

const enc = new TextEncoder();
const b64u = {
  enc(buf) {
    const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec(str) {
    const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
    const bin = atob(s); const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};
const concat = (...arrs) => {
  const n = arrs.reduce((a, b) => a + b.length, 0); const out = new Uint8Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; } return out;
};

async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, len * 8));
}

// RFC 8291 + RFC 8188 single record
export async function encryptPayload(sub, plaintext) {
  const uaPublic = b64u.dec(sub.p256dh), authSecret = b64u.dec(sub.auth);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const data = concat(typeof plaintext === "string" ? enc.encode(plaintext) : plaintext, new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, data));
  const header = new Uint8Array(21); header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096); header[20] = asPublic.length;
  return concat(header, asPublic, ct);
}

export async function vapidAuth(endpoint, privateJwk, publicKeyB64u, subject) {
  const aud = new URL(endpoint).origin;
  const h = b64u.enc(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", { ...privateJwk, key_ops: ["sign"], ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(h + "." + p)));
  return `vapid t=${h}.${p}.${b64u.enc(sig)}, k=${publicKeyB64u}`;
}

export async function sendPush(sub, payload, cfg, opts = {}) {
  const body = await encryptPayload(sub, JSON.stringify(payload));
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuth(sub.endpoint, cfg.jwk, cfg.vapid_public_key, cfg.subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(opts.ttl ?? 86400),
      Urgency: opts.urgency ?? "high",
      ...(opts.topic ? { Topic: opts.topic } : {}),
    },
    body,
  });
  let text = ""; try { text = (await res.text()).slice(0, 200); } catch (_) { /* ignore */ }
  return { ok: res.status >= 200 && res.status < 300, status: res.status, text };
}

// Group a batch: up to 3 of a kind go out one by one; more become one summary push.
// v3 (Oct 17, v18.4): since 0015/0016 titles are generic by default ("Brief ready", "DM2 drafted"), so a summary built from
// titles read "Brief ready, Brief ready, ...". A summary now says the count ("3 briefs ready") with a generic body, and lists
// names only when the titles really carry distinct names (push_show_names on).
const KIND_WORD = { accepted: ["accept", "accepts"], replied: ["reply", "replies"], meeting: ["meeting", "meetings"],
  research_done: ["brief ready", "briefs ready"], draft_due: ["draft ready", "drafts ready"], test: ["test", "tests"] };
const GENERIC_TITLE = { "New reply on LinkedIn": "new replies on LinkedIn", "New connection accepted": "new connections accepted",
  "Meeting set": "meetings set", "Brief ready": "briefs ready", "DM1 ready": "DM1s ready", "DM2 drafted": "DM2s drafted",
  "DM3 drafted": "DM3s drafted", "Draft ready": "drafts ready", "Ari update": "updates in Ari" };
const GENERIC_BODY = { replied: "Open Ari to answer them.", accepted: "Their DM1 drafts are ready in Ari.", meeting: "Open Ari to see the details.",
  research_done: "They are waiting in Ari.", draft_due: "Ready for your review in Ari." };
export function summarize(kind, list) {
  const n = list.length, titles = list.map((r) => String(r.title || "").trim());
  const allGeneric = titles.every((t) => t in GENERIC_TITLE || t === "");
  const uniq = [...new Set(titles)];
  if (allGeneric || uniq.length < n) {
    const title = uniq.length === 1 && GENERIC_TITLE[uniq[0]] ? `${n} ${GENERIC_TITLE[uniq[0]]}` : `${n} ${KIND_WORD[kind]?.[1] ?? "updates"}`;
    return { title, body: GENERIC_BODY[kind] ?? "Open Ari to see them." };
  }
  const names = [...new Set(titles.map((t) => t.replace(/^(Research done: |Brief ready: |DM\d (ready|drafted) for |Meeting set( with|:) )/, "").replace(/ (accepted|replied)$/, "")))];
  return { title: `${n} new ${KIND_WORD[kind]?.[1] ?? kind}`, body: names.slice(0, 4).join(", ") + (names.length > 4 ? ` and ${names.length - 4} more` : "") };
}
export function groupNotifications(rows) {
  const byKind = {}; for (const r of rows) (byKind[r.kind] ||= []).push(r);
  const out = [];
  for (const [kind, list] of Object.entries(byKind)) {
    if (list.length <= 3) { for (const r of list) out.push({ ids: [r.id], kind, title: r.title, body: r.body || "", url: r.url || "/ops", tag: r.dedupe_key || ("n" + r.id) }); continue; }
    const sm = summarize(kind, list);
    out.push({ ids: list.map((r) => r.id), kind, title: sm.title, body: sm.body, url: "/ops", tag: "batch-" + kind });
  }
  return out;
}

// Expo Push API (native Ari app). One message per token; tickets come back in order.
export async function sendExpo(tokens, g) {
  const msgs = tokens.map((t) => ({ to: t.token, title: g.title, body: g.body, sound: "default", priority: "high",
    channelId: g.kind === "test" ? "default" : "pings", data: { url: g.url, kind: g.kind, tag: g.tag },
    ...(g.tag ? { collapseId: g.tag.slice(0, 64), threadId: g.kind } : {}) }));
  const headers = { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "gzip, deflate" };
  const tok = (typeof Deno !== "undefined") ? Deno.env.get("EXPO_ACCESS_TOKEN") : undefined;
  if (tok) headers.Authorization = `Bearer ${tok}`;
  const r = await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers, body: JSON.stringify(msgs) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && !j.data) throw new Error(`expo ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return Array.isArray(j.data) ? j.data : [j.data];
}

// v18.7 / v18.7.1: constant-time comparison for the x-ari-hook secret (no early exit on the first differing byte).
// Module scope + plain JS on purpose (v18.7 had it inside the Deno block, where handle() could not see it).
function safeEq(a, b) {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length === y.length;
}

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

async function handle(req) {
  const url = Deno.env.get("SUPABASE_URL"), key = secretKey("ari_push");
  const rest = (path, init = {}) => fetch(`${url}/rest/v1/${path}`, { ...init,
    headers: { apikey: key, "Content-Type": "application/json", ...(init.headers || {}) } });
  const rpc = async (fn, args = {}) => { const r = await rest(`rpc/${fn}`, { method: "POST", body: JSON.stringify(args) });
    if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`); const t = await r.text(); return t ? JSON.parse(t) : null; };

  const hook = req.headers.get("x-ari-hook");
  if (!hook || hook.length > 256) return new Response("unauthorized", { status: 401 }); // no secret lookup for unauthenticated calls
  const conf = await rpc("ari_push_config");
  if (!safeEq(hook, conf?.hook_secret)) return new Response("unauthorized", { status: 401 });
  const cfg = { jwk: JSON.parse(conf.vapid_private_jwk), vapid_public_key: conf.vapid_public_key, subject: conf.subject };

  // v2 (v17.1.1): only active, non-revoked web subscriptions, plus native Ari app tokens (Expo)
  const subsRes = await rest("push_subscriptions?revoked_at=is.null&active=is.true&select=id,endpoint,p256dh,auth,kinds,device,browser");
  if (!subsRes.ok) return Response.json({ ok: false, error: "subscriptions unavailable" }, { status: 502 }); // before claiming, so no attempt is burned
  const subs = await subsRes.json();
  const tokRes = await rest("push_tokens?revoked_at=is.null&active=is.true&select=id,token,kinds,device,platform");
  const toks = tokRes.ok ? await tokRes.json() : [];
  const rows = await rpc("ari_claim_notifications", { p_limit: 50 });
  if (!rows?.length) return Response.json({ ok: true, claimed: 0, subscriptions: subs.length, app_tokens: toks.length });
  const report = [];
  for (const g of groupNotifications(rows)) {
    let delivered = 0, errors = [];
    const targets = subs.filter((s) => !s.kinds || s.kinds.includes(g.kind));
    for (const s of targets) {
      try {
        const r = await sendPush(s, { title: g.title, body: g.body, url: g.url, tag: g.tag, kind: g.kind, ts: Date.now() }, cfg, { topic: g.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) });
        await rpc("ari_subscription_result", { p_id: s.id, p_ok: r.ok, p_status: r.status, p_error: r.ok ? null : r.text });
        if (r.ok) delivered++; else errors.push(`${s.device || s.id}: ${r.status}`);
      } catch (e) { errors.push(`${s.device || s.id}: ${String(e).slice(0, 120)}`);
        await rpc("ari_subscription_result", { p_id: s.id, p_ok: false, p_status: null, p_error: String(e).slice(0, 200) }); }
    }
    const apps = toks.filter((t) => !t.kinds || t.kinds.includes(g.kind));
    if (apps.length) {
      try {
        const res = await sendExpo(apps, g);
        for (let i = 0; i < apps.length; i++) {
          const tk = res[i] || {}; const ok = tk.status === "ok"; const unreg = tk.details?.error === "DeviceNotRegistered";
          await rpc("ari_token_result", { p_id: apps[i].id, p_ok: ok, p_error: ok ? null : `${tk.details?.error || ""} ${tk.message || ""}`.trim(), p_unregistered: unreg });
          if (ok) delivered++; else errors.push(`app ${apps[i].device || apps[i].id}: ${tk.details?.error || tk.message || "error"}`);
        }
      } catch (e) { errors.push(`expo: ${String(e).slice(0, 120)}`); }
    }
    const err = (targets.length + apps.length) === 0 ? "no active subscriptions" : (errors.length && delivered === 0 ? errors.join("; ") : (errors.length ? "partial: " + errors.join("; ") : null));
    await rpc("ari_finish_notifications", { p_ids: g.ids, p_delivered: delivered, p_error: err });
    report.push({ ids: g.ids, kind: g.kind, delivered, targets: targets.length, apps: apps.length, error: err });
  }
  return Response.json({ ok: true, claimed: rows.length, report });
}

if (typeof Deno !== "undefined" && Deno.serve) {
Deno.serve(async (req) => {
    try { return await handle(req); }
    catch (e) { console.error(String(e).slice(0, 300)); return Response.json({ ok: false, error: "error" }, { status: 500 }); }
  });
}
