// Offline tests for ari-ai (fake database + scripted providers, synthetic data). Run: deno test --allow-env --allow-read <this dir>
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { Env, handle } from './handler.ts';
import { processPending } from './events.ts';
import { runJob } from './jobs.ts';
import { SERVICE_RPCS } from './db.ts';
import { draftReply, fakeDb, HOOK, OWNER_JWT, scripted } from './fakes_test_util.ts';
import { ledgerFor } from './db.ts';
import type { AiRequest, Provider } from '../_shared/ai/types.ts';

Deno.env.set('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
const GOOD = 'Hi Synthetic, saw Ostrevanthe Co shipped its vault; worth comparing notes?';

function mkEnv(providers: Record<string, Provider>, opts: { capUsd?: number; enabled?: boolean } = {}) {
  const f = fakeDb(opts);
  const bg: Promise<unknown>[] = []; const kicks: unknown[] = [];
  const env: Env = { db: f.db, deps: { ledger: ledgerFor(f.db), providers }, origins: ['https://app.example'],
    background: (p) => { bg.push(p); }, kick: (b) => { kicks.push(b); return Promise.resolve(); } };
  return { env, st: f.st, bg, kicks };
}
const post = (body: unknown, headers: Record<string, string> = { authorization: `Bearer ${OWNER_JWT}` }) =>
  new Request('https://fn.example/ari-ai', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

// ---------------- auth ----------------
Deno.test('auth: no session, a non-owner session, or a wrong hook are refused before any work', async () => {
  const { p, seen } = scripted('anthropic', [draftReply(GOOD)]);
  const { env, st } = mkEnv({ anthropic: p });
  assertEquals((await handle(post({ action: 'draft_dm1', person_id: 'P1' }, {}), env)).status, 401);
  assertEquals((await handle(post({ action: 'draft_dm1', person_id: 'P1' }, { authorization: 'Bearer aaa.bbb.someone' }), env)).status, 401);
  assertEquals((await handle(post({ internal: 'process' }, { 'x-ari-hook': 'wrong' }), env)).status, 401);
  assertEquals((await handle(post({ action: 'set_config', key: 'x' }), env)).status, 400);
  assertEquals((await handle(post({ action: 'draft_dm1', person_id: "P1'; drop table people" }), env)).status, 400);
  assertEquals(seen.length, 0); assertEquals(st.calls.length, 0);
});

// ---------------- actions ----------------
Deno.test('draft_dm1 writes only the DM slot, returns the validated draft, never overwrites Owner\'s edit', async () => {
  const { p, seen } = scripted('anthropic', [draftReply(GOOD)]);
  const { env, st } = mkEnv({ anthropic: p });
  const r = await handle(post({ action: 'draft_dm1', person_id: 'P1' }), env);
  const j = await r.json();
  assertEquals(r.status, 200); assertEquals(j.saved, true); assertEquals(st.people.get('P1').dm, GOOD);
  assertEquals(seen[0].model, 'claude-opus-5-5');
  st.people.get('P1').dm = 'Owner wrote this himself.';
  // 0047: an Accepted tap only queues research (DM1 comes after research + brief); a repeat tap is a no-op
  const r2 = await (await handle(post({ action: 'draft_dm1', person_id: 'P1', source: 'accepted_tap' }), env)).json();
  assertEquals(r2.status, 'queued'); assertEquals(r2.existing, false); assertEquals(st.people.get('P1').dm, 'Owner wrote this himself.');
  assertEquals((await (await handle(post({ action: 'draft_dm1', person_id: 'P1', source: 'accepted_tap' }), env)).json()).existing, true);
  assertEquals(st.pjobs.map((j) => j.stage), ['research']); assertEquals(seen.length, 1);
});

Deno.test('rewrite with a chip streams over SSE and saves only if the draft did not change underneath', async () => {
  const { p, seen } = scripted('anthropic', [draftReply('Hi Synthetic, Ostrevanthe Co shipped a vault; compare notes?')]);
  const { env, st } = mkEnv({ anthropic: p });
  st.people.get('P1').dm = GOOD;
  const r = await handle(post({ action: 'rewrite', draft_id: 'P1:dm1', chip: 'shorter', stream: true }), env);
  assertEquals(r.headers.get('content-type'), 'text/event-stream');
  const text = await r.text();
  assert(text.includes('event: delta') && text.includes('event: done') && !text.includes('@@META@@'));
  assert(String(seen[0].messages[0].content).includes('Make it shorter')); assertEquals(seen[0].model, 'claude-opus-5-5');
  assertEquals(st.people.get('P1').dm, 'Hi Synthetic, Ostrevanthe Co shipped a vault; compare notes?');
  assertEquals((await handle(post({ action: 'rewrite', draft_id: 'P1:dm1', chip: 'make it rude' }), env)).status, 400);
  assertEquals((await handle(post({ action: 'rewrite', draft_id: 'P2:dm9' }), env)).status, 400);
});

Deno.test('rewrite of a reply draft is scoped to that reply and key', async () => {
  const { p } = scripted('anthropic', [draftReply('Pricing scales with volume; ranges are easy to share.')]);
  const { env, st } = mkEnv({ anthropic: p });
  const j = await (await handle(post({ action: 'rewrite', draft_id: 'reply:7:answer', instruction: 'plainer' }), env)).json();
  assertEquals(j.saved, true);
  assertEquals(st.replies.get(7).drafts.map((d: { body: string }) => d.body), ['b', 'Pricing scales with volume; ranges are easy to share.', 's']);
});

Deno.test('triage_reply: Haiku classifies, Opus drafts book / answer / soft; saved through the reply drafts path', async () => {
  const cls = { intent: 'question', urgency: 'high', summary: 'Asked about price', needs_review: false };
  const dr = { needs_review: false, drafts: [{ key: 'book', label: 'Book', body: 'Happy to walk you through it on a short call?' },
    { key: 'answer', label: 'Answer', body: 'It scales with volume.' }, { key: 'soft', label: 'Soft', body: 'Glad it caught your eye.' }] };
  let dup = false;
  const { p, seen } = scripted('anthropic', [(req) => req.model === 'claude-haiku-5-5' ? JSON.stringify(cls)
    : JSON.stringify(dup ? { ...dr, drafts: [dr.drafts[0], dr.drafts[0], dr.drafts[1]] } : dr)]);
  const { env, st } = mkEnv({ anthropic: p });
  const r = await handle(post({ action: 'triage_reply', reply_id: 7 }), env);
  assertEquals(r.status, 200); assertEquals(st.replies.get(7).ai_triage.intent, 'question');
  assertEquals(seen.map((x) => x.model), ['claude-haiku-5-5', 'claude-opus-5-5']);
  dup = true;
  assertEquals((await handle(post({ action: 'triage_reply', reply_id: 7 }), env)).status, 502);   // duplicate keys refused
});

/** Sonnet stand-in for quick_research: returns a save_research tool call (or a bad stop) like the Messages API does. */
function researcher(input: Record<string, unknown> | null, opts: { stop?: string; searched?: string[] } = {}) {
  const seen: AiRequest[] = [];
  const p: Provider = { name: 'anthropic', complete(req) {
    seen.push(structuredClone(req));
    return Promise.resolve({ provider: 'anthropic', model: req.model, text: input ? '' : 'Here is what I found: {"summary": "cut', tokensIn: 3000,
      tokensOut: 900, toolCalls: 2, citations: [], searchUrls: opts.searched ?? [],
      toolUses: input ? [{ id: 'tu1', name: 'save_research', input }] : [], stopReason: opts.stop ?? (input ? 'tool_use' : 'end_turn') });
  } };
  return { p, seen };
}
const RESEARCH = { summary: 's', confidence: 0.9, angles: ['a'], findings: [
  { fact: 'Raised a round', source_url: 'https://example.com/news/1', dated: '2026-09-01' },
  { fact: 'Invented', source_url: 'https://made-up.example/x', dated: '' }] };

Deno.test('quick_research: answer comes from the strict save_research tool; only urls the search returned are kept', async () => {
  const { p, seen } = researcher(RESEARCH, { searched: ['https://example.com/news/1?utm=1'] });
  const { env, st } = mkEnv({ anthropic: p });
  const j = await (await handle(post({ action: 'quick_research', person_id: 'P1' }), env)).json();
  assertEquals(j.research.findings.length, 1); assertEquals(st.research.length, 1); assertEquals(j.research.findings[0].dated, '2026-09-01');
  assertEquals(seen[0].tools, ['web_search']); assert(j.research.confidence <= 0.6);
  assertEquals(seen[0].clientTools?.[0].name, 'save_research'); assertEquals(seen[0].clientTools?.[0].strict, true);
  assertEquals([seen[0].thinking, seen[0].effort, seen[0].maxTokens, seen[0].retries], ['between_tools', 'low', 4000, 0]);
  assertEquals(st.calls[0].status, 'ok');
});

Deno.test('quick_research: max_tokens / refusal / no tool call -> invalid, cost booked, nothing saved, one call only', async () => {
  for (const [input, stop] of [[RESEARCH, 'max_tokens'], [RESEARCH, 'refusal'], [null, 'end_turn']] as const) {
    const { p, seen } = researcher(input as Record<string, unknown> | null, { stop });
    const { env, st } = mkEnv({ anthropic: p });
    const r = await handle(post({ action: 'quick_research', person_id: 'P1' }), env);
    assertEquals(r.status, 502); assertEquals(st.research.length, 0); assertEquals(seen.length, 1);
    assertEquals(st.calls[0].status, 'invalid'); assert(st.calls[0].cost > 0);     // the spend is recorded, never hidden
  }
  const { p } = researcher({ ...RESEARCH, confidence: 'high' });                       // wrong type -> invalid, not coerced
  const { env, st } = mkEnv({ anthropic: p });
  assertEquals((await handle(post({ action: 'quick_research', person_id: 'P1' }), env)).status, 502); assertEquals(st.research.length, 0);
});

/** Opus orchestrator stand-in: replays a fixed tool-call script, one assistant turn per call. */
function orchestrator(turns: Array<Array<{ name: string; input: Record<string, unknown> }>>) {
  const seen: AiRequest[] = []; let i = 0;
  const p: Provider = { name: 'anthropic', complete(req) {
    seen.push(structuredClone(req));
    const uses = (turns[i++] ?? []).map((u, k) => ({ id: `tu${i}_${k}`, ...u }));
    return Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 2000, tokensOut: 300, toolCalls: 0, citations: [],
      toolUses: uses, stopReason: uses.length ? 'tool_use' : 'end_turn', content: uses.map((u) => ({ type: 'tool_use', ...u })) });
  } };
  return { p, seen };
}
const GROK = JSON.stringify({ results: [{ title: 'Ostrevanthe Co ships a vault', url: 'https://news.example.com/vault', published: '2026-10-20' },
  { title: 'CTO post on PII', url: 'https://x.com/exampleco/status/1' }] });
