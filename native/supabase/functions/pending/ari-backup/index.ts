// S1 R7 (PENDING, not deployed): reads its own named secret key ari_backup (apikey header only) instead of the legacy
// SUPABASE_SERVICE_ROLE_KEY. Deploy staging first (work/r7/runbook.md step b); the live source is ../../ari-backup/index.ts.
// ari-backup (v18.7.1, Oct 17 2026; v18.6 base): nightly logical backup that runs entirely inside Supabase, so no Hark run needs the
// Management token. Invoked by pg_cron (job ari-nightly-backup -> public.ari_backup_kick()) with header x-ari-hook.
// Deploy with "Verify JWT" OFF: the caller is checked against vault secret ari_backup_hook_secret.
// What it does: every table in schema public + auth.users + auth.identities + the migration ledger (DDL replay) +
// public function definitions + policies + cron jobs -> one gzip JSON in the private bucket ari-backups (prod) and a
// CMS-encrypted copy in bucket ari-offsite (below). S1 R3 (Claude R-03, Oct 19 2026): the plaintext copy to ari-staging is gone.
// Restore test every run: the stored object is downloaded again, checksum-checked, and every table is loaded into a
// temp table of the same row type (json_populate_recordset) and counted, in a transaction that is rolled back.
// Result row in public.backup_runs; Hark's nightly check reads it through ari_worker_backup_status() (metadata only).
import postgres from "npm:postgres@3.4.4";
// esm.sh build: the npm: build breaks setEngine in the edge runtime (process.pid global key)
import * as pkijs from "https://esm.sh/pkijs@3.2.4?target=es2022";

