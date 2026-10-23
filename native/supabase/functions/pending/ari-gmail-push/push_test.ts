// Offline tests for ari-gmail-push: OIDC verification with a throwaway RSA key, push handling, watch renewal. Synthetic only.
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { resetJwksCache, verifyPubsubJwt } from './oidc.ts';
import { ALLOW, handlePush, PushEnv } from './handler.ts';

const AUD = 'https://abcdefghijklmnopqrst.supabase.co/functions/v1/ari-gmail-push';
const SA = 'push-invoker@example.com';
const HOOK = 'ai-hook-synthetic-0123456789abcdef0123';

const enc = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const kp = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', kp.publicKey);
const JWKS = () => Promise.resolve([{ kid: 'k1', kty: 'RSA', n: pub.n!, e: pub.e! }]);
const now = Math.floor(Date.now() / 1000);
async function jwt(claims: Record<string, unknown>, kid = 'k1', key = kp.privateKey): Promise<string> {
  const h = enc({ alg: 'RS256', kid, typ: 'JWT' }), p = enc(claims);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${h}.${p}`)));
  return `${h}.${p}.${btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
const good = { iss: 'https://accounts.google.com', aud: AUD, email: SA, email_verified: true, iat: now, exp: now + 3600 };

Deno.test('oidc: a valid Pub/Sub token passes; wrong audience, sender, expiry, issuer or signature fail', async () => {
  resetJwksCache();
  const want = { audience: AUD, email: SA };
  assert((await verifyPubsubJwt(await jwt(good), want, JWKS, now)).ok);
  for (const [bad, why] of [[{ ...good, aud: 'https://other' }, 'aud'], [{ ...good, email: 'other-invoker@example.com' }, 'email'],
    [{ ...good, email_verified: false }, 'email'], [{ ...good, exp: now - 3600 }, 'expired'], [{ ...good, iss: 'https://evil' }, 'iss']] as const) {
    const r = await verifyPubsubJwt(await jwt(bad), want, JWKS, now);
    assert(!r.ok && r.why === why, JSON.stringify(r));
  }
  const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign']);
  const forged = await verifyPubsubJwt(await jwt(good, 'k1', other.privateKey), want, JWKS, now);
  assert(!forged.ok && forged.why === 'signature');
  assert(!(await verifyPubsubJwt('a.b', want, JWKS, now)).ok);
  assert(!(await verifyPubsubJwt(await jwt(good, 'unknown-kid'), want, JWKS, now)).ok);
});

function mkEnv(over: Partial<PushEnv> = {}) {
  const calls: string[] = []; const bg: Promise<unknown>[] = []; const rpcs: string[] = [];
  const env: PushEnv = {
    // deno-lint-ignore no-explicit-any
    rpc: (fn: string): Promise<any> => {
      rpcs.push(fn);
      const r: Record<string, unknown> = { ari_ai_hook: HOOK, ari_gmail_hook: 'gmail-hook', ari_gmail_push_config: { topic: 'projects/p/topics/t', audience: AUD, sa_email: SA },
        ari_gmail_ingest_config: { status: 'connected', refresh_token: 'rt-synthetic' } };
      return Promise.resolve(r[fn] ?? null);
    },
    jwks: JWKS,
    callFn: (slug, secret) => { calls.push(`${slug}:${secret}`); return Promise.resolve(200); },
    googleToken: () => Promise.resolve('at-synthetic'),
    gmailWatch: () => Promise.resolve({ historyId: '123', expiration: String(Date.now() + 7 * 86400e3) }),
    background: (p) => { bg.push(p); },
    ...over,
  };
  return { env, calls, bg, rpcs };
}
const pushReq = (email: string, token?: string) => new Request(AUD, { method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify({ message: { data: btoa(JSON.stringify({ emailAddress: email, historyId: 99 })), messageId: '1' }, subscription: 's' }) });

Deno.test('push: unauthenticated pushes are refused and trigger nothing', async () => {
  resetJwksCache();
  const { env, calls, bg } = mkEnv();
  assertEquals((await handlePush(pushReq(ALLOW), env)).status, 401);
  assertEquals((await handlePush(pushReq(ALLOW, await jwt({ ...good, aud: 'x' })), env)).status, 401);
  assertEquals(calls.length + bg.length, 0);
});

Deno.test('push: a valid push for the allowlisted mailbox acks 204 at once, then runs ingest before ari-ai', async () => {
  resetJwksCache();
  const { env, calls, bg } = mkEnv();
  const r = await handlePush(pushReq(ALLOW.toUpperCase(), await jwt(good)), env);
  assertEquals(r.status, 204);
  await Promise.all(bg);
  assertEquals(calls, ['ari-gmail-ingest:gmail-hook', `ari-ai:${HOOK}`]);
});

Deno.test('push: another mailbox or a malformed body is acked and ignored (no redelivery loop, no work)', async () => {
  resetJwksCache();
  const { env, calls, bg } = mkEnv();
  assertEquals((await handlePush(pushReq('someone@example.com', await jwt(good)), env)).status, 204);
  const bad = new Request(AUD, { method: 'POST', headers: { authorization: `Bearer ${await jwt(good)}` }, body: '{"message":{"data":"!!"}}' });
  assertEquals((await handlePush(bad, env)).status, 204);
  assertEquals(calls.length + bg.length, 0);
});

Deno.test('renew: needs the hook, calls users.watch with the configured topic, records the expiry', async () => {
  let topic = '';
  const { env, rpcs } = mkEnv({ gmailWatch: (_a, t) => { topic = t; return Promise.resolve({ historyId: '5', expiration: '1893456000000' }); } });
  const no = await handlePush(new Request(AUD, { method: 'POST', headers: { 'x-ari-hook': 'nope' }, body: '{"internal":"renew_watch"}' }), env);
  assertEquals(no.status, 401);
  const r = await handlePush(new Request(AUD, { method: 'POST', headers: { 'x-ari-hook': HOOK }, body: '{"internal":"renew_watch"}' }), env);
  assertEquals((await r.json()).ok, true); assertEquals(topic, 'projects/p/topics/t'); assert(rpcs.includes('ari_gmail_watch_set'));
});