const SCRIPT = [
  [{ name: 'grok_search', input: { query: 'Ostrevanthe Co data privacy', source: 'x' } }],
  [{ name: 'record_finding', input: { fact: 'Ostrevanthe Co shipped a vault', source_url: 'https://news.example.com/vault', dated: '2026-10-20' } },
   { name: 'record_finding', input: { fact: 'Made up', source_url: 'https://invented.example/x' } },
   { name: 'grok_search', input: { query: 'Ostrevanthe Co CTO talks', source: 'web' } }],
  [{ name: 'finish', input: { summary: 'Vault launch and PII focus.', angles: ['vault launch'], confidence: 0.8 } }],
];

Deno.test('deep_research: Opus orchestrates, Grok searches (x / web), live feed of queries, reads and findings', async () => {
  const o = orchestrator(SCRIPT);
  const { p: g, seen: gs } = scripted('xai', [GROK], ['https://news.example.com/vault', 'https://x.com/exampleco/status/1']);
  const { env, st, kicks } = mkEnv({ anthropic: o.p, xai: g });
  const a = await (await handle(post({ action: 'deep_research', person_id: 'P1', focus: 'privacy' }), env)).json();
  const b = await (await handle(post({ action: 'deep_research', person_id: 'P1' }), env)).json();
  assertEquals(a.job_id, b.job_id); assertEquals(b.existing, true); assertEquals(kicks.length, 1);
  assertEquals(await runJob(env.db, env.deps, a.job_id, 1_000_000), 'done');
  const job = st.jobs.get(a.job_id);
  const types = job.steps.map((e: { type: string }) => e.type);
  assertEquals(types, ['status', 'status', 'query', 'read', 'read', 'finding', 'query', 'status']);
  const q = job.steps.find((e: { type: string }) => e.type === 'query');
  assertEquals([q.source, q.query], ['x', 'Ostrevanthe Co data privacy']);
  const rd = job.steps.find((e: { type: string }) => e.type === 'read');
  assertEquals([rd.title, rd.domain], ['Ostrevanthe Co ships a vault', 'news.example.com']);
  assertEquals(job.steps.filter((e: { type: string }) => e.type === 'finding').length, 1);   // invented url rejected
  assert(job.steps.every((e: { seq: number }, i: number, xs: { seq: number }[]) => i === 0 || e.seq > xs[i - 1].seq));
  assertEquals(o.seen.map((r) => r.model), ['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5']);
  assertEquals(o.seen[0].clientTools?.map((t) => t.name), ['grok_search', 'record_finding', 'finish']);
  assertEquals(gs.map((r) => [r.model, r.tools?.join()]), [['grok-4.7', 'x_search'], ['grok-4.7', 'web_search']]);
  assertEquals(st.research.length, 1); assert(st.pushes.includes('brief:' + a.job_id));
  assertEquals(job.result.findings.length, 1);
});

