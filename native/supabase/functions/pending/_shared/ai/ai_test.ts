// Offline tests for the shared AI layer (mocked transport and providers, synthetic data). Run:
//   deno test --allow-env native/supabase/functions/pending/_shared/ai/ native/supabase/functions/pending/ari-ai/ native/supabase/functions/pending/ari-gmail-push/
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { allowedHost, guardedFetch, HttpError, setTransport } from './http.ts';
import { costUsd, reserveUsd, ROUTES, route } from './router.ts';
import { DraftOut, extractJson, ReplyDraftsOut, ResearchOut, TriageClassOut } from './schema.ts';
import { META, rewritePrompt, splitDraft } from './prompts.ts';
import { parseAnthropic, parseResponsesApi, anthropic } from './providers.ts';
import { BudgetRefused, InvalidOutput, Ledger, runDraft, runDraftStream, runTask } from './run.ts';
import { draftReply, scripted } from '../../ari-ai/fakes_test_util.ts';
import type { Provider } from './types.ts';

Deno.env.set('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');

function memLedger(cap = 30) {
  let spent = 0; const rows: Array<Record<string, unknown>> = [];
  const l: Ledger = {
    reserve(a) { if (spent + a.estUsd > cap) { rows.push({ status: 'refused' }); return Promise.resolve({ ok: false, reason: 'monthly_cap' }); }
      spent += a.estUsd; rows.push({ ...a, status: 'reserved' }); return Promise.resolve({ ok: true, callId: rows.length }); },
    finish(id, a) { Object.assign(rows[id - 1], a); return Promise.resolve(); },
  };
  return { l, rows };
}

// ---------------- routing ----------------
Deno.test('routing (Owner, Oct 23 15:11 IST): Opus drafts everything, Haiku only classifies, Sonnet quick research, Opus + Grok deep', () => {
  const m = (t: Parameters<typeof route>[0]) => [route(t).provider, route(t).model].join(' ');
  for (const t of ['draft', 'rewrite', 'reply_draft'] as const) assertEquals(m(t), 'anthropic claude-opus-5-5');
  for (const t of ['classify', 'triage'] as const) assertEquals(m(t), 'anthropic claude-haiku-5-5');
  assertEquals(m('quick_research'), 'anthropic claude-sonnet-5-5'); assertEquals(route('quick_research').tools, ['web_search']);
  assertEquals(m('deep_research'), 'anthropic claude-opus-5-5'); assertEquals(route('deep_research').tools, undefined);
  assertEquals(m('signal_search'), 'xai grok-4.7'); assertEquals(route('signal_search').tools, ['x_search', 'web_search']);
  const drafting = ['draft', 'rewrite', 'reply_draft'];
  assert(drafting.every((k) => ROUTES[k as keyof typeof ROUTES].model === 'claude-opus-5-5'), drafting.join());
  assert(route('draft').stream && route('rewrite').stream && !route('classify').stream);
  assert(Object.values(ROUTES).every((r) => r.provider !== 'openai'), 'openai is a backup stub, never routed by default');
});

Deno.test('cost: reservation is the worst case and unknown models price high', () => {
  assert(reserveUsd('draft', 7000) >= costUsd('claude-opus-5-5', 2000, 900));
  assert(reserveUsd('deep_research', 12000, 4) > reserveUsd('deep_research', 12000, 1));
  assert(costUsd('claude-opus-5-5', 1e6, 1e6) > costUsd('claude-sonnet-5-5', 1e6, 1e6));
  assert(costUsd('mystery-model', 1e6, 0) > costUsd('claude-sonnet-5-5', 1e6, 0));
});

