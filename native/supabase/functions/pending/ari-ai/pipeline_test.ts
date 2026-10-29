// Offline tests for the 0047 pipeline worker (fake queue + scripted providers, synthetic data only).
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { handleMessage, runPipeline, enqueueResearch } from './pipeline.ts';
import { draftReply, fakeDb } from './fakes_test_util.ts';
import { ledgerFor } from './db.ts';
import { buildBrief, checkBrief } from '../_shared/ai/brief.ts';
import { copyCheck } from '../_shared/ai/copycheck.ts';
import { selectClaims, decisionBody, factCheck, nameParts } from '../_shared/ai/factcheck.ts';
import type { AiRequest, Provider } from '../_shared/ai/types.ts';

Deno.env.set('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
const RESEARCH = { summary: 'Ostrevanthe Co launched a patient data vault in September.', confidence: 0.8, angles: ['vault launch', 'privacy hiring'],
  findings: [{ fact: 'Ostrevanthe Co launched a patient data vault on 2026-09-15', source_url: 'https://example.com/news/vault', dated: '2026-09-15' }] };
const DM = 'Hi Synthetic, saw Ostrevanthe Co launched its patient data vault in September. Who owns tokenization for it on your side?';

function provider(order: string[]) {
  const seen: AiRequest[] = [];
  const p: Provider = { name: 'anthropic', complete(req) {
    seen.push(req);
    if (req.clientTools?.some((t) => t.name === 'save_research')) {
      order.push('research');
      return Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 3000, tokensOut: 800, toolCalls: 2, citations: [],
        searchUrls: ['https://example.com/news/vault'], toolUses: [{ id: 't', name: 'save_research', input: RESEARCH }], stopReason: 'tool_use' });
    }
    order.push('dm1');
    return Promise.resolve({ provider: 'anthropic', model: req.model, tokensIn: 1200, tokensOut: 300, toolCalls: 0, citations: [],
      text: draftReply(DM, { source_facts: [{ fact: 'Ostrevanthe Co launched a patient data vault on 2026-09-15', source: 'https://example.com/news/vault' },
        { fact: 'Synthetic Person is VP Security', source: 'people.title' }] }) });
  } };
  return { p, seen };
}

Deno.test('pipeline: Accepted -> research -> brief -> dm1 -> copy_check -> fact_check, in order, one DM1-ready row', async () => {
  const f = fakeDb(); const order: string[] = []; const { p } = provider(order);
  const deps = { ledger: ledgerFor(f.db), providers: { anthropic: p } };
  const sent: unknown[] = [];
  const opts = { factPost: (b: unknown) => { sent.push(b); return Promise.resolve({ answers: { verdict: { type: 'choice', choice: 'true', confidence: 0.9 } }, citations: [{ url: 'https://example.com/news/vault' }] }); } };
  await enqueueResearch(f.db, 'P1');
  const r = await runPipeline(f.db, deps, opts);
  assertEquals(f.st.pjobs.map((j) => `${j.stage}:${j.status}`), ['research:done', 'brief:done', 'dm1:done', 'copy_check:done', 'fact_check:done'], JSON.stringify(r));
  assertEquals(order, ['research', 'dm1']);                                   // DM1 drafted only after research
  assertEquals(f.st.outbox.size, 1);                                          // one DM1-ready outbox row
  assert(f.st.briefs.get('acc-1').why_now[0].label === 'Verified');
  assertEquals(sent.length, 1);                                               // only the public company claim went out
  const body = JSON.stringify(sent[0]);
  assert(!body.includes('Synthetic') && !body.includes('VP Security') && !body.includes('Thrandvex'));
  assertEquals(f.st.queue.filter((m) => !m.archived).length, 0);
});

