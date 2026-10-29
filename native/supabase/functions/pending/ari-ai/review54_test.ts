// Review #54 (Claude review of ea2c98d, Oct 29 2026): fail-closed person-name filter, one shared trigger judgment for the
// brief, and deep research turns that refuse cut / refused replies. Synthetic data only.
import { assert, assertEquals, assertRejects } from 'jsr:@std/assert@1';
import { decisionBody, looksLikePersonName, selectClaims } from '../_shared/ai/factcheck.ts';
import { buildBrief, checkBrief, judgeTrigger, whyNowText } from '../_shared/ai/brief.ts';
import { InvalidOutput, Ledger, runTurn } from '../_shared/ai/run.ts';
import { route } from '../_shared/ai/router.ts';
import type { AiRequest, Provider } from '../_shared/ai/types.ts';

const pick = (xs: string[], company = 'Norquiveth', domain = 'norquiveth.example') => selectClaims({ dm_text: '', company, domain,
  contact: { name: 'Dana Whitfield', title: 'VP Security' }, people: [], source_facts: xs.map((fact) => ({ fact, source: 'https://news.example/x' })) });
const verdicts = (r: ReturnType<typeof pick>) => r.decisions.map((d) => d.decision);
const ELIGIBLE = 'eligible: public company-level claim';
const NAME = 'blocked: names a person (person name)';

Deno.test('review54: a lone surname next to said / told / led / by / from / named / according to is blocked', () => {
  const r = pick([
    'Hale told a reporter the vault is live',                         // surname before a speech verb, at sentence start
    'The vault is live, said Hale',                                   // after said
    'The rollout was led by Quinlan in 2026',                         // after led by
    'According to Pike the vault ships in Q3',                        // after according to
    'Norquiveth confirmed the breach, a statement from Sampleton shows',  // after from
    'A memo by Mockwhit describes the vault',                         // after by
    'Norquiveth named Ashworth to the vault program',                  // after named
  ]);
  assertEquals(verdicts(r), Array(7).fill(NAME));
  const body = JSON.stringify(r.eligible.map((e) => decisionBody('Norquiveth', 'norquiveth.example', e.claim)));
  for (const n of ['Hale', 'Quinlan', 'Pike', 'Sampleton', 'Mockwhit', 'Ashworth']) assert(!body.includes(n), n);
});

Deno.test('review54: ALL-CAPS names, names with particles, and particle-joined surnames are blocked', () => {
  assertEquals(verdicts(pick([
    'MORGAN HALE leads the Norquiveth vault program',     // all-caps run
    'HALE said the vault is live',                       // all-caps lone surname + cue
    'Ludwig van Brennen runs the Norquiveth vault',      // particle inside the run
    'Maria de Souza joined the Norquiveth vault team',    // particle inside the run
    'Klaus von Ritter oversees the vault',               // von
    'Khalid al Rashid oversees the vault',               // al
    'Omar bin Tariq oversees the vault',                 // bin
    'Anne le Clerc oversees the vault',                  // le
    'Paulo da Silvample oversees the vault',                 // da
    'Norquiveth hired al-Rashid for the vault',           // particle-joined, alone
    "Norquiveth hired d'Souza for the vault",             // particle-joined, alone
  ])), Array(11).fill(NAME));
  // acronyms are not names: an all-caps compliance term still passes
  assertEquals(verdicts(pick(['Norquiveth is a HIPAA Business Associate under the Privacy Rule', 'Norquiveth passed a SOC 2 audit in 2026'])), [ELIGIBLE, ELIGIBLE]);
});

Deno.test('review54: a name that shares a word with a COMMON word or the company name is blocked', () => {
  assertEquals(verdicts(pick([
    'Grant Post runs security at the company',           // "post" is a COMMON word
    'May Chen presented the vault at a summit',          // "may" (month) is COMMON
    'Health Okonkwo approved the vault budget',          // "health" is COMMON
    'Norquiveth Lindqvist approved the vault budget',     // company word + surname
    'Ellis Norquiveth approved the vault budget',         // surname + company word
  ])), Array(5).fill(NAME));
  // a company named after a person-like word: its own words alone still pass, a person beside them does not
  assertEquals(verdicts(pick(['Grant Labs expanded its vault to 12 hospitals in 2026', 'Grant Labs hired Marlow Pruitt in 2026'], 'Grant Labs', 'grantlabs.example')),
    [ELIGIBLE, NAME]);
});