// ---------------- schemas ----------------
Deno.test('schema: draft contract accepts the right shape and rejects the wrong one', () => {
  const ok = DraftOut.parse({ text: ' Hi Sam ', rationale: 'r', source_facts: [{ fact: 'f' }], confidence: 0.7, needs_review: false, extra: 1 });
  assert(ok.ok); if (ok.ok) { assertEquals(ok.value.text, 'Hi Sam'); assert(!('extra' in ok.value)); }
  assert(!DraftOut.parse({ text: '', rationale: 'r', source_facts: [], confidence: 0.7, needs_review: false }).ok);
  assert(!DraftOut.parse({ text: 'x', rationale: 'r', source_facts: [], confidence: 1.5, needs_review: false }).ok);
  assert(!DraftOut.parse({ text: 'x', rationale: 'r', source_facts: 'nope', confidence: 0.5, needs_review: false }).ok);
  assert(!DraftOut.parse({ text: 'x', rationale: 'r', source_facts: [], confidence: 0.5 }).ok, 'needs_review is required');
  const cls = { intent: 'question', urgency: 'high', summary: 's', needs_review: false };
  assert(TriageClassOut.parse(cls).ok); assert(!TriageClassOut.parse({ ...cls, intent: 'buy now' }).ok);
  const rd = { needs_review: false, drafts: [{ key: 'book', label: 'B', body: 'b' }, { key: 'answer', label: 'A', body: 'a' }, { key: 'soft', label: 'S', body: 's' }] };
  assert(ReplyDraftsOut.parse(rd).ok); assert(!ReplyDraftsOut.parse({ ...rd, drafts: rd.drafts.slice(0, 2) }).ok);
  assert(!ReplyDraftsOut.parse({ ...rd, drafts: [...rd.drafts.slice(0, 2), { key: 'soft', label: 'S', body: 'x'.repeat(301) }] }).ok);
  assert(!ResearchOut.parse({ summary: 's', findings: [{ fact: 'f', source_url: 'x' }], angles: [], confidence: 0.5 }).ok);
  assertEquals(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assertEquals(splitDraft(`Hello\n${META}\n{"rationale":"r"}`), { rationale: 'r', text: 'Hello' });
});

// ---------------- transport: allowlist, timeout, one retry ----------------
Deno.test('http: LinkedIn and unknown hosts are refused before any request', async () => {
  let calls = 0; setTransport(() => { calls++; return Promise.resolve(new Response('{}')); });
  for (const u of ['https://www.linkedin.com/voyager/api/messaging', 'https://api.linkedin.com/v2/messages', 'https://lnkd.in/x',
    'https://evil.example.com/', 'http://api.anthropic.com/v1/messages']) {
    assert(!allowedHost(u), u);
    await assertRejects(() => guardedFetch(u, {}, { timeoutMs: 1000 }), HttpError);
  }
  assertEquals(calls, 0);
  assert(allowedHost('https://api.anthropic.com/v1/messages') && allowedHost('https://api.x.ai/v1/responses'));
  assert(allowedHost('https://abcdefghijklmnopqrst.supabase.co/rest/v1/rpc/x'));
  setTransport(null);
});

Deno.test('http: retries exactly once on 5xx / 429, never on 4xx', async () => {
  let n = 0;
  setTransport(() => { n++; return Promise.resolve(new Response('x', { status: n === 1 ? 503 : 200 })); });
  assertEquals((await guardedFetch('https://api.anthropic.com/v1/messages', {}, { timeoutMs: 1000 })).status, 200);
  assertEquals(n, 2);
  n = 0; setTransport(() => { n++; return Promise.resolve(new Response('x', { status: 429 })); });
  await assertRejects(() => guardedFetch('https://api.anthropic.com/v1/messages', {}, { timeoutMs: 1000 }), HttpError);
  assertEquals(n, 2);
  n = 0; setTransport(() => { n++; return Promise.resolve(new Response('x', { status: 400 })); });
  await assertRejects(() => guardedFetch('https://api.anthropic.com/v1/messages', {}, { timeoutMs: 1000 }), HttpError);
  assertEquals(n, 1);
  n = 0; setTransport((_u, i) => { n++; return new Promise((_, rej) => i?.signal?.addEventListener('abort', () => rej(new DOMException('a', 'AbortError')))); });
  const e = await assertRejects(() => guardedFetch('https://api.x.ai/v1/responses', {}, { timeoutMs: 30 }), HttpError);
  assert(e.message.includes('timeout')); assertEquals(n, 2);
  setTransport(null);
});

Deno.test('providers: keys only in the auth header, never in errors; missing key fails closed', async () => {
  Deno.env.set('ANTHROPIC_API_KEY', 'sk-ant-SYNTHETICKEY0000000000');
  let hdr: Headers | null = null;
  setTransport((_u, i) => { hdr = new Headers(i?.headers); return Promise.resolve(new Response('{"error":"bad"}', { status: 401 })); });
  const e = await assertRejects(() => anthropic.complete({ model: 'm', system: 's', messages: [], maxTokens: 10, timeoutMs: 500 }));
  assert(!String((e as Error).message).includes('SYNTHETICKEY'));
  assertEquals(hdr!.get('x-api-key'), 'sk-ant-SYNTHETICKEY0000000000');
  Deno.env.delete('ANTHROPIC_API_KEY');
  await assertRejects(() => anthropic.complete({ model: 'm', system: 's', messages: [], maxTokens: 10, timeoutMs: 500 }), Error, 'not configured');
  setTransport(null);
});

Deno.test('providers: response parsing (Anthropic blocks + citations, xAI Responses API)', () => {
  const a = parseAnthropic({ model: 'claude-sonnet-5-5', content: [{ type: 'server_tool_use' }, { type: 'text', text: 'Hi ',
    citations: [{ url: 'https://example.com/a' }] }, { type: 'text', text: 'there' }],
    usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 2 } } }, 'x');
  assertEquals([a.text, a.tokensIn, a.tokensOut, a.toolCalls, a.citations.length], ['Hi there', 10, 5, 2, 1]);
  const tu = parseAnthropic({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'Searching.' },
    { type: 'tool_use', id: 'tu1', name: 'grok_search', input: { query: 'q', source: 'x' } }], usage: {} }, 'claude-opus-5-5');
  assertEquals([tu.stopReason, tu.toolUses![0].name, tu.content!.length], ['tool_use', 'grok_search', 2]);
  const x = parseResponsesApi({ output: [{ type: 'web_search_call' }, { type: 'x_search_call' }, { type: 'message', content: [{ type: 'output_text',
    text: '{"a":1}', annotations: [{ type: 'url_citation', url: 'https://x.com/s/1' }] }] }], usage: { input_tokens: 3, output_tokens: 4 } }, 'grok-4.7', 'xai');
  assertEquals([x.text, x.toolCalls, x.citations[0].url], ['{"a":1}', 2, 'https://x.com/s/1']);
});

