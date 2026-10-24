// no-client-writes fixture: each line carrying an expect marker must be reported, and nothing else. Repo only.
declare const sb: any;
declare const base: string;
declare const init: RequestInit;
declare const f: (url: string, init?: RequestInit) => Promise<Response>;
declare const verb: string;

export async function writes() {
  await sb.from('people').insert({ id: 1 }); // expect: no-client-writes
  await sb.from('people').upsert({ id: 1 }); // expect: no-client-writes
  await sb.from('people').update({ stage: 'x' }).eq('id', 1); // expect: no-client-writes
  await sb.from('people').delete().eq('id', 1); // expect: no-client-writes
  await sb.rpc('person_mark', { p: 1 }); // expect: no-client-writes
  await sb.storage.from('files').upload('a', 'b'); // expect: no-client-writes
}

export async function requests() {
  await fetch(`${base}/rest/v1/people`, { method: 'POST', body: '{}' }); // expect: no-client-writes
  await f(`${base}/rest/v1/people`, { method: 'PATCH' }); // expect: no-client-writes
  await f(`${base}/rest/v1/rpc/ari_today15`, { method: 'post' }); // expect: no-client-writes
  await fetch(`${base}/rest/v1/people`, init); // expect: no-client-writes
  await f(`${base}/rest/v1/people`, { ...init }); // expect: no-client-writes
  await f(`${base}/rest/v1/people`, { method: verb }); // expect: no-client-writes
  await f(`${base}/auth/v1/../rest/v1/people`, { method: 'DELETE' }); // expect: no-client-writes
  new Request(`${base}/rest/v1/people`, { method: 'PUT' }); // expect: no-client-writes
  navigator.sendBeacon(`${base}/rest/v1/people`, '{}'); // expect: no-client-writes
  const x = new XMLHttpRequest(); x.open('POST', `${base}/rest/v1/people`); // expect: no-client-writes
}

// lint-allow: no-client-writes an allow is itself an error // expect: no-client-writes
