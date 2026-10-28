// Offline tests for the 0047 pipeline worker (fake queue + scripted providers, synthetic data only).
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { handleMessage, runPipeline, enqueueResearch } from './pipeline.ts';
import { draftReply, fakeDb } from './fakes_test_util.ts';
import { ledgerFor } from './db.ts';
import { buildBrief, checkBrief } from '../_shared/ai/brief.ts';
import { copyCheck } from '../_shared/ai/copycheck.ts';
import { selectClaims, decisionBody } from '../_shared/ai/factcheck.ts';
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

Deno.test('pipeline: research that hits max_tokens fails once, is not retried, and nothing downstream runs', async () => {
  const f = fakeDb(); let calls = 0;
  const p: Provider = { name: 'anthropic', complete(req) { calls++; return Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 100,
    tokensOut: 4000, toolCalls: 1, citations: [], toolUses: [], stopReason: 'max_tokens' }); } };
  await enqueueResearch(f.db, 'P1');
  await runPipeline(f.db, { ledger: ledgerFor(f.db), providers: { anthropic: p } });
  assertEquals(calls, 1); assertEquals(f.st.pjobs.map((j) => `${j.stage}:${j.status}`), ['research:failed']);
  assertEquals(f.st.calls[0].status, 'invalid');
});

Deno.test('brief builder: labels by rule, brief_upsert checks pass, dashes and location words refused', () => {
  const b = buildBrief({ person: { id: 'P1', research_brief: { summary: 'S.', angles: ['a', 'b'] } }, account: { id: 'acc', company: 'Ostrevanthe Co' },
    research: [{ source_url: 'https://e.com/1', dated: '2026-10-01', fact: 'Launched X' }, { source_url: 'http://e.com/2', dated: null, fact: 'Hiring' }],
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