// ---------------- runner: budget, validation, streaming ----------------
Deno.test('budget refusal: no provider call is made', async () => {
  const { l, rows } = memLedger(0.000001);
  const { p, seen } = scripted('anthropic', [draftReply('Hi Synthetic')]);
  await assertRejects(() => runDraft('draft', { system: 's', user: 'u' }, { ledger: l, providers: { anthropic: p } }), BudgetRefused);
  assertEquals(seen.length, 0); assertEquals(rows[0].status, 'refused');
});

Deno.test('invalid model output is booked as invalid and never returned', async () => {
  const { l, rows } = memLedger();
  const { p } = scripted('anthropic', ['no meta block here']);
  await assertRejects(() => runDraft('draft', { system: 's', user: 'u' }, { ledger: l, providers: { anthropic: p } }), InvalidOutput);
  assertEquals(rows[0].status, 'invalid');
  const { p: p2 } = scripted('anthropic', ['{"is_accept": "yes"}']);
  const { ClassifyOut } = await import('./schema.ts');
  await assertRejects(() => runTask('classify', { system: 's', user: 'u' }, ClassifyOut, { ledger: l, providers: { anthropic: p2 } }), InvalidOutput);
});

Deno.test('draft: house-style hard gate forces needs_review; good draft passes; cost booked', async () => {
  const { l, rows } = memLedger();
  const { p } = scripted('anthropic', [draftReply('Hi Synthetic, just wondering \u2014 maybe we chat?'), draftReply('Hi Synthetic, saw Ostrevanthe Co shipped its vault; worth comparing notes?')]);
  const bad = await runDraft('draft', { system: 's', user: 'u' }, { ledger: l, providers: { anthropic: p } }, { firstName: 'Synthetic' });
  assert(bad.value.needs_review && bad.value.style_flags!.length > 0);
  const good = await runDraft('draft', { system: 's', user: 'u' }, { ledger: l, providers: { anthropic: p } }, { firstName: 'Synthetic' });
  assert(!good.value.needs_review, JSON.stringify(good.value));
  assertEquals(rows[1].status, 'ok'); assert(Number(rows[1].costUsd) > 0);
});