Deno.test('deep_research: yields with saved state when the start window is spent, then resumes where it left off', async () => {
  const o = orchestrator(SCRIPT);
  const { p: g } = scripted('xai', [GROK], ['https://news.example.com/vault', 'https://x.com/exampleco/status/1']);
  const { env, st } = mkEnv({ anthropic: o.p, xai: g });
  const a = await (await handle(post({ action: 'deep_research', person_id: 'P1' }), env)).json();
  let t = 0; assertEquals(await runJob(env.db, env.deps, a.job_id, 10, () => (t += 8)), 'yield');
  assertEquals(st.jobs.get(a.job_id).status, 'queued'); assert(st.jobs.get(a.job_id).result.state.turns >= 1);
  assertEquals(await runJob(env.db, env.deps, a.job_id, 1_000_000), 'done');
  assertEquals(o.seen.length, 3);                                   // no turn repeated after the resume
});

Deno.test('job_stream: SSE relays each new event by seq, then done; refuses a bad id; owner only', async () => {
  const o = orchestrator(SCRIPT);
  const { p: g } = scripted('xai', [GROK], ['https://news.example.com/vault', 'https://x.com/exampleco/status/1']);
  const { env } = mkEnv({ anthropic: o.p, xai: g });
  env.sleep = () => Promise.resolve();
  const a = await (await handle(post({ action: 'deep_research', person_id: 'P1' }), env)).json();
  await runJob(env.db, env.deps, a.job_id, 1_000_000);
  const r = await handle(post({ action: 'job_stream', job_id: a.job_id, since: 2 }), env);
  assertEquals(r.headers.get('content-type'), 'text/event-stream');
  const txt = await r.text();
  assertEquals((txt.match(/event: progress/g) ?? []).length, 6); assert(txt.trimEnd().split('\n\n').at(-1)!.startsWith('event: done'));
  assertEquals((await handle(post({ action: 'job_stream', job_id: 'x' }), env)).status, 400);
  assertEquals((await handle(post({ action: 'job_stream', job_id: a.job_id }, {}), env)).status, 401);
});

