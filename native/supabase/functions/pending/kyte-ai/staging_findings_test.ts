// Staging Phase B findings (Oct 29 2026 rerun): (1) the fail-closed name net dropped every normal claim, so Parallel checked
// nothing; (2) the server copy check did not carry the AE style guide, so a DM1 the worker's own check flags was announced as
// ready. The claims and the DM1 below are the staging ones with the account renamed to a synthetic name (Quillfeather) and a
// synthetic contact; vendor, product and publication names are as the research found them. Synthetic data only otherwise.
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { brandAllowlist, factCheck, looksLikePersonName, selectClaims } from '../_shared/ai/factcheck.ts';
import { copyCheck } from '../_shared/ai/copycheck.ts';
import { runPipeline, enqueueResearch } from './pipeline.ts';
import { draftReply, fakeDb } from './fakes_test_util.ts';
import { ledgerFor } from './db.ts';
import type { AiRequest, Provider } from '../_shared/ai/types.ts';

Deno.env.set('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');
const ELIGIBLE = 'eligible: public company-level claim';
const NAME = 'blocked: names a person (person name)';

// the research rows the staging run saved (brief why_now texts), account renamed
const RESEARCH = [
  { source_url: 'https://www.quillfeather.example/news/quillfeather-named-to-times-2026-list/', fact: "Quillfeather was named to TIME's 2026 World's Top HealthTech Companies list. It reports about 180 million patient visits enabled in 2025, or 1 in 6 US visits." },
  { source_url: 'https://www.breachdesk.example/databreaches/quillfeather', fact: 'Quillfeather notified individuals of a breach tied to a third-party tool in its CRM environment. Unauthorized access on Aug 17, 2025 exposed customer support tickets that sometimes contained limited patient information.' },
  { source_url: 'https://lawfirm.example/blog/quillfeather-data-breach', fact: 'After the incident Quillfeather stopped using the affected software, added security measures, and is reviewing third-party risk management practices.' },
  { source_url: 'https://marketfeed.example/Overview/QF/PressReleases/', fact: "Quillfeather's ProviderConnect Audiences became available in the DeepIntent Audience Marketplace, expanding use of patient-derived audience data." },
  // the staging brief also carried a real third party found on a profile page: synthetic here, and it must never be allowlisted
  { source_url: 'https://profiles.example/quillfeather', fact: 'The profile lists Morgan Pryce as CISO.' },
];
// the three DM1 source facts the staging run sent to the fact-check stage (all three were dropped before Parallel)
const STAGING_CLAIMS = [
  { fact: "Quillfeather was named to TIME's 2026 World's Top HealthTech Companies list", source: 'https://www.quillfeather.example/news/quillfeather-named-to-times-2026-list/' },
  { fact: "Quillfeather's ProviderConnect Audiences became available in the DeepIntent Audience Marketplace (Sept 2026)", source: 'https://marketfeed.example/Overview/QF/PressReleases/' },
  { fact: 'Quillfeather is reviewing third-party risk management after a breach tied to a third-party tool in its CRM environment', source: 'https://lawfirm.example/blog/quillfeather-data-breach' },
];
const base = (source_facts: { fact: string; source: string }[], research = RESEARCH) => ({ dm_text: '', company: 'Quillfeather', domain: 'quillfeather.example',
  contact: { name: 'Dana Whitfield', title: 'VP Security' }, people: [] as string[], research, source_facts });

Deno.test('finding 1: the staging claims reach Parallel once the research allowlist is built; without research they stay blocked', async () => {
  const before = selectClaims(base(STAGING_CLAIMS, []));
  assertEquals(before.eligible.length, 0);                                     // the staging behaviour, kept when there is no research
  const sel = selectClaims(base(STAGING_CLAIMS));
  assertEquals(sel.decisions.map((d) => d.decision), [ELIGIBLE, ELIGIBLE, ELIGIBLE]);
  for (const b of ['time', 'providerconnect', 'deepintent', 'healthtech']) assert(sel.allowlist.includes(b), b);
  // review #65: the CRM vendor word now passes per claim (its own source is a research site), so it is no longer on the allowlist
  assert(!sel.allowlist.includes('crm'));
  for (const p of ['morgan', 'pryce', 'dana', 'whitfield']) assert(!sel.allowlist.includes(p), p);
  const sent: unknown[] = [];
  const r = await factCheck(base(STAGING_CLAIMS), { cacheGet: () => Promise.resolve({}), cachePut: () => Promise.resolve(),
    post: (b) => { sent.push(b); return Promise.resolve({ answers: { verdict: { type: 'choice', choice: 'true', confidence: 0.8 } } }); } });
  assertEquals([r.status, r.calls, sent.length], ['done', 3, 3]);
  const body = JSON.stringify(sent);
  for (const s of ["TIME's 2026", 'DeepIntent Audience Marketplace', 'CRM environment']) assert(body.includes(s), s);
  for (const s of ['Dana', 'Whitfield', 'VP Security', 'Pryce']) assert(!body.includes(s), s);
});