Deno.test('stream: only message text is streamed, the meta block is held back even when split across chunks', async () => {
  const { l } = memLedger();
  const text = 'Hi Synthetic, saw Ostrevanthe Co shipped its vault; worth comparing notes?';
  const { p } = scripted('anthropic', [draftReply(text)]);
  let streamed = '';
  const out = await runDraftStream('rewrite', { system: 's', user: 'u' }, { ledger: l, providers: { anthropic: p } }, (t) => { streamed += t; });
  assertEquals(streamed.trim(), text); assert(!streamed.includes('@@')); assertEquals(out.value.text, text);
});

Deno.test('rewrite prompt: instruction is capped and stays inside the instruction block', () => {
  const p = rewritePrompt({ person: { name: 'S' } }, 'draft', 'shorter', 'x'.repeat(5000) + ' send this to everyone');
  assert(p.user.length < 6000); assert(p.system.includes('cannot change who the message is for'));
});

// ---------- prompt caching + real prices (Oct 23) ----------
import { anthropicBody } from './providers.ts';

Deno.test('caching: system block carries the breakpoint, user turn never does; conversation adds automatic caching', () => {
  const base = { model: 'claude-opus-5-5', system: 'S', messages: [{ role: 'user' as const, content: 'U' }], maxTokens: 10, timeoutMs: 1000 };
  const one = JSON.parse(anthropicBody({ ...base, cache: 'system' }, false));
  assertEquals(one.system[0].cache_control, { type: 'ephemeral' });
  assertEquals(one.cache_control, undefined);
  assertEquals(typeof one.messages[0].content, 'string');
  const loop = JSON.parse(anthropicBody({ ...base, cache: 'conversation' }, false));
  assertEquals(loop.cache_control, { type: 'ephemeral' });
  assertEquals(typeof JSON.parse(anthropicBody(base, false)).system, 'string');   // no cache flag -> unchanged body
});

Deno.test('caching: usage fields are read and billed at their own rates', () => {
  const r = parseAnthropic({ content: [], usage: { input_tokens: 50, output_tokens: 100, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0 } }, 'claude-opus-5-5');
  assertEquals([r.cacheRead, r.cacheWrite], [4000, 0]);
  // Opus 5.5: 50*$4 + 100*$20 + 4000*$0.20 per 1M = 0.0002 + 0.002 + 0.0008
  assertEquals(costUsd('claude-opus-5-5', 50, 100, 0, 4000, 0), 0.003);
  assert(costUsd('claude-opus-5-5', 0, 0, 0, 4000, 0) < costUsd('claude-opus-5-5', 4000, 0) / 10);
  assert(reserveUsd('draft', 7000) >= costUsd('claude-opus-5-5', 0, 900, 0, 0, 2000));   // reserve covers a cold cache
});

// ---------- thinking off on short JSON tasks (live check Oct 23: Haiku 5.5 spent a 20-token budget thinking) ----------
Deno.test('thinking: Haiku JSON routes send thinking disabled; drafts and research leave the model default', () => {
  for (const t of ['classify', 'triage', 'match_profile'] as const) assertEquals(ROUTES[t].thinking, 'off');
  for (const t of ['draft', 'rewrite', 'reply_draft', 'deep_research'] as const) assertEquals(ROUTES[t].thinking, undefined);
  assertEquals(ROUTES.quick_research.thinking, 'between_tools');   // Sonnet 5.5 refuses 'disabled'; between_tools = no up-front thinking
  const base = { model: 'claude-haiku-5-5', system: 'S', messages: [{ role: 'user' as const, content: 'U' }], maxTokens: 10, timeoutMs: 1000 };
  assertEquals(JSON.parse(anthropicBody({ ...base, thinking: 'off' }, false)).thinking, { type: 'disabled' });
  assertEquals(JSON.parse(anthropicBody(base, false)).thinking, undefined);
});