Deno.test('pipeline: a dm1 message that arrives before research is done waits (no model call), and a redelivery is harmless', async () => {
  const f = fakeDb(); const order: string[] = []; const { p } = provider(order);
  const deps = { ledger: ledgerFor(f.db), providers: { anthropic: p } };
  f.st.pjobs.push({ id: 1, contact_id: 'P1', account_id: 'acc-1', stage: 'dm1', input_hash: 'x'.repeat(10), status: 'queued', attempt: 0 });
  f.st.queue.push({ msg_id: 1, job_id: 1, vt: 0, read_ct: 1, archived: false });
  assertEquals(await handleMessage(f.db, deps, { msg_id: 1, read_ct: 1, job: f.st.pjobs[0] }), 'wait:wait_research');
  assertEquals(order.length, 0); assertEquals(f.st.queue[0].archived, false);
  f.st.pjobs[0].status = 'done';                                              // pretend another run finished it
  assertEquals(await handleMessage(f.db, deps, { msg_id: 1, read_ct: 2, job: f.st.pjobs[0] }), 'stop:already_done');
  assertEquals(f.st.queue[0].archived, true); assertEquals(order.length, 0);
});

Deno.test('pipeline: research that hits max_tokens fails once, is not retried in the same drain (one delayed retry queued), nothing downstream runs', async () => {
  const f = fakeDb(); let calls = 0;
  const p: Provider = { name: 'anthropic', complete(req) { calls++; return Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 100,
    tokensOut: 4000, toolCalls: 1, citations: [], toolUses: [], stopReason: 'max_tokens' }); } };
  await enqueueResearch(f.db, 'P1');
  await runPipeline(f.db, { ledger: ledgerFor(f.db), providers: { anthropic: p } });
  assertEquals(calls, 1); assertEquals(f.st.pjobs.map((j) => `${j.stage}:${j.status}`), ['research:failed', 'research:queued']);
  assertEquals(f.st.calls[0].status, 'invalid');
});

Deno.test('brief builder: labels by rule, brief_upsert checks pass, dashes and location words refused', () => {
  const b = buildBrief({ person: { id: 'P1', research_brief: { summary: 'S.', angles: ['a', 'b'] } }, account: { id: 'acc', company: 'Ostrevanthe Co' },
    research: [{ source_url: 'https://e.com/news/1', dated: '2026-10-01', fact: 'Launched X' }, { source_url: 'http://e.com/2', dated: null, fact: 'Hiring' }],
    people: [{ person_id: 'P1', name: 'N', title: 'VP Security' }] }, new Date('2026-10-28'));
  assertEquals(b.why_now.map((w) => `${w.kind}/${w.label}`), ['trigger/Verified', 'context/Inference']);
  assertEquals(checkBrief(b), []); assertEquals(b.committee[0].people[0].priority, 'P1');
  assertEquals(checkBrief({ ...b, thesis: 'Team in India' }).length, 1);
});

Deno.test('copy check (server subset): flags seller line, meeting ask, dash; passes a clean DM1', () => {
  assertEquals(copyCheck(DM, 'dm1').pass, true);
  const bad = copyCheck('Thanks for connecting, Dana. At Thrandvex we help. Open to a 15 min call next week \u2014 ok?', 'dm1');
  assert(bad.flags.some((f) => f.startsWith('R3')) && bad.flags.some((f) => f.startsWith('M1')) && bad.flags.includes('R11 dash'));
});

Deno.test('fact check filter: only https-sourced company claims; never the contact, title, seller or CRM text', () => {
  const r = selectClaims({ dm_text: '', company: 'Ostrevanthe Co', domain: 'example.com', contact: { name: 'Dana Whitfield', title: 'VP Security' },
    source_facts: [{ fact: 'Ostrevanthe Co raised a Series C in 2026', source: 'https://news.example/c' }, { fact: 'Dana spoke at a summit', source: 'https://x.example' },
      { fact: 'Thrandvex isolates data', source: 'https://thrandvex.example' }, { fact: 'Open deal with the AE', source: 'https://crm.example' },
      { fact: 'Title is VP Security', source: 'people.title' }] });
  assertEquals(r.eligible.map((e) => e.claim), ['Ostrevanthe Co raised a Series C in 2026']);
  assertEquals(r.decisions.length, 5);
  const body = decisionBody('Ostrevanthe Co', 'example.com', r.eligible[0].claim);
  assertEquals(Object.keys(body.state).sort(), ['claim', 'company', 'website']);
});