// v18.7.1: a second, already-encrypted copy goes to private bucket ari-offsite (the only bucket ari_worker may read), so the
// offsite job (scripts/offsite_drive.py -> Google Drive) never holds plaintext or sign-in user rows. Format: openssl-compatible
// CMS EnvelopedData, AES-256-CBC, content key wrapped by ECDH (P-384, SHA-256 KDF) to this PUBLIC certificate. Decrypt with
// "openssl cms -decrypt -binary -inform DER -inkey <private key from vault> -recip ari-offsite-recipient.pem" (RESTORE.md).
// OFFSITE_CERT_PEM (function secret) overrides the built-in cert ONLY on the staging project (allowlist), for the round-trip
// test with a throwaway cert. Prod, a custom domain or an unparseable URL always get the built-in bundle, so neither recipient
// (Hark vault, owner) can be dropped by a secret change.
const OFFSITE_BUCKET = "ari-offsite";
const STAGING_REF = "ljojwhnfgfreokqspobg";
// Two recipients: "Ari offsite backup recipient" (key in the Hark vault) and "Ari backup - owner" (key held by the owner,
// SHA-256 21:90:2D:64:51:9D:70:E9:3D:BF:32:B1:8B:3E:8A:76:CE:83:20:E0:48:D2:5D:8A:78:8A:6B:89:0E:10:AF:D9).
const OFFSITE_CERT = `-----BEGIN CERTIFICATE-----
MIIB4DCCAWagAwIBAgIULZi9W1WcjG6cDFJeZbULrFuXeCQwCgYIKoZIzj0EAwIw
JzElMCMGA1UEAwwcQXJpIG9mZnNpdGUgYmFja3VwIHJlY2lwaWVudDAeFw0yNjEw
MTYyMjQwMDZaFw0zNjEwMTMyMjQwMDZaMCcxJTAjBgNVBAMMHEFyaSBvZmZzaXRl
IGJhY2t1cCByZWNpcGllbnQwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAS9FX+cTWF9
NoUPiE+SEjWYOXzGGODwEPORWVXuSzHAxiuUX0SMuDXBG6z9RRuWd75FQDP2j2Er
ERe3XMczIj6PpkKTSu7KtVX+ohsZmeR9p5D+5p9df4pLPGwF2ux6QNujUzBRMB0G
A1UdDgQWBBQm4NWZ0WeW6N7jUjir6mcAd1OlRDAfBgNVHSMEGDAWgBQm4NWZ0WeW
6N7jUjir6mcAd1OlRDAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA2gAMGUC
MH5oHl3ktFN5CXhD8OqdoAoeEqwd0+H3DmNVbn/MOs/Z8tzQ/Bh5nWLlip2/9rKz
ZwIxAM6tCyQlPW0AnDtBXFvFjTd+34pjlkB/mZ8qnfwB3Tomb6sVmfamhyAVrrOX
2kK5RA==
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIBZTCB6wIJALQ5EFbKOHEKMAoGCCqGSM49BAMCMBwxGjAYBgNVBAMMEUFyaSBi
YWNrdXAgLSBTaGFsMB4XDTI2MTAxOTA3NTAwMFoXDTM2MTAxNjA3NTAwMFowHDEa
MBgGA1UEAwwRQXJpIGJhY2t1cCAtIFNoYWwwdjAQBgcqhkjOPQIBBgUrgQQAIgNi
AAQhnREXDx3+Cxm7yiSWBfd2InbGTDN3FA+nMykZYXld1ByCAT+2j/rs0zaompUA
Q5g+vDzcdG1gsdrjB/s5HD/8y3ydWGs/iLtIS11MqeP+HqKxbKiFgLE26HnGZfNL
pNwwCgYIKoZIzj0EAwIDaQAwZgIxAIa0VWUBvdJ9kU0kXz8cunmYD44BlzkOxJ/C
HaNRPeV52kKUVVuPGLTIUc7dhLrjeQIxANgpi6LWdS0DCs3yIw57Ao7QUCXT/tFe
8j2F/M+FAPThJ7sACDKG420sVwxCaOyTcw==
-----END CERTIFICATE-----`;
pkijs.setEngine("webcrypto", new pkijs.CryptoEngine({ name: "webcrypto", crypto: globalThis.crypto }));
// S1 R3 (prepared Oct 19 2026, NOT deployed): every certificate in the PEM bundle is a recipient, so either private key
// (Hark vault, or the owner's own) opens the file. Keep in step with native/supabase/offsite/ari-offsite-recipient*.pem;
// scripts/backup_check.py checks the recipients of each night's file against those files.
async function cmsEncrypt(pems: string, data: Uint8Array): Promise<Uint8Array> {
  const blocks = pems.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [];
  if (!blocks.length) throw new Error("no recipient certificate");
  const env = new pkijs.EnvelopedData();
  for (const pem of blocks) {
    const der = Uint8Array.from(atob(pem.replace(/-----[^-]+-----|\s/g, "")), (c) => c.charCodeAt(0));
    env.addRecipientByCertificate(pkijs.Certificate.fromBER(der.buffer), { kdfAlgorithm: "SHA-256" }, 2);
  }
  await env.encrypt({ name: "AES-CBC", length: 256 } as AesKeyGenParams, data);
  const ci = new pkijs.ContentInfo({ contentType: pkijs.ContentInfo.ENVELOPED_DATA, content: env.toSchema() });
  return new Uint8Array(ci.toSchema().toBER(false));
}

const KEEP = 14;
const BUCKET = "ari-backups";
const EXTRA = [["auth", "users"], ["auth", "identities"], ["supabase_migrations", "schema_migrations"]];