Deno.test('anthropic body never carries temperature (5.5 models answer 400 to it, live check Oct 23)', () => {
  for (const r of Object.values(ROUTES)) if (r.provider === 'anthropic') assertEquals(r.temperature, undefined);
  const b = JSON.parse(anthropicBody({ model: 'claude-opus-5-5', system: 'S', messages: [{ role: 'user', content: 'U' }], maxTokens: 10,
    timeoutMs: 1000, temperature: 0.7 }, false));
  assertEquals(b.temperature, undefined);
  for (const r of Object.values(ROUTES)) if (r.thinking === 'off') assertEquals(r.model, 'claude-haiku-5-5');   // only Haiku accepts disabled
});

// ---------- quick_research fix (Oct 28 2026 staging e2e: reply cut at max_tokens before the JSON) ----------
Deno.test('quick_research route: between_tools thinking, low effort, 4000 tokens, no retry; body carries them and a strict tool', () => {
  const r = ROUTES.quick_research;
  assertEquals([r.model, r.maxTokens, r.thinking, r.effort, r.retries], ['claude-sonnet-5-5', 4000, 'between_tools', 'low', 0]);
  const b = JSON.parse(anthropicBody({ model: r.model, system: 'S', messages: [{ role: 'user', content: 'U' }], maxTokens: r.maxTokens,
    timeoutMs: 1000, tools: ['web_search'], maxToolUses: 3, thinking: r.thinking, effort: r.effort,
    clientTools: [{ name: 'save_research', description: 'd', input_schema: { type: 'object' }, strict: true }] }, false));
  assertEquals(b.thinking, { type: 'between_tools' }); assertEquals(b.output_config, { effort: 'low' }); assertEquals(b.max_tokens, 4000);
  assertEquals(b.tools.map((t: { name: string }) => t.name), ['web_search', 'save_research']); assertEquals(b.tools[1].strict, true);
  assertEquals(b.tool_choice, undefined);            // forced tool_choice is a 400 on Sonnet 5.5: auto + strict tool instead
});

// ---------------- Oct 28 2026 Phase B fix: DM1 cut at the token cap ----------------
Deno.test('dm1 fix: draft / rewrite routes have >= 2500 output tokens and effort low; the request body carries the effort', () => {
  for (const t of ['draft', 'rewrite'] as const) {
    assert(route(t).maxTokens >= 2500, `${t} maxTokens ${route(t).maxTokens}`);
    assertEquals(route(t).effort, 'low');
  }
  const body = JSON.parse(anthropicBody({ model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 3000,
    timeoutMs: 1000, effort: route('draft').effort }, true));
  assertEquals(body.output_config, { effort: 'low' }); assertEquals(body.max_tokens, 3000); assert(!('thinking' in body) && !('temperature' in body));
});

Deno.test('dm1 fix: the Anthropic stream parser yields message_delta stop_reason', async () => {
  const sse = ['event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":3122}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi Dana"}}',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":3000}}',
    'event: message_stop\ndata: {"type":"message_stop"}'].join('\n\n') + '\n\n';
  Deno.env.set('ANTHROPIC_API_KEY', 'test-key-not-real');
  setTransport(() => Promise.resolve(new Response(sse, { headers: { 'content-type': 'text/event-stream' } })));
  const evs = [];
  for await (const e of anthropic.stream!({ model: 'claude-opus-5-5', system: 's', messages: [{ role: 'user', content: 'u' }], maxTokens: 3000, timeoutMs: 2000 })) evs.push(e);
  setTransport(null); Deno.env.delete('ANTHROPIC_API_KEY');
  assertEquals(evs.filter((e) => e.type === 'stop'), [{ type: 'stop', reason: 'max_tokens' }]);
  assertEquals(evs.find((e) => e.type === 'usage' && e.tokensOut)?.type, 'usage');
});