// ---- review #50 fixes --------------------------------------------------------------------------------------------------------
Deno.test('review50: a redelivered message during an active run is refused before any model call (lease), stale finish fenced', async () => {
  const f = fakeDb(); const order: string[] = []; const { p } = provider(order);
  const deps = { ledger: ledgerFor(f.db), providers: { anthropic: p } };
  await enqueueResearch(f.db, 'P1');
  const st = await f.db.rpc<{ ok: boolean }>('ari_pipeline_start', { p_job: 1, p_msg: 1, p_lease: 150 });   // run 1 holds the lease
  assert(st.ok);
  f.st.clock += 10;                                                                            // vt ran out early / parallel read
  assertEquals(await handleMessage(f.db, deps, { msg_id: 1, read_ct: 2, job: f.st.pjobs[0] }), 'wait:running');
  assertEquals(order.length, 0); assertEquals(f.st.calls.length, 0); assertEquals(f.st.queue[0].archived, false);
  const stale = await f.db.rpc<{ reason?: string }>('ari_pipeline_finish', { p_job: 1, p_msg: 1, p_attempt: 7, p_status: 'done', p_output: null, p_output_ref: null, p_error: null });
  assertEquals(stale.reason, 'not_running');
  f.st.clock += 200;                                                                           // lease expired: the run died
  assertEquals(await handleMessage(f.db, deps, { msg_id: 1, read_ct: 3, job: f.st.pjobs[0] }), 'research:done');
  assertEquals(order, ['research']); assertEquals(f.st.pjobs[0].attempt, 2);
});

Deno.test('review50: failed research gets exactly one delayed retry, then a single ops alert (never silent)', async () => {
  const f = fakeDb(); let calls = 0;
  const p: Provider = { name: 'anthropic', complete(req) { calls++; return Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 100,
    tokensOut: 4000, toolCalls: 1, citations: [], toolUses: [], stopReason: 'max_tokens' }); } };
  const deps = { ledger: ledgerFor(f.db), providers: { anthropic: p } };
  await enqueueResearch(f.db, 'P1');
  await runPipeline(f.db, deps);
  assertEquals(f.st.pjobs.map((j) => `${j.stage}:${j.status}`), ['research:failed', 'research:queued']);
  assertEquals(f.st.alerts.size, 0); assertEquals(calls, 1);                 // retry is delayed: not run in the same drain
  f.st.clock += 301;
  await runPipeline(f.db, deps);
  assertEquals(f.st.pjobs.map((j) => `${j.stage}:${j.status}`), ['research:failed', 'research:failed']);
  assertEquals(calls, 2); assertEquals([...f.st.alerts.keys()], ['ops:pipeline:2']);
  f.st.clock += 1000; await runPipeline(f.db, deps); assertEquals(calls, 2);  // bounded: no third attempt
});

Deno.test('review50: Parallel error or refusal is UNCHECKED (flagged, not cached), error fails the job with an alert', async () => {
  const base = { dm_text: '', company: 'Ostrevanthe Co', domain: 'example.com', contact: { name: 'Dana Whitfield', title: 'VP Security' },
    source_facts: [{ fact: 'Ostrevanthe Co raised a Series C in 2026', source: 'https://news.example/c' }] };
  const cache = new Map<string, unknown>();
  const deps = { cacheGet: () => Promise.resolve({}), cachePut: (_d: string, h: string, _c: string, v: unknown) => { cache.set(h, v); return Promise.resolve(); } };
  const refused = await factCheck(base, { ...deps, post: () => Promise.resolve({ answers: { verdict: { type: 'refusal' } } }) });
  assertEquals([refused.status, refused.flagged, refused.unchecked, cache.size], ['unchecked', true, 1, 0]);
  const errored = await factCheck(base, { ...deps, post: () => Promise.reject(new Error('502 upstream')) });
  assertEquals([errored.status, errored.flagged, errored.errors, cache.size], ['unchecked', true, 1, 0]);
  const noChoice = await factCheck(base, { ...deps, post: () => Promise.resolve({ answers: { verdict: { type: 'choice' } } }) });
  assertEquals(noChoice.status, 'unchecked');
  const ok = await factCheck(base, { ...deps, post: () => Promise.resolve({ answers: { verdict: { type: 'choice', choice: 'true', confidence: 0.9 } } }) });
  assertEquals([ok.status, ok.flagged, cache.size], ['done', false, 1]);
  // end to end: Parallel down -> fact_check job failed + one ops alert; DM1 meta marked needs_review
  const f = fakeDb(); const order: string[] = []; const { p } = provider(order);
  await enqueueResearch(f.db, 'P1');
  await runPipeline(f.db, { ledger: ledgerFor(f.db), providers: { anthropic: p } }, { factPost: () => Promise.reject(new Error('timeout')) });
  assertEquals(f.st.pjobs.at(-1).stage + ':' + f.st.pjobs.at(-1).status, 'fact_check:failed');
  assertEquals(f.st.alerts.size, 1);
  const fc = f.st.checks.find((c) => c.kind === 'fact_check'); assertEquals([fc.result.status, fc.needs_review], ['unchecked', true]);
});