Deno.test('finding 1: same result when the vendor word reads CRM (the public export renames it), generic sales words still block', () => {
  const swap = (s: string) => s.replaceAll('CRM', 'CRM');
  const r = selectClaims(base(STAGING_CLAIMS.map((c) => ({ ...c, fact: swap(c.fact) })), RESEARCH.map((x) => ({ ...x, fact: swap(x.fact) }))));
  assertEquals(r.eligible.length, 3);
  // a CRM vendor word the research never showed as a vendor still blocks; deal / pipeline / AE always block
  assertEquals(selectClaims(base([{ fact: 'Quillfeather moved its support desk to CRM in 2026', source: 'https://x.example/a' }], RESEARCH.slice(2, 4)))
    .decisions[0].decision, 'blocked: sales or CRM data');
  assertEquals(selectClaims(base([{ fact: 'Quillfeather has an open deal in the pipeline', source: 'https://x.example/b' }])).decisions[0].decision,
    'blocked: sales or CRM data');
});

Deno.test('finding 1: every review #54 person case is still dropped with the staging allowlist active', () => {
  const pick = (xs: string[]) => selectClaims(base(xs.map((fact) => ({ fact, source: 'https://news.example/x' })))).decisions.map((d) => d.decision);
  assertEquals(pick([
    'Hale told a reporter the vault is live', 'The vault is live, said Hale', 'The rollout was led by Quinlan in 2026',
    'According to Pike the vault ships in Q3', 'Quillfeather confirmed the breach, a statement from Sampleton shows', 'A memo by Mockwhit describes the vault',
    'Quillfeather named Ashworth to the vault program',
    'MORGAN HALE leads the Quillfeather vault program', 'HALE said the vault is live', 'Ludwig van Brennen runs the Quillfeather vault',
    'Maria de Souza joined the Quillfeather vault team', 'Klaus von Ritter oversees the vault', 'Khalid al Rashid oversees the vault',
    'Omar bin Tariq oversees the vault', 'Anne le Clerc oversees the vault', 'Paulo da Silvample oversees the vault',
    'Quillfeather hired al-Rashid for the vault', "Quillfeather hired d'Souza for the vault",
    'Grant Post runs security at the company', 'May Chen presented the vault at a summit', 'Health Okonkwo approved the vault budget',
    'Quillfeather Lindqvist approved the vault budget', 'Ellis Quillfeather approved the vault budget',
    'Quillfeather hired 김민준 for the vault', 'Quillfeather hired محمد for the vault',
    // a person the research itself named stays a person, even beside allowlisted brands
    'Morgan Pryce leads security for ProviderConnect Audiences', 'DeepIntent Morgan Pryce signed the Audience Marketplace terms',
  ]), Array(27).fill(NAME));
  assertEquals(pick(['Quillfeather said he would ship the vault in May']), ['blocked: names a person (person pronoun)']);
  assertEquals(pick(['Dana Whitfield joined Quillfeather from DeepIntent']), ['blocked: mentions the contact']);
  // the cue rule ignores the allowlist: a brand right after "according to" / before "said" still fails closed
  const brands = brandAllowlist(RESEARCH);
  assertEquals(looksLikePersonName('According to DeepIntent the marketplace grew', new Set(['quillfeather']), brands), true);
  assertEquals(looksLikePersonName('TIME said the list is final', new Set(['quillfeather']), brands), true);
  assertEquals(looksLikePersonName('ProviderConnect Audiences joined the DeepIntent Audience Marketplace', new Set(['quillfeather']), brands), false);
});