async function gzip(text: string): Promise<Uint8Array> {
  const s = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(b: Uint8Array): Promise<string> {
  const s = new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(s).text();
}
async function sha256(b: Uint8Array) {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  return Array.from(h).map((x) => x.toString(16).padStart(2, "0")).join("");
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

function hdr(key: string, extra: Record<string, string> = {}) {
  return { apikey: key, ...extra };
}
async function put(url: string, key: string, name: string, body: Uint8Array, bucket = BUCKET) {
  const r = await fetch(`${url}/storage/v1/object/${bucket}/${name}`, {
    method: "POST", headers: hdr(key, { "content-type": bucket === BUCKET ? "application/gzip" : "application/octet-stream", "x-upsert": "false" }), body,
  });
  if (!r.ok) throw new Error(`upload ${r.status} ${(await r.text()).slice(0, 200)}`);
}
async function prune(url: string, key: string, bucket = BUCKET) {
  const r = await fetch(`${url}/storage/v1/object/list/${bucket}`, {
    method: "POST", headers: hdr(key, { "content-type": "application/json" }),
    body: JSON.stringify({ prefix: "", limit: 1000, sortBy: { column: "name", order: "asc" } }),
  });
  if (!r.ok) return;
  const names = ((await r.json()) as { name: string }[]).map((o) => o.name).filter((n) => n.startsWith("ari_")).sort();
  const old = names.slice(0, Math.max(0, names.length - KEEP));
  if (old.length) {
    await fetch(`${url}/storage/v1/object/${bucket}`, {
      method: "DELETE", headers: hdr(key, { "content-type": "application/json" }), body: JSON.stringify({ prefixes: old }),
    });
  }
}

async function run(sql: postgres.Sql, runId: number) {
  const url = Deno.env.get("SUPABASE_URL")!, key = secretKey("ari_backup");
  const tabs = await sql`select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
                         where n.nspname = 'public' and c.relkind in ('r','p') order by c.relname`;
  const list: [string, string][] = [...tabs.map((r) => [r.s, r.t] as [string, string]), ...EXTRA as [string, string][]];
  const counts: Record<string, number> = {};
  const parts: string[] = [];
  await sql.begin("isolation level repeatable read read only", async (tx) => {
    for (const [s, t] of list) {
      const q = `select count(*)::int n, coalesce(json_agg(x), '[]'::json)::text j from "${s}"."${t}" x`;
      const [row] = await tx.unsafe(q);
      counts[`${s}.${t}`] = row.n;
      parts.push(`${JSON.stringify(`${s}.${t}`)}:${row.j}`);
    }
    const [meta] = await tx.unsafe(`select
      (select coalesce(json_agg(json_build_object('name', p.proname, 'def', pg_get_functiondef(p.oid)) order by p.proname), '[]'::json)
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind in ('f','p')) fns,
      (select coalesce(json_agg(x), '[]'::json) from pg_policies x where x.schemaname = 'public') policies,
      (select coalesce(json_agg(json_build_object('name', jobname, 'schedule', schedule, 'command', command)), '[]'::json) from cron.job) cron`);
    parts.push(`"_schema":${JSON.stringify(meta)}`);
  });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z"; // 20261017T213045Z (seconds, so two runs in one hour never collide)
  const name = `ari_${stamp}.json.gz`;
  const text = `{"_meta":${JSON.stringify({ taken_utc: new Date().toISOString(), project: url, counts })},${parts.join(",")}}`;
  const gz = await gzip(text);
  const digest = await sha256(gz);
  await put(url, key, name, gz);

  // encrypted copy for the offsite job (bucket ari-offsite; the worker can read only this)
  let encFile: string | null = null, encBytes: number | null = null, encSum: string | null = null, encErr: string | null = null;
  try {
    const enc = await cmsEncrypt(recipientPems(url, Deno.env.get("OFFSITE_CERT_PEM")), gz);
    encFile = `${name}.cms`; encBytes = enc.length; encSum = await sha256(enc);
    await put(url, key, encFile, enc, OFFSITE_BUCKET); await prune(url, key, OFFSITE_BUCKET);
  } catch (e) { encFile = null; encErr = "enc: " + String(e).slice(0, 200); }

  // restore test from the stored object
  const dl = await fetch(`${url}/storage/v1/object/${BUCKET}/${name}`, { headers: hdr(key) });
  const back = new Uint8Array(await dl.arrayBuffer());
  const sameSum = dl.ok && (await sha256(back)) === digest;
  const parsed = JSON.parse(await gunzip(back));
  const mismatches: Record<string, unknown> = {};
  const errors: string[] = [];
  try {
    await sql.begin(async (tx) => {
      for (const [s, t] of list) {
        const k = `${s}.${t}`, rows = parsed[k];
        const tmp = `r_${s}_${t}`.slice(0, 60);
        try {
          await tx.unsafe(`create temp table "${tmp}" (like "${s}"."${t}") on commit drop`);
          await tx.unsafe(`insert into "${tmp}" select * from json_populate_recordset(null::"${tmp}", ($1::text)::json)`, [JSON.stringify(rows)]);
          const [c] = await tx.unsafe(`select count(*)::int n from "${tmp}"`);
          if (c.n !== counts[k] || !Array.isArray(rows) || rows.length !== counts[k]) mismatches[k] = { dumped: counts[k], restored: c.n };
        } catch (e) { errors.push(`${k}: ${String(e).slice(0, 160)}`); throw e; }
      }
      throw new Error("__rollback__");
    });
  } catch (e) { if (String(e).indexOf("__rollback__") < 0 && !errors.length) errors.push(String(e).slice(0, 200)); }
  const verified = sameSum && !Object.keys(mismatches).length && !errors.length;
  await prune(url, key);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  await sql`update public.backup_runs set finished_at = now(), file = ${name}, bytes = ${gz.length}, sha256 = ${digest},
            tables = ${list.length}, rows = ${total}, counts = ${sql.json(counts)}, verified = ${verified},
            mismatches = ${sql.json({ ...mismatches, ...(errors.length ? { _errors: errors } : {}), ...(sameSum ? {} : { _checksum: "mismatch" }) })},
            offsite = false, offsite_error = ${encErr},
            enc_file = ${encFile}, enc_bytes = ${encBytes}, enc_sha256 = ${encSum}, error = null where id = ${runId}`;
}

// Allowlist: the OFFSITE_CERT_PEM override applies only on <staging ref>.supabase.co; every other case gets the built-in bundle.
function recipientPems(projectUrl: string, override: string | undefined): string {
  let host = "";
  try { host = new URL(projectUrl).hostname; } catch { host = ""; }
  return override && host === `${STAGING_REF}.supabase.co` ? override : OFFSITE_CERT;
}

// v18.7: constant-time comparison for the x-ari-hook secret (no early exit on the first differing byte)
function safeEq(a: string | null, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let d = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0 && x.length === y.length;
}

Deno.serve(async (req) => {
  const hook = req.headers.get("x-ari-hook");
  if (!hook || hook.length > 256) return new Response("unauthorized", { status: 401 }); // missing or oversized: no DB work
  // Free pre-check, no DB: the same hook secret is also a function secret (ARI_BACKUP_HOOK). A wrong header never opens a
  // connection. Unset = refuse everything (fail closed). Setup, length (32+ random bytes) and rotation: ../DEPLOY_SECRETS.md.
  const pre = Deno.env.get("ARI_BACKUP_HOOK") ?? "";
  if (pre.length < 32) { console.error("ARI_BACKUP_HOOK is unset or shorter than 32 characters"); return new Response("unauthorized", { status: 401 }); }
  if (!safeEq(hook, pre)) return new Response("unauthorized", { status: 401 });
  const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 0 }); // 0: the one connection (and its advisory lock) must not drop mid-backup
  const json = (b: unknown, status = 202) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  let handedOff = false; // once the job owns the connection, only the job ends it
  try {
    const [s] = await sql`select decrypted_secret v from vault.decrypted_secrets where name = 'ari_backup_hook_secret'`;
    if (!safeEq(hook, typeof s?.v === "string" ? s.v : null)) { // vault stays the source of truth
      console.error("hook secret drift: ARI_BACKUP_HOOK matches but the vault secret does not (rotate both, see DEPLOY_SECRETS.md)");
      return new Response("unauthorized", { status: 401 }); // finally below closes the connection (handedOff is false)
    }
    // one backup at a time: a session advisory lock (this client has exactly one connection) held until the job ends
    const [lk] = await sql`select pg_try_advisory_lock(hashtext('ari_backup_run')) ok`;
    if (!lk?.ok) return json({ ok: true, already_running: true });
    const [busy] = await sql`select id from public.backup_runs where finished_at is null and started_at > now() - interval '30 minutes' limit 1`;
    if (busy) return json({ ok: true, already_running: busy.id });
    const [r] = await sql`insert into public.backup_runs default values returning id`;
    const job = (async () => {
      try { await run(sql, r.id); }
      catch (e) { await sql`update public.backup_runs set finished_at = now(), verified = false, error = ${String(e).slice(0, 500)} where id = ${r.id}`; }
      finally { try { await sql`select pg_advisory_unlock(hashtext('ari_backup_run'))`; } catch (_) { /* session end releases it */ } await sql.end(); }
    })();
    handedOff = true;
    // @ts-ignore EdgeRuntime is provided by Supabase
    if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(job); else await job;
    return json({ ok: true, run: r.id });
  } catch (e) {
    console.error(String(e).slice(0, 300));
    return new Response("error", { status: 500 });
  } finally {
    if (!handedOff) await sql.end().catch(() => {}); // every non-job path closes the connection (and releases any lock)
  }
});