Deno.test('review50: accented / Unicode contact names are blocked in every form', () => {
  const facts = (xs: string[]) => xs.map((fact) => ({ fact, source: 'https://news.example/x' }));
  const run = (name: string, xs: string[]) => selectClaims({ dm_text: '', company: 'Ostrevanthe Co', domain: 'example.com', contact: { name, title: 'CISO' },
    source_facts: facts(xs) }).decisions.map((d) => d.decision.split(':')[0]);
  assertEquals(run('Jürgen Müller', ['Müller joined Ostrevanthe Co in 2025', 'Muller joined Ostrevanthe Co', 'Mueller spoke at RSA', 'MÜLLER hired',
    'Ostrevanthe Co opened a Munich office']), ['blocked', 'blocked', 'blocked', 'blocked', 'eligible']);
  assertEquals(run('José Núñez', ['Jose Nunez leads security', 'José leads security', 'JOSÉ said', 'Nuñez-led team', 'Ostrevanthe Co hired 40 engineers']),
    ['blocked', 'blocked', 'blocked', 'blocked', 'eligible']);
  // decomposed input (NFD) is the same name
  assertEquals(run('Jose\u0301 Ma', ['Jos\u00e9 led the launch']), ['blocked']);
  // two-letter parts count; whole words only (Li is blocked, "Lisbon" is not)
  assertEquals(run('Wei Li', ['Li presented the roadmap', 'Ostrevanthe Co opened Lisbon office']), ['blocked', 'eligible']);
  // a name part that folds to nothing blocks every claim (cannot be matched safely)
  assertEquals(run('Dana \u0301\u0301', ['Ostrevanthe Co hired 40 engineers']), ['blocked']);
  // the Oct 28 filter stripped accents first ("Müller" -> "mller") and let "Müller" through; prove that path is gone
  assertEquals(run('Müller', ['Müller is CISO']), ['blocked']);
});

