// Staging rerun 2 (Oct 30 2026), Owner's calls: fact check = A (a small fixed SAFE_TERMS list of vendors, US states and agency
// words that can never be a prospect's name), DM1 angle = C (a positive dated trigger leads DM1; a breach / incident / lawsuit
// only when no positive one exists, framed forward; the AE guide's DM1 shape in the first prompt). The three claims are the
// rerun-2 DM1 source facts with the account renamed to a synthetic name (Quillfeather); vendor and place words as the research
// found them. Synthetic data only otherwise.
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { factCheck, looksLikePersonName, SAFE_TERMS, selectClaims } from '../_shared/ai/factcheck.ts';
import { briefForDraft, buildBrief, checkBrief, dm1Lead, triggerTone } from '../_shared/ai/brief.ts';
import { dm1Shape, draftDm1Prompt } from '../_shared/ai/prompts.ts';

const ELIGIBLE = 'eligible: public company-level claim';
const NAME = 'blocked: names a person (person name)';
const RESEARCH = [
  { source_url: 'https://www.breachblog.example/blog/data-breach/quillfeather-data-breach', fact: 'Quillfeather became aware of a data security incident tied to a third-party tool in its CRM environment.' },
  { source_url: 'https://www.breachdesk.example/databreaches/quillfeather', fact: 'The breach was reportedly caused by a zero-day in the Salesloft Drift integration.' },
  { source_url: 'https://www.lawfirm.example/blog/quillfeather-inc-data-breach/', fact: 'Breach notification was published on the Texas AG site on Feb 6, 2026.' },
];
const RERUN2_CLAIMS = [
  { fact: "Unauthorized access via a third-party tool in Quillfeather's CRM environment hit customer service tickets that occasionally contained limited patient information",
    source: 'https://www.breachblog.example/blog/data-breach/quillfeather-data-breach' },
  { fact: 'Breach was reportedly caused by a zero-day in the Salesloft Drift integration', source: 'https://www.breachdesk.example/databreaches/quillfeather' },
  { fact: 'Breach notice published on the Texas AG site Feb 6, 2026, with data potentially involving names, SSNs, medical information, health insurance information and DOBs',
    source: 'https://www.lawfirm.example/blog/quillfeather-inc-data-breach/' },
];
const input = (source_facts: { fact: string; source: string }[], research = RESEARCH) => ({ dm_text: '', company: 'Quillfeather', domain: 'quillfeather.example',
  contact: { name: 'Dana Whitfield', title: 'VP Security' }, people: [] as string[], research, source_facts });
const pick = (xs: string[]) => selectClaims(input(xs.map((fact) => ({ fact, source: 'https://news.example/x' })), [])).decisions.map((d) => d.decision);

Deno.test('rerun 2 fact check A: the three staging claims now reach Parallel', async () => {
  assertEquals(selectClaims(input(RERUN2_CLAIMS)).decisions.map((d) => d.decision), [ELIGIBLE, ELIGIBLE, ELIGIBLE]);
  const sent: unknown[] = [];
  const r = await factCheck(input(RERUN2_CLAIMS), { cacheGet: () => Promise.resolve({}), cachePut: () => Promise.resolve(),
    post: (b) => { sent.push(b); return Promise.resolve({ answers: { verdict: { type: 'choice', choice: 'true', confidence: 0.9 } } }); } });
  assertEquals(r.calls, 3); assertEquals(sent.length, 3); assertEquals(r.status, 'done');
  // the per-claim CRM rule from review #65 is unchanged: the same vendor claim cited to a non-research site still blocks
  assertEquals(selectClaims(input([{ ...RERUN2_CLAIMS[0], source: 'https://notes.example/crm/opportunity/77' }])).decisions[0].decision, 'blocked: sales or CRM data');
});

Deno.test('rerun 2 fact check A: SAFE_TERMS stays short and holds vendors, states + DC, and agency words', () => {
  for (const w of ['salesloft', 'drift', 'okta', 'snowflake', 'hubspot', 'workday', 'epic', 'aws', 'azure', 'google', 'microsoft',
    'texas', 'california', 'wyoming', 'hampshire', 'dakota', 'dc', 'ag', 'ftc', 'hhs', 'ocr', 'sec', 'cms', 'fda', 'cfpb', 'hipaa', 'gdpr']) assert(SAFE_TERMS.has(w), w);
  assert(SAFE_TERMS.size < 90, `SAFE_TERMS has ${SAFE_TERMS.size} words; keep it reviewable`);
  // (at most 3 claims per call: the claim cap)
  assertEquals(pick(['Quillfeather moved its identity layer to Okta and its warehouse to Snowflake in 2026', 'Quillfeather filed a notice with the California AG and HHS OCR',
    'Quillfeather runs on Google Cloud and Microsoft Azure']), Array(3).fill(ELIGIBLE));
  assertEquals(pick(['Quillfeather notified the West Virginia AG and the Washington DC regulator', 'Quillfeather opened a New York office']), Array(2).fill(ELIGIBLE));
});