Deno.test('finding 1: the allowlist vetoes anyone the research uses like a person, and takes nothing from the contact or known people', () => {
  const al = brandAllowlist([
    { fact: 'Quillfeather hired Rowan Vale from Globex Labs to run the Vale Platform team.', source_url: '' },
    { fact: 'CISO Imogen Vasselrow said the Vasselrow Cloud integration is live.', source_url: '' },
    { fact: 'Tamsin Oakridge, who leads the Oakridge Marketplace, posted the update.', source_url: '' },
    { fact: 'The Whitfield Analytics platform added HIPAA logs.', source_url: '' },
    { fact: 'McAllister led the review. DeVries platform notes were cited.', source_url: '' },
  ], ['Dana Whitfield']);
  for (const p of ['rowan', 'vale', 'globex', 'imogen', 'vasselrow', 'tamsin', 'oakridge', 'whitfield', 'mcallister', 'devries']) assert(!al.has(p), p);
  // review #65: a run with no CamelCase / ALL-CAPS anchor adds nothing ("Whitfield Analytics platform" is a firm named after a person)
  assert(!al.has('analytics'));
});

// ---- finding 2: the AE style guide gates DM1 on the server ----
const STAGING_DM1 = "Dana, congrats on Quillfeather making TIME's 2026 top HealthTech list. With ProviderConnect Audiences now in the DeepIntent marketplace, how is your team keeping PHI out of the third-party tools that data touches?";
const GOOD_DM1 = 'Synthetic, quick one. Ostrevanthe Co keeps patient records in its new intake app, and that is where hospital security reviews stall. We keep them out. Worth 15 minutes?';

Deno.test('finding 2: the staging DM1 passed the old server subset and fails the ported AE guide exactly as copy_check.py did', () => {
  assertEquals(copyCheck(STAGING_DM1, 'dm1', { v1Only: true }).flags, []);    // the gap the staging run hit
  const r = copyCheck(STAGING_DM1, 'dm1', { hookOk: true });
  assertEquals(r.flags, ["G10 hovering line ('how is your team'): name the problem and the ask plainly",
    "G6 DM1 opens 'Thanks for connecting, <First>.' or '<First>, quick one.'", "G6 style A DM1 ends 'Worth 15 minutes?'"]);
  // with no dated trigger on file the congrats line is also flagged (G3); style B wants the 20 minute ask
  assert(copyCheck(STAGING_DM1, 'dm1', { hookOk: false }).flags.some((f) => f.startsWith('G3')));
  assert(copyCheck(STAGING_DM1, 'dm1', { style: 'B', hookOk: true }).flags.includes("G6 style B DM1 ends 'Worth 20 minutes?'"));
  assertEquals(copyCheck(GOOD_DM1, 'dm1', { hookOk: true }).flags, []);
  // the rest of the guide: G9 open ask / question first, G10 peer filler, G8 no concrete data, G7 style A explains how, G5 length
  const flags = copyCheck('Dana, quick one. Are you on it? Most payers we talk to use a vault for tokenization. How is that going?', 'dm1').flags;
  for (const g of ['G9 question before', 'G9 the ask is an open question', "G10 'Most", 'G8', 'G7', 'G4 one ask only']) assert(flags.some((f) => f.startsWith(g)), g);
  // G11 follow-ups pick up a word from what was sent
  assert(copyCheck('Dana, following up on billing. Claims data stalls payer reviews. We keep it out. Worth 15 minutes?', 'dm2',
    { sentBefore: ['Dana, quick one. Transcripts hold card numbers.'] }).flags.some((f) => f.startsWith('G11')));
});

const RESEARCH_OUT = { summary: 'Ostrevanthe Co runs a patient intake app.', confidence: 0.8, angles: ['intake app'],
  findings: [{ fact: 'Ostrevanthe Co launched a patient intake app on 2026-10-15', source_url: 'https://example.com/news/intake', dated: '2026-10-15' }] };