Deno.test('review51: CJK, space-free and punctuated name parts are blocked', () => {
  const facts = (xs: string[]) => xs.map((fact) => ({ fact, source: 'https://news.example/x' }));
  const run = (name: string, xs: string[]) => selectClaims({ dm_text: '', company: 'Ostrevanthe Co', domain: 'example.com', contact: { name, title: 'CISO' },
    source_facts: facts(xs) }).decisions.map((d) => d.decision);
  const kind = (name: string, xs: string[]) => run(name, xs).map((d) => d.split(':')[0]);
  // "李 明": one-character parts cannot be matched safely -> every claim blocked, incl. the space-free "李明" and a clean claim
  assertEquals(run('李 明', ['李明是公司的CEO', 'Ostrevanthe Co hired 40 engineers']),
    ['blocked: contact name cannot be matched safely', 'blocked: contact name cannot be matched safely']);
  assertEquals(nameParts('李 明').unfoldable, true);
  // "李明" written without a space: matched as a substring (no word boundaries in Han text), both spaced and unspaced
  assertEquals(kind('李明', ['李明是公司的CEO', '公司宣布李 明加入', 'Ostrevanthe Co hired 40 engineers']), ['blocked', 'blocked', 'eligible']);
  // punctuation stripped from each part: "(Dee)" matches "Dee"; whole words still (Deere is not Dee)
  assertEquals(kind('Dana (Dee) Whitfield', ['Dee spoke at RSA', '(Dee) joined in 2024', 'Ostrevanthe Co partnered with Deere',
    'Ostrevanthe Co hired 40 engineers']), ['blocked', 'blocked', 'eligible', 'eligible']);
  assertEquals(nameParts('Dana (Dee) Whitfield').parts.includes('Dee'), true);
  // the name with spaces removed: "DanaWhitfield", "dana-whitfield" handle styles
  assertEquals(kind('Dana Whitfield', ['Talk by DanaWhitfield at RSA', 'speaker handle dana-whitfield on the agenda', 'Ostrevanthe Co raised $50M']),
    ['blocked', 'blocked', 'eligible']);
  // inner punctuation: O'Brien matches "OBrien" and "O'Brien"; the 1-letter "O" piece neither blocks all nor matches alone
  assertEquals(kind("Sean O'Brien", ["O'Brien leads security", 'OBrien joined', 'Ostrevanthe Co opened an O-ring plant']), ['blocked', 'blocked', 'eligible']);
  assertEquals(kind('Jean-Luc Picard', ['Luc presented', 'Jean-Luc said', 'JeanLuc said', 'Ostrevanthe Co expanded']), ['blocked', 'blocked', 'blocked', 'eligible']);
  // Oct 28 2026: a middle initial is ignored for matching (it used to block every claim); the name itself still blocks
  assertEquals(kind('Dana J. Whitfield', ['Ostrevanthe Co raised $50M', 'Whitfield spoke']), ['eligible', 'blocked']);
  // Hangul / kana names (no spaces between words) are substring-matched too
  assertEquals(kind('김민준', ['김민준이 발표했다', 'Ostrevanthe Co expanded']), ['blocked', 'eligible']);
  assertEquals(kind('さくら たなか', ['たなかさくらが登壇', 'Ostrevanthe Co expanded']), ['blocked', 'eligible']);
});

// ---- Oct 28 2026 Phase B fixes ------------------------------------------------------------------------------------------------
import { looksLikePersonName, stripInitials } from '../_shared/ai/factcheck.ts';
import { triggerSource } from '../_shared/ai/brief.ts';

Deno.test('phaseB fix 1: dm1 stopped at max_tokens -> job failed "stop_reason max_tokens", ONE ops alert, nothing saved, no DM1-ready', async () => {
  const f = fakeDb(); const order: string[] = [];
  const p: Provider = { name: 'anthropic', complete(req) {
    if (req.clientTools?.some((t) => t.name === 'save_research')) {
      order.push('research');
      return Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 3000, tokensOut: 800, toolCalls: 2, citations: [],
        searchUrls: ['https://example.com/news/vault'], toolUses: [{ id: 't', name: 'save_research', input: RESEARCH }], stopReason: 'tool_use' });
    }
    order.push('dm1');
    assertEquals([req.maxTokens, req.effort], [3000, 'low']);                  // the fixed route reaches the provider
    return Promise.resolve({ provider: 'anthropic', model: req.model, tokensIn: 3122, tokensOut: 3000, toolCalls: 0, citations: [], stopReason: 'max_tokens',
      text: 'Hi Synthetic, saw the vault launch.\n@@META@@\n{"rationale":"r","source_facts":[{"fact":"a"},' });
  } };
  await enqueueResearch(f.db, 'P1');
  await runPipeline(f.db, { ledger: ledgerFor(f.db), providers: { anthropic: p } });
  assertEquals(f.st.pjobs.map((j) => `${j.stage}:${j.status}`), ['research:done', 'brief:done', 'dm1:failed']);
  assertEquals(f.st.pjobs[2].error, 'draft: stop_reason max_tokens');
  assertEquals(order, ['research', 'dm1']);                                   // no blind retry of the cut draft
  assertEquals([...f.st.alerts.keys()], ['ops:pipeline:3']);
  assertEquals(f.st.people.get('P1').dm, null); assertEquals(f.st.outbox.size, 0);
  assertEquals(f.st.calls.at(-1).status, 'invalid');
});