// ---------------- budget ----------------
Deno.test('budget: over the cap the app gets spend_limit and no provider is called; deep research is refused up front', async () => {
  const { p, seen } = scripted('anthropic', [draftReply(GOOD)]);
  const { p: x, seen: xs } = scripted('xai', ['{}']);
  const { env } = mkEnv({ anthropic: p, xai: x }, { capUsd: 0.0001 });
  const r = await handle(post({ action: 'draft_dm1', person_id: 'P1' }), env);
  assertEquals(r.status, 429); assertEquals((await r.json()).error, 'spend_limit');
  assertEquals((await handle(post({ action: 'deep_research', person_id: 'P1' }), env)).status, 429);
  assertEquals(seen.length + xs.length, 0);
  const off = mkEnv({ anthropic: p }, { enabled: false });
  assertEquals((await handle(post({ action: 'draft_dm1', person_id: 'P1' }), off.env)).status, 429);
});

// ---------------- event path idempotency ----------------
Deno.test('event path: a redelivered accept or an overlapping run queues research once and never drafts DM1 itself', async () => {
  const cls = JSON.stringify({ is_accept: true, person_id: 'P1', confidence: 0.95, reason: 'vanity match' });
  const { p, seen } = scripted('anthropic', [(req) => (req.model === 'claude-haiku-5-5' ? cls : draftReply(GOOD))]);
  const { env, st } = mkEnv({ anthropic: p });
  st.pending.accepts.push({ msg_id: 'm1', name: 'Synthetic Person', profile_url: 'https://www.linkedin.com/in/synthetic', match: 'P1',
    candidates: [{ id: 'P1', name: 'Synthetic Person' }] });
  st.pending.dm1_needed.push('P1');
  const a = await processPending(env.db, env.deps);
  const b = await processPending(env.db, env.deps);
  assertEquals(a.accept_matched, 1); assertEquals(a.pipeline_queued, 1);
  assertEquals(b.pipeline_existing, 1, JSON.stringify(b));          // dm1_needed again: same job key, nothing new
  assertEquals(seen.length, 1);                                    // one classify; no draft call on the event path
  assertEquals(st.pjobs.length, 1); assertEquals(st.pjobs[0].stage, 'research'); assertEquals(st.people.get('P1').dm, null);
});

