// ari-gmail-push (PENDING). Verifies the Google-signed OIDC token Pub/Sub puts on every push request (Authorization: Bearer).
// RS256 against Google's JWKS, issuer accounts.google.com, the exact audience configured on the push subscription, the push
// service account's email (verified), and expiry. WebCrypto only, no dependency.

export const GOOGLE_JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
const ISS = new Set(['https://accounts.google.com', 'accounts.google.com']);

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let cache: { at: number; keys: Jwk[] } | null = null;

export function b64uBytes(s: string): Uint8Array<ArrayBuffer> {
  const t = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '==='.slice((t.length + 3) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const b64uJson = (s: string) => JSON.parse(new TextDecoder().decode(b64uBytes(s)));

export type JwksFetch = () => Promise<Jwk[]>;

export async function verifyPubsubJwt(token: string, want: { audience: string; email: string }, jwks: JwksFetch,
  nowSec = Math.floor(Date.now() / 1000)): Promise<{ ok: true } | { ok: false; why: string }> {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, why: 'shape' };
  let head, claims;
  try { head = b64uJson(parts[0]); claims = b64uJson(parts[1]); } catch { return { ok: false, why: 'decode' }; }
  if (head?.alg !== 'RS256' || typeof head?.kid !== 'string') return { ok: false, why: 'alg' };
  let keys = cache && nowSec - cache.at < 3600 ? cache.keys : null;
  if (!keys || !keys.some((k) => k.kid === head.kid)) { keys = await jwks(); cache = { at: nowSec, keys }; }
  const jwk = keys.find((k) => k.kid === head.kid && k.kty === 'RSA');
  if (!jwk) return { ok: false, why: 'kid' };
  const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const sig = b64uBytes(parts[2]);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return { ok: false, why: 'signature' };
  if (!ISS.has(claims.iss)) return { ok: false, why: 'iss' };
  if (claims.aud !== want.audience) return { ok: false, why: 'aud' };
  if (claims.email !== want.email || claims.email_verified !== true) return { ok: false, why: 'email' };
  if (typeof claims.exp !== 'number' || claims.exp < nowSec - 60) return { ok: false, why: 'expired' };
  if (typeof claims.iat === 'number' && claims.iat > nowSec + 300) return { ok: false, why: 'iat' };
  return { ok: true };
}

/** test hook */
export function resetJwksCache(): void { cache = null; }