const facts = (xs: string[]) => xs.map((fact) => ({ fact, source: 'https://news.example/x' }));
const pick = (xs: string[], people: string[] = [], name = 'Dana Whitfield') => selectClaims({ dm_text: '', company: 'Norquiveth', domain: 'norquiveth.example',
  contact: { name, title: 'VP Security' }, people, source_facts: facts(xs) });

Deno.test('phaseB fix 3: a claim naming ANY person is dropped (other executives, known people, role holders); company facts still go', () => {
  const r = pick([
    'Comparably lists Avery Quinlan as VP, Information Security at Norquiveth',      // other exec, name + role
    'Norquiveth named Morgan Hale General Counsel in August 2020',                // other exec, name only
    'Jordan Pike oversees privacy at Norquiveth',                                 // known person on file
    "Norquiveth's Chief Privacy Officer described a dual data model",                 // role holder, unnamed
    'Norquiveth co-founder spoke at HLTH 2026',                                        // founder
    'Dr. Lee joined the Norquiveth advisory group',                                    // honorific
    'Norquiveth restructured about 220 roles in May 2026',                             // company-level: eligible
    'UpGuard flagged infostealer malware on systems associated with Norquiveth in October 2026', // company-level: eligible
  ], ['Jordan Pike']);
  assertEquals(r.decisions.map((d) => d.decision), [
    'blocked: names a person (person role)', 'blocked: names a person (person role)', 'blocked: names a person (known person)',
    'blocked: names a person (person role)', 'blocked: names a person (person role)', 'blocked: names a person (person name)',
    'eligible: public company-level claim', 'eligible: public company-level claim']);
  // the exact body sent carries no person name at all
  const bodies = JSON.stringify(r.eligible.map((e) => decisionBody('Norquiveth', 'norquiveth.example', e.claim)));
  for (const n of ['Dana', 'Whitfield', 'Quinlan', 'Hale', 'Pike', 'Lee', 'Avery', 'Morgan', 'Jordan']) assert(!bodies.includes(n), n);
});

Deno.test('phaseB fix 3: name-shape detector ignores company words, months and common capitalised words', () => {
  const co = new Set(['norquiveth']);
  assertEquals(looksLikePersonName('Norquiveth Names Morgan Hale as General Counsel', co), true);
  assertEquals(looksLikePersonName('Avery K. Quinlan leads InfoSec', co), true);
  // review #54 (fail-closed): a run with any unknown capitalised word is dropped, even when it is really a product name
  assertEquals(looksLikePersonName('Norquiveth offers Ixterlane Credit Monitoring after the CRM incident', co), true);
  assertEquals(looksLikePersonName('Norquiveth offers Credit Monitoring after the CRM incident', co), false);
  assertEquals(looksLikePersonName('In October 2026 Norquiveth launched ProviderConnect with DeepIntent', co), false);
  assertEquals(looksLikePersonName('Norquiveth is a HIPAA Business Associate under the Privacy Rule', co), false);
  assertEquals(looksLikePersonName("Norquiveth's May 2026 restructuring cut about 220 roles", co), false);
});

