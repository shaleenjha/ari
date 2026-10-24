// query-unbounded fixture: each line carrying an expect marker must be reported, and nothing else.
// Repo only, never in prompts.
declare const sb: any;
declare const small: boolean;

export async function unbounded() {
  await sb.from('people').select('*'); // expect: query-unbounded
  const q2 = sb.from('replies').select('*'); // expect: query-unbounded
  if (small) q2.limit(5);
  await q2;
}

export function returned() {
  const q3 = sb.from('tasks').select('id'); return q3; // expect: query-unbounded
}

export async function inClosure() {
  const q4 = sb.from('notes').select('*').order('at'); // expect: query-unbounded
  const page = () => q4.limit(10);
  return [q4, page];
}

export async function allowed() {
  // lint-allow: query-unbounded fixture proves the inline allow suppresses exactly this select
  await sb.from('tiny_lookup').select('*');
}
