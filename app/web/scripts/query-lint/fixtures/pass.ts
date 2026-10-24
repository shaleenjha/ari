// query-unbounded fixture: every select here is bounded, so the lint reports nothing. Repo only, never in prompts.
declare const sb: any;
declare const id: string;

export async function bounded() {
  await sb.from('people').select('id,name').limit(50);
  await sb.from('people').select('*').eq('id', id).single();
  await sb.from('tasks').select('*', { count: 'exact', head: true });
  let q = sb.from('replies').select('*').order('at');
  q = q.range(0, 24);
  const r = sb.from('accounts').select('*'); await r.maybeSingle();
  await sb.from('people').insert({ id }).select('id');
  await sb.from('people').update({ id }).eq('id', id).select();
  const u = Array.from({ length: 3 }, (_, i) => i);
  return [q, u];
}