Deno.test('phaseB fix 3: middle initials are ignored for matching (no block-all) but still caught inside claims', () => {
  // "Dana J. Whitfield" no longer blocks every claim (review #51 side effect)
  assertEquals(nameParts('Dana J. Whitfield').unfoldable, false);
  assertEquals(nameParts('Dana J. Whitfield').parts.includes('J.'), false);
  const r = pick(['Norquiveth restructured about 220 roles in May 2026', 'Dana J. Whitfield spoke at RSA', 'Dana Whitfield spoke at RSA',
    'D. Whitfield presented', 'J. Smith of Norquiveth presented'], [], 'Dana J. Whitfield');
  assertEquals(r.decisions.map((d) => d.decision.split(' (')[0]), ['eligible: public company-level claim', 'blocked: mentions the contact',
    'blocked: mentions the contact', 'blocked: mentions the contact', 'blocked: names a person']);
  // the initial alone is not a match token: a stray "J" or "J." in a company claim is not the contact
  assertEquals(pick(['Norquiveth Series J. round closed in 2019 for $50M'], [], 'Dana J. Whitfield').decisions[0].decision, 'eligible: public company-level claim');
  // contact given WITHOUT the initial still catches a claim written WITH it (initials stripped from the claim)
  assertEquals(pick(['Dana J. Whitfield joined Norquiveth']).decisions[0].decision, 'blocked: mentions the contact');
  assertEquals(stripInitials('Dana J. Whitfield joined'), 'Dana Whitfield joined');
  // a one-character Han part is a real name part, not an initial: still block-all
  assertEquals(nameParts('李 明').unfoldable, true);
  // a name of initials only cannot be matched: block all
  assertEquals(pick(['Norquiveth restructured about 220 roles in May 2026'], [], 'D. W.').decisions[0].decision, 'blocked: contact name cannot be matched safely');
});

Deno.test('phaseB fix 3: pipeline passes every account contact to the fact filter; a claim naming one never reaches Parallel', async () => {
  const f = fakeDb(); const sent: unknown[] = [];
  const p: Provider = { name: 'anthropic', complete(req) {
    if (req.clientTools?.some((t) => t.name === 'save_research')) return Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 1,
      tokensOut: 1, toolCalls: 0, citations: [], searchUrls: ['https://example.com/news/vault'], toolUses: [{ id: 't', name: 'save_research', input: RESEARCH }], stopReason: 'tool_use' });
    return Promise.resolve({ provider: 'anthropic', model: req.model, tokensIn: 1, tokensOut: 1, toolCalls: 0, citations: [], stopReason: 'end_turn',
      text: draftReply(DM, { source_facts: [{ fact: 'Ostrevanthe Co launched a patient data vault on 2026-09-15', source: 'https://example.com/news/vault' },
        { fact: 'Synthetic Person presented the vault at a summit', source: 'https://example.com/news/summit' },
        { fact: 'Ostrevanthe Co hired Riley Stone to run the vault', source: 'https://example.com/news/hire' }] }) });
  } };
  await enqueueResearch(f.db, 'P1');
  await runPipeline(f.db, { ledger: ledgerFor(f.db), providers: { anthropic: p } },
    { factPost: (b: unknown) => { sent.push(b); return Promise.resolve({ answers: { verdict: { type: 'choice', choice: 'true', confidence: 0.9 } } }); } });
  assertEquals(f.st.pjobs.at(-1).stage + ':' + f.st.pjobs.at(-1).status, 'fact_check:done');
  assertEquals(sent.length, 1);
  const body = JSON.stringify(sent);
  for (const n of ['Synthetic', 'Person', 'Riley', 'Stone']) assert(!body.includes(n), n);
  const fc = f.st.checks.find((c) => c.kind === 'fact_check');
  assertEquals(fc.result.decisions.map((d: { decision: string }) => d.decision.split(':')[0]), ['eligible', 'blocked', 'blocked']);
});

Deno.test('phaseB fix 4: only dated news, filings, press releases and job posts are triggers', () => {
  assertEquals(triggerSource('https://www.sec.gov/Archives/edgar/data/1412408/x8k.htm'), 'filing');
  assertEquals(triggerSource('https://www.businesswire.com/news/home/20261001/en/Norquiveth-Launches-X'), 'press_release');
  assertEquals(triggerSource('https://www.norquiveth.example/newsroom/norquiveth-launches-x/'), 'press_release');
  assertEquals(triggerSource('https://boards.greenhouse.io/norquiveth/jobs/123'), 'job_post');
  assertEquals(triggerSource('https://www.linkedin.com/jobs/view/123'), 'job_post');
  assertEquals(triggerSource('https://www.fiercehealthcare.com/health-tech/norquiveth-cuts-220'), 'news');
  assertEquals(triggerSource('https://example.org/2026/10/12/norquiveth-layoffs'), 'news');
  // never a trigger: policy / terms, product, directory, vendor-risk scan, policy tracker, company profile, plain pages
  for (const u of ['https://tostracker.app/document/norquiveth-privacy', 'https://www.norquiveth.example/privacy-policy/', 'https://www.norquiveth.example/platform/intake',
    'https://www.upguard.com/security-report/norquiveth', 'https://www.comparably.com/companies/norquiveth/executive-team',
    'https://www.crunchbase.com/organization/norquiveth', 'https://www.norquiveth.example/about/', 'https://www.emeryreddy.com/blog/data-breach/norquiveth-data-breach',
    'http://www.sec.gov/insecure']) assertEquals(triggerSource(u), null, u);
  assertEquals(triggerSource('https://example.org/news/x', "Norquiveth's privacy policy says it signs BAAs"), null);
});