Deno.test('dm1 fix: a reply stopped at max_tokens fails as "stop_reason max_tokens" (stream and non-stream), cost booked, never parsed', async () => {
  const cut = `Hi Dana, saw the UpGuard flag.\n${META}\n{"rationale":"r","source_facts":[{"fact":"a","source":"https://x.example"},`;
  // streaming: the provider ends with stop max_tokens after a cut meta block
  const { l, rows } = memLedger();
  const stream: Provider = { name: 'anthropic', complete: () => Promise.reject(new Error('unused')),
    async *stream() { yield { type: 'usage', tokensIn: 3122 }; yield { type: 'delta', text: cut }; yield { type: 'usage', tokensOut: 3000 };
      yield { type: 'stop', reason: 'max_tokens' }; } };
  const seen: string[] = [];
  const e1 = await assertRejects(() => runDraftStream('draft', { system: 's', user: 'u' }, { ledger: l, providers: { anthropic: stream } },
    (t) => { seen.push(t); }), InvalidOutput);
  assertEquals(e1.message, 'draft: stop_reason max_tokens');
  assertEquals([rows[0].status, rows[0].error, rows[0].tokensOut], ['invalid', 'stop_reason max_tokens', 3000]);
  assert(Number(rows[0].costUsd) > 0);
  // non-streaming (the pipeline's dm1 path): same reason, no JSON parse error
  const m2 = memLedger();
  const full: Provider = { name: 'anthropic', complete: (req) => Promise.resolve({ provider: 'anthropic', model: req.model, text: cut, tokensIn: 3122,
    tokensOut: 3000, toolCalls: 0, citations: [], stopReason: 'max_tokens' }) };
  const e2 = await assertRejects(() => runDraft('draft', { system: 's', user: 'u' }, { ledger: m2.l, providers: { anthropic: full } }), InvalidOutput);
  assertEquals(e2.message, 'draft: stop_reason max_tokens');
  assertEquals([m2.rows[0].status, m2.rows[0].error], ['invalid', 'stop_reason max_tokens']);
  // a refusal is reported the same way; a clean end_turn still parses
  const m3 = memLedger();
  const ref: Provider = { name: 'anthropic', complete: (req) => Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 10,
    tokensOut: 1, toolCalls: 0, citations: [], stopReason: 'refusal' }) };
  assertEquals((await assertRejects(() => runDraft('draft', { system: 's', user: 'u' }, { ledger: m3.l, providers: { anthropic: ref } }), InvalidOutput)).message,
    'draft: stop_reason refusal');
  const m4 = memLedger();
  const ok: Provider = { name: 'anthropic', complete: (req) => Promise.resolve({ provider: 'anthropic', model: req.model, tokensIn: 10, tokensOut: 100,
    toolCalls: 0, citations: [], stopReason: 'end_turn', text: draftReply('Hi Sam, Ostrevanthe Co shipped a vault. Who owns it?') }) };
  assertEquals((await runDraft('draft', { system: 's', user: 'u' }, { ledger: m4.l, providers: { anthropic: ok } })).value.text, 'Hi Sam, Ostrevanthe Co shipped a vault. Who owns it?');
});

Deno.test('http: a 4xx carries the provider message (keys redacted) and is not retried; ledger-safe text', async () => {
  const { setTransport: st, guardedFetch: gf, HttpError: HE } = await import('./http.ts');
  let n = 0;
  st(() => { n++; return Promise.resolve(new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
    message: 'Your credit balance is too low to access the API. key sk-ant-abcdefghijklmnop' } }), { status: 400 })); });
  try { await gf('https://api.anthropic.com/v1/messages', { method: 'POST' }, { timeoutMs: 1000, retries: 1 }); throw new Error('no throw'); }
  catch (e) {
    if (!(e instanceof HE)) throw e;
    if (n !== 1) throw new Error('4xx retried');
    // review #71: the provider text rides only on .detail (redacted); .message is host + status
    if (e.message !== 'api.anthropic.com 400') throw new Error('message: ' + e.message);
    if (!/credit balance is too low/.test(e.detail) || /abcdefghij/.test(e.detail)) throw new Error('detail: ' + e.detail);
  } finally { st(null); }
});