Deno.test('rerun 2 fact check A: every person rule still blocks (cue words, particles, pronouns, named people, firms named after people)', () => {
  assertEquals(pick([
    'Hale told a reporter the vault is live', 'The vault is live, said Hale', 'According to Pike the vault ships in Q3',
    'MORGAN HALE leads the Quillfeather vault program', 'Maria de Souza joined the Quillfeather vault team', 'Quillfeather hired al-Rashid for the vault',
    'Grant Post runs security at the company', 'May Chen presented the vault at a summit',
    // a SAFE_TERMS word never hides a person beside it, and never lifts the cue rule
    'Okta Lindqvist approved the vault budget', 'Texas Mockwhit approved the vault', 'Virginia said the vault is live', 'The rollout was led by Georgia in 2026',
    // name-like state words alone in a run fail closed unless a direction word or an agency word qualifies them
    'May Washington approved the vault', 'Georgia Montana joined Quillfeather', 'Dakota York joined Quillfeather',
    // firms named after people (review #65) still block
    'Jane Doe Group audited Quillfeather in 2026', 'Smith Partners advised Quillfeather on the vault',
  ]), Array(17).fill(NAME));
  assertEquals(pick(['She approved the Okta rollout in Texas'])[0], 'blocked: names a person (person pronoun)');
  assertEquals(pick(['The Okta CISO approved the rollout'])[0], 'blocked: names a person (person role)');
  assert(looksLikePersonName('HALE said the AWS move is done'));
  assert(!looksLikePersonName('The Salesloft Drift integration was audited by HHS'));
});

Deno.test('rerun 2 angle C: trigger tone and ranking put a positive dated trigger first', () => {
  assertEquals(triggerTone('Quillfeather was named to TIME\'s 2026 World\'s Top HealthTech Companies list'), 'positive');
  assertEquals(triggerTone('ProviderConnect Audiences became available in the DeepIntent Audience Marketplace'), 'positive');
  assertEquals(triggerTone('Quillfeather raised a $40M Series C'), 'positive');
  assertEquals(triggerTone('A law firm announced an investor investigation of Quillfeather on Oct 27, 2026'), 'negative');
  assertEquals(triggerTone('Quillfeather launched an investigation into a data breach'), 'negative');   // negative wins
  assertEquals(triggerTone('Quillfeather filed its 10-Q'), 'neutral');
  const ctx = (research: { source_url: string; dated: string; fact: string }[]) => buildBrief({ person: { id: 'P1', research_brief: { summary: 'S.', angles: ['a'] } },
    account: { id: 'acc', company: 'Quillfeather' }, research, people: [{ person_id: 'P1', name: 'N', title: 'VP Security' }] }, new Date('2026-10-30'));
  // the rerun-2 shape: a newer lawsuit / investigation trigger used to lead; the positive ones now come first
  const b = ctx([
    { source_url: 'https://www.prnewswire.com/news-releases/quillfeather-investor-investigation-1.html', dated: '2026-10-27', fact: 'A law firm announced an investor investigation of Quillfeather on Oct 27, 2026.' },
    { source_url: 'https://www.businesswire.com/news/home/20260914/en/Quillfeather', dated: '2026-09-14', fact: 'Quillfeather ProviderConnect Audiences became available in the DeepIntent Audience Marketplace.' },
    { source_url: 'https://www.quillfeather.example/news/time-list/', dated: '2026-08-06', fact: "Quillfeather was named to TIME's 2026 World's Top HealthTech Companies list." },
    { source_url: 'https://www.sec.gov/Archives/quillfeather-10q', dated: '2026-09-30', fact: 'Quillfeather filed its 10-Q.' },
  ]);
  assertEquals(b.why_now.map((w) => w.date), ['2026-09-14', '2026-08-06', '2026-09-30', '2026-10-27']);
  assert(b.quick_check[0].q.includes('DeepIntent')); assertEquals(b.quick_check[0].answer, 0);
  assertEquals(checkBrief(b), []);
  const d = briefForDraft(b);
  assertEquals(d.dm1_lead?.tone, 'positive'); assertEquals(d.dm1_lead?.date, '2026-09-14');
  // only a negative trigger on file: it is the lead, marked negative so the prompt frames it forward
  const n = ctx([{ source_url: 'https://www.prnewswire.com/news-releases/quillfeather-investor-investigation-1.html', dated: '2026-10-27', fact: 'A law firm announced an investor investigation of Quillfeather on Oct 27, 2026.' },
    { source_url: 'https://www.quillfeather.example/about/', dated: '2026-10-01', fact: 'About page' }]);
  assertEquals(briefForDraft(n).dm1_lead?.tone, 'negative');
  assert(n.quick_check[0].why.includes('frame it as their forward problem'));
  assertEquals(dm1Lead([{ kind: 'context', text: 'Quillfeather won an award', date: '2026-10-01' }]), null);   // context never leads
});

Deno.test('rerun 2 angle C: the DM1 prompt carries the guide shape and the lead rule', () => {
  const p = draftDm1Prompt({ person: { first_name: 'Dana' } });
  for (const s of ['"Thanks for connecting, <First>."', '"<First>, quick one."', 'End with exactly "Worth 15 minutes?"', 'Under 45 words',
    'positive dated trigger', 'only when no positive trigger exists', 'forward problem', 'never a recap of what leaked', 'SSNs',
    'never use the word "breach" in the first sentence']) assert(p.system.includes(s), s);
  assert(!p.system.includes('Worth 20 minutes?'));
  const b = draftDm1Prompt({ person: { first_name: 'Dana' } }, 'B');
  assert(b.system.includes('End with exactly "Worth 20 minutes?"') && b.system.includes('Under 50 words'));
  assertEquals(dm1Shape('A').match(/\?/g)?.length, 1);   // the shape text itself carries only the one ask
  // untrusted context still goes inside <context>; the shape lives in the fixed system prompt only
  assert(!p.user.includes('Thanks for connecting'));
});