Deno.test('event path: classify must agree with the deterministic match, else needs_review and no draft', async () => {
  const { p, seen } = scripted('anthropic', [JSON.stringify({ is_accept: true, person_id: 'P9', confidence: 0.9, reason: 'x' })]);
  const { env, st } = mkEnv({ anthropic: p });
  st.pending.accepts.push({ msg_id: 'm2', name: 'Synthetic Person', match: 'P1', candidates: [{ id: 'P1' }, { id: 'P9' }] });
  const r = await processPending(env.db, env.deps);
  assertEquals(r.accept_unmatched, 1); assertEquals(st.triggers.get('accept:m2'), 'needs_review'); assertEquals(seen.length, 1);
  assertEquals(st.pushes.length, 0);
});

Deno.test('internal process answers 202 at once and does the work in the background', async () => {
  const { p } = scripted('anthropic', [draftReply(GOOD)]);
  const { env, bg } = mkEnv({ anthropic: p });
  const r = await handle(post({ internal: 'process' }, { 'x-ari-hook': HOOK }), env);
  assertEquals(r.status, 202); assertEquals(bg.length, 1); await Promise.all(bg);
});

// ---------------- "no send" guarantees (static) ----------------
Deno.test('no send: no source file talks to LinkedIn, every request goes through the guarded fetch, RPCs are read/draft only', async () => {
  const dirs = ['.', '../_shared/ai', '../_shared/import', '../ari-gmail-push'].map((d) => new URL(d + '/', import.meta.url));
  for (const d of dirs) {
    for await (const e of Deno.readDir(d)) {
      if (!e.name.endsWith('.ts') || e.name.includes('_test')) continue;
      const src = (await Deno.readTextFile(new URL(e.name, d))).split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
      assert(!/linkedin\.com\/(voyager|messaging|v2|rest)/i.test(src), `${e.name}: LinkedIn API reference`);
      if (e.name !== 'http.ts') assert(!/[^.\w]fetch\(/.test(src.replace(/guardedFetch\(/g, '')), `${e.name}: raw fetch outside http.ts`);
    }
  }
  for (const fn of SERVICE_RPCS) assert(!/config|app_change|sent|send|delete|grant|budget_set/i.test(fn.replace('ari_ai_', '')), fn);
  const { db } = fakeDb();
  // deno-lint-ignore no-explicit-any
  let refused = false; try { await db.rpc('ari_set_app_config' as any); } catch { refused = true; }
  assert(refused);
});

// ---------------- import_resolve (spec 08) ----------------
Deno.test('import_resolve: returns a prepared plan, writes nothing, validates rows and caps size', async () => {
  const { p, seen } = scripted('anthropic', [draftReply(GOOD)]);
  const { env, st } = mkEnv({ anthropic: p });
  const asked: string[] = [];
  env.lookup = { find(q) { asked.push(q.name); return Promise.resolve({ candidates: [{ full_name: 'New Person', company: 'Other Co',
    title: 'VP Security', linkedin_url: 'https://www.linkedin.com/in/new-person-synthetic', source: 'brave' }] }); } };
  const rows = [
    { name: 'Synthetic Person', company: 'Ostrevanthe Co' },                                                  // already in the book
    { name: 'Has Url', company: 'Url Co', linkedin_url: 'https://www.linkedin.com/in/has-url-synthetic' }, // clean add
    { name: 'New Person', company: 'Other Co' },                                                          // missing URL, exact match
  ];
  const r = await handle(post({ action: 'import_resolve', rows }), env);
  assertEquals(r.status, 200);
  const { plan } = await r.json();
  assertEquals(plan.add, [2]);
  assertEquals(plan.flags.map((f: { kind: string; chosen: string }) => `${f.kind}:${f.chosen}`), ['duplicate:skip', 'missing_url:use_profile']);
  assertEquals(asked, ['New Person']); assertEquals(seen.length, 0);                    // exact match: no AI call
  assert(!st.rpcLog.some((f) => /save|enqueue|notify/.test(f)), 'import_resolve must not write');
  assertEquals((await handle(post({ action: 'import_resolve', rows: [] }), env)).status, 400);
  assertEquals((await handle(post({ action: 'import_resolve', rows: [{ name: 'No Company' }] }), env)).status, 400);
  assertEquals((await handle(post({ action: 'import_resolve', rows: Array.from({ length: 101 }, (_, i) => ({ name: 'N' + i, company: 'C' })) }), env)).status, 400);
  assertEquals((await handle(post({ action: 'draft_dm1', person_id: 'P1', pad: 'x'.repeat(9000) }), env)).status, 413);
});