Deno.test('review54: fail-closed extras: uncased scripts and personal pronouns are blocked; plain company claims still go', () => {
  assertEquals(verdicts(pick(['Norquiveth hired 김민준 for the vault', 'Norquiveth hired محمد for the vault', 'Norquiveth hired राहुल for the vault'])), Array(3).fill(NAME));
  assertEquals(verdicts(pick(['Norquiveth said he would ship the vault in May', 'Her team at Norquiveth shipped the vault'])),
    Array(2).fill('blocked: names a person (person pronoun)'));
  assertEquals(verdicts(pick(['Norquiveth restructured about 220 roles in May 2026', 'UpGuard flagged infostealer malware on systems associated with Norquiveth in October 2026',
    'Norquiveth launched a patient data vault on 2026-09-15'])), Array(3).fill(ELIGIBLE));
  assertEquals(verdicts(pick(["Norquiveth's vault went live in 14 states"])), [ELIGIBLE]);
  // unit level: the detector itself
  const co = new Set(['norquiveth']);
  assertEquals(looksLikePersonName('Hale told a reporter', co), true);
  assertEquals(looksLikePersonName('Norquiveth told a reporter', co), false);     // the company itself speaking is fine
  assertEquals(looksLikePersonName('In October Norquiveth said the vault is live', co), false);
});

Deno.test('review54: build and check judge triggers on the same normalized text; a valid dated item passes both', () => {
  const today = new Date('2026-10-28');
  const research = [
    // a dated news item whose raw fact has a newline and an em dash: a real trigger in build AND in check
    { source_url: 'https://www.fiercehealthcare.com/health-tech/norquiveth-vault', dated: '2026-10-12', fact: 'Norquiveth launched a patient\ndata vault \u2014 live in 14 states' },
    // the review case: raw "privacy\npolicy" (no NOT_TRIGGER match raw, a match once cleaned) is context in BOTH now
    { source_url: 'https://example.org/news/norquiveth-policy', dated: '2026-10-10', fact: "Norquiveth's privacy\npolicy now names a data vault" },
  ];
  const b = buildBrief({ person: { id: 'P1', research_brief: { summary: 'S.', angles: ['a'] } }, account: { id: 'acc', company: 'Norquiveth' }, research,
    people: [{ person_id: 'P1', name: 'N', title: 'VP Security' }] }, today);
  assertEquals(b.why_now.map((w) => w.kind), ['trigger', 'context']);
  assertEquals(b.why_now[0].text, 'Norquiveth launched a patient data vault , live in 14 states');
  assertEquals(checkBrief(b), []);                                   // the brief stage would no longer fail on its own output
  // the shared function is the single judgment: build kind == check verdict for every row, raw or stored text
  for (const [i, w] of b.why_now.entries()) {
    assertEquals(!!judgeTrigger(w.url, w.text), w.kind === 'trigger');
    assertEquals(judgeTrigger(w.url, research[i].fact), judgeTrigger(w.url, whyNowText(research[i].fact)));
  }
  assertEquals(judgeTrigger('', 'anything'), null);
});

function memLedger() {
  const rows: Array<Record<string, unknown>> = [];
  const l: Ledger = {
    reserve(a) { rows.push({ ...a, status: 'reserved' }); return Promise.resolve({ ok: true, callId: rows.length }); },
    finish(id, a) { Object.assign(rows[id - 1], a); return Promise.resolve(); },
  };
  return { l, rows };
}

Deno.test('review54: deep_research runTurn refuses max_tokens / refusal / context-window stops (booked invalid, thrown); 4000 tokens, effort low', async () => {
  assertEquals([route('deep_research').maxTokens, route('deep_research').effort], [4000, 'low']);
  for (const stop of ['max_tokens', 'refusal', 'model_context_window_exceeded']) {
    const { l, rows } = memLedger(); const seen: AiRequest[] = [];
    const p: Provider = { name: 'anthropic', complete: (req) => { seen.push(req); return Promise.resolve({ provider: 'anthropic', model: req.model, text: '',
      tokensIn: 5000, tokensOut: 4000, toolCalls: 0, citations: [], toolUses: [], stopReason: stop }); } };
    const e = await assertRejects(() => runTurn('deep_research', 's', [{ role: 'user', content: 'u' }], [], { ledger: l, providers: { anthropic: p } }), InvalidOutput);
    assertEquals(e.message, `deep_research: stop_reason ${stop}`);
    assertEquals([rows[0].status, rows[0].error], ['invalid', `stop_reason ${stop}`]); assert(Number(rows[0].costUsd) > 0);
    assertEquals([seen[0].maxTokens, seen[0].effort], [4000, 'low']);
  }
  // a normal tool_use turn is still returned and booked ok
  const { l, rows } = memLedger();
  const ok: Provider = { name: 'anthropic', complete: (req) => Promise.resolve({ provider: 'anthropic', model: req.model, text: '', tokensIn: 10, tokensOut: 20,
    toolCalls: 0, citations: [], toolUses: [{ id: 't', name: 'grok_search', input: { q: 'x' } }], stopReason: 'tool_use' }) };
  const r = await runTurn('deep_research', 's', [{ role: 'user', content: 'u' }], [], { ledger: l, providers: { anthropic: ok } });
  assertEquals(r.toolUses?.length, 1); assertEquals(rows[0].status, 'ok');
});