Deno.test('phaseB fix 4: brief keeps policy / product / undated pages as context; a real dated trigger is chosen and checked', () => {
  const ctx = (research: { source_url: string; dated: string | null; fact: string }[]) => buildBrief({ person: { id: 'P1', research_brief: { summary: 'S.', angles: ['a'] } },
    account: { id: 'acc', company: 'Norquiveth' }, research, people: [{ person_id: 'P1', name: 'N', title: 'VP Security' }] }, new Date('2026-10-28'));
  // the Oct 28 staging case: a privacy-policy capture dated Oct 5 and a vendor-risk scan dated Oct 2 -> both context, no trigger
  const b1 = ctx([{ source_url: 'https://www.upguard.com/security-report/norquiveth', dated: '2026-10-02', fact: 'UpGuard flags infostealer malware' },
    { source_url: 'https://tostracker.app/document/norquiveth-privacy', dated: '2026-10-05', fact: "Norquiveth's privacy policy says it signs BAAs" },
    { source_url: 'https://www.norquiveth.example/blog-x/', dated: null, fact: 'Undated blog' }]);
  assertEquals(b1.why_now.map((w) => w.kind), ['context', 'context', 'context']);
  assertEquals(b1.why_now.map((w) => w.label), ['Verified', 'Verified', 'Inference']);     // label rule unchanged (url + date)
  assert(b1.quick_check[0].why.startsWith('No dated news, filing, press release or job post found')); assertEquals(b1.quick_check[0].answer, 1);
  assertEquals(checkBrief(b1), []);
  // a dated press release + a dated job post + an old news item: the newest real trigger leads; old news is context
  const b2 = ctx([{ source_url: 'https://www.norquiveth.example/privacy-policy/', dated: '2026-10-20', fact: 'Policy updated' },
    { source_url: 'https://www.businesswire.com/news/home/20260915/en/Norquiveth-X', dated: '2026-09-15', fact: 'Norquiveth launched X' },
    { source_url: 'https://boards.greenhouse.io/norquiveth/jobs/1', dated: '2026-10-10', fact: 'Norquiveth is hiring a data privacy engineer' },
    { source_url: 'https://www.fiercehealthcare.com/x', dated: '2025-01-01', fact: 'Old news' }]);
  assertEquals(b2.why_now.map((w) => `${w.kind}:${w.date}`), ['trigger:2026-10-10', 'trigger:2026-09-15', 'context:2026-10-20', 'context:2025-01-01']);
  assertEquals(b2.quick_check[0].why, 'Verified trigger (job post) dated 2026-10-10.'); assertEquals(b2.quick_check[0].answer, 0);
  assertEquals(checkBrief(b2), []);
  // checkBrief refuses a hand-made brief that calls a policy page or an undated page a trigger
  const bad = { ...b2, why_now: [{ date: '2026-10-05', kind: 'trigger', label: 'Verified', text: 'Privacy policy', url: 'https://tostracker.app/document/norquiveth-privacy' },
    { date: '', kind: 'trigger', label: 'Inference', text: 'Undated', url: 'https://www.fiercehealthcare.com/x' }] };
  assertEquals(checkBrief(bad).filter((e) => e.startsWith('a trigger must be')).length, 2);
});