function provider(drafts: Array<string | Error>) {
  const seen: AiRequest[] = [];
  const p: Provider = { name: 'anthropic', complete(req) {
    if (req.clientTools?.some((t) => t.name === 'save_research')) {
      return Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 3000, tokensOut: 800, toolCalls: 1, citations: [],
        searchUrls: ['https://example.com/news/intake'], toolUses: [{ id: 't', name: 'save_research', input: RESEARCH_OUT }], stopReason: 'tool_use' });
    }
    seen.push(req);
    const d = drafts.length > 1 ? drafts.shift()! : drafts[0];
    if (d instanceof Error) return Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 100, tokensOut: 3000, toolCalls: 0, citations: [], stopReason: 'max_tokens' });
    return Promise.resolve({ provider: 'anthropic', model: req.model, tokensIn: 1200, tokensOut: 300, toolCalls: 0, citations: [],
      text: draftReply(d, { source_facts: [{ fact: 'Ostrevanthe Co launched a patient intake app on 2026-10-15', source: 'https://example.com/news/intake' }] }) });
  } };
  return { p, seen };
}
async function run(drafts: Array<string | Error>) {
  const f = fakeDb(); const { p, seen } = provider(drafts);
  await enqueueResearch(f.db, 'P1');
  await runPipeline(f.db, { ledger: ledgerFor(f.db), providers: { anthropic: p } }, {
    factPost: () => Promise.resolve({ answers: { verdict: { type: 'choice', choice: 'true', confidence: 0.9 } } }) });
  return { f, seen, dm1: f.st.pjobs.find((j) => j.stage === 'dm1') };
}

Deno.test('finding 2: a DM1 that fails the guide is redrafted once with the flagged rules; a compliant redraft is announced as ready', async () => {
  const { f, seen, dm1 } = await run([STAGING_DM1.replace('Dana', 'Synthetic'), GOOD_DM1]);
  assertEquals(seen.length, 2);                                                // first draft + ONE redraft
  const fixMsg = String(seen[1].messages[0].content);
  assert(fixMsg.includes('<fix>') && fixMsg.includes("G10 hovering line ('how is your team')"));
  assert(fixMsg.includes('End with exactly "Worth 15 minutes?"') && !String(seen[0].messages[0].content).includes('<fix>'));
  assertEquals(f.st.people.get('P1').dm, GOOD_DM1);
  assertEquals([dm1.status, dm1.output.copy_gate.pass, dm1.output.copy_gate.redrafted, dm1.output.notified], ['done', true, true, true]);
  assert(dm1.output.copy_gate.first_flags.length >= 3);
  assertEquals(f.st.outbox.size, 1);                                           // DM1 ready, once
  const cc = f.st.checks.find((c) => c.kind === 'copy_check');
  assertEquals([cc.result.pass, cc.needs_review], [true, false]);
  assertEquals(f.st.pjobs.map((j) => `${j.stage}:${j.status}`), ['research:done', 'brief:done', 'dm1:done', 'copy_check:done', 'fact_check:done']);
});

Deno.test('finding 2: a redraft that still fails is saved needs_review with its flags, and no "DM1 ready" is raised', async () => {
  const bad = STAGING_DM1.replace('Dana', 'Synthetic');
  const { f, seen, dm1 } = await run([bad, bad]);
  assertEquals(seen.length, 2);                                                // never a third try
  const meta = f.st.people.get('P1').ai_meta;
  assertEquals([meta.needs_review, meta.copy_gate.pass, meta.copy_gate.redrafted], [true, false, true]);
  assert(meta.copy_gate.flags.some((x: string) => x.startsWith('G10')));
  assertEquals([dm1.status, dm1.output.notified], ['done', false]);
  assertEquals(f.st.outbox.size, 0);                                           // stays in the queue, flagged, not announced
  const cc = f.st.checks.find((c) => c.kind === 'copy_check');
  assertEquals([cc.result.pass, cc.needs_review], [false, true]);
  assertEquals(f.st.pjobs.at(-1).stage + ':' + f.st.pjobs.at(-1).status, 'fact_check:done');
});

Deno.test('finding 2: a redraft that is cut off keeps the first draft, flagged, and raises no "DM1 ready"', async () => {
  const bad = STAGING_DM1.replace('Dana', 'Synthetic');
  const { f, dm1 } = await run([bad, new Error('cut')]);
  assertEquals(f.st.people.get('P1').dm, bad);
  const g = f.st.people.get('P1').ai_meta.copy_gate;
  assertEquals([g.pass, g.redrafted], [false, false]); assert(String(g.redraft_error).includes('stop_reason max_tokens'));
  assertEquals([dm1.status, dm1.output.notified, f.st.outbox.size], ['done', false, 0]);
});
