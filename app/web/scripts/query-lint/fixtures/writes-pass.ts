// no-client-writes fixture: reads only, plus sign-in on the auth path and plain collections. Repo only.
declare const sb: any;
declare const base: string;
declare const f: (url: string, init?: RequestInit) => Promise<Response>;

export async function reads() {
  await sb.from('people').select('id').limit(10);
  await fetch(`${base}/rest/v1/people?select=id&limit=10`);
  await f(`${base}/rest/v1/people?select=id&limit=10`, { headers: { apikey: 'k' } });
  await f(`${base}/rest/v1/people?select=id&limit=1`, { method: 'GET' });
  await f(`${base}/rest/v1/people?select=id&limit=1`, { method: 'HEAD' });
  new Request(`${base}/rest/v1/people?limit=1`);
  const r = await f(`${base}/rest/v1/people?limit=1`); await r.json();
}

export async function signIn() {
  await f(`${base}/auth/v1/token?grant_type=id_token`, { method: 'POST', body: '{}' });
  await fetch(base + '/auth/v1/token?grant_type=refresh_token', { method: 'POST' });
}

export function collections() {
  const s = new Set<string>(['a']); s.delete('a');
  const m = new Map<string, number>(); m.delete('a');
  const q = new URLSearchParams('a=1'); q.delete('a');
  const store = { remove: (_id: string) => undefined }; store.remove('a');
  return [s, m, q];
}
