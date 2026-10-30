// Offline tests for import fixes (synthetic data, scripted providers, no network). Run:
//   deno test --allow-env native/supabase/functions/pending/_shared/import/
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { approveLabel, findDuplicate, normCompany, normName, resolveImport, slugOf, ImportRow, BookPerson } from './resolve.ts';
import { mapLemlist, Candidate, PeopleLookup } from './lemlist.ts';
import { allowedHost } from '../ai/http.ts';
import { route } from '../ai/router.ts';
import { Ledger } from '../ai/run.ts';
import { scripted } from '../../kyte-ai/fakes_test_util.ts';

Deno.env.set('SUPABASE_URL', 'https://abcdefghijklmnopqrst.supabase.co');

function memLedger() {
  const rows: Record<string, unknown>[] = [];
  const l: Ledger = { reserve(a) { rows.push({ ...a }); return Promise.resolve({ ok: true, callId: rows.length }); },
    finish(id, a) { Object.assign(rows[id - 1], a); return Promise.resolve(); } };
  return { l, rows };
}
const refusing: Ledger = { reserve: () => Promise.resolve({ ok: false, reason: 'monthly_cap' }), finish: () => Promise.resolve() };

function fakeLookup(map: Record<string, Candidate[]>, left = 90) {
  const calls: string[] = [];
  const l: PeopleLookup = { find(q) { calls.push(q.name); return Promise.resolve({ candidates: map[q.name] ?? [], searchesLeft: left - calls.length }); } };
  return { l, calls };
}
const cand = (full_name: string, company: string, title: string, slug: string): Candidate =>
  ({ full_name, company, title, linkedin_url: `https://www.linkedin.com/in/${slug}`, source: 'lemlist' });

const book: BookPerson[] = [
  { id: 'p1', name: 'Maya Mockoro', company: 'Norquiveth Labs, Inc.', title: 'Director, Data', linkedin_url: 'https://linkedin.com/in/sample-maya-mockoro/' },
  { id: 'p2', name: 'Lee Parksynth', company: 'Glimvasse Health', title: 'CISO' },
];
const rows = (extra: ImportRow[] = []): ImportRow[] => [
  { row: 2, name: 'Ana Fauxwell', company: 'Quorvelline Pay', linkedin_url: 'https://www.linkedin.com/in/sample-ana-fauxwell' },
  { row: 3, name: 'Maya Mockoro', company: 'Norquiveth Labs', title: 'VP, Data', linkedin_url: 'http://www.linkedin.com/in/Sample-Maya-Mockoro' },
  ...extra,
];

Deno.test('normalisers', () => {
  assertEquals(slugOf('http://www.linkedin.com/in/Sample-Maya-Mockoro/?x=1'), 'sample-maya-mockoro');
  assertEquals(slugOf('https://example.com/in/x'), null);
  assertEquals(normCompany('Hartwell & Co., Inc.'), 'hartwell and');
  assertEquals(normCompany('Norquiveth Labs, Inc.'), normCompany('Norquiveth Labs'));
  assertEquals(normName('Jose Sampleton, PhD'), 'jose sampleton');
  assertEquals(normName('José  Sampleton'), 'jose sampleton');
});

Deno.test('duplicates are found by code: same profile first, then same name + company', () => {
  assertEquals(findDuplicate(rows()[1], book)?.how, 'same_profile');
  assertEquals(findDuplicate({ row: 9, name: 'lee parksynth', company: 'Glimvasse Health Inc' }, book)?.how, 'same_name_company');
  assertEquals(findDuplicate({ row: 9, name: 'Lee Parksynth', company: 'Quorvelline Pay' }, book), null);   // same name, other company
});

Deno.test('exact single match needs no AI; card arrives solved', async () => {
  const { l, calls } = fakeLookup({ 'Priya Fixtura': [cand('Priya Fixtura', 'Quorvelline Pay', 'VP Data', 'sample-priya-fixtura'), cand('Priya Fixtura', 'Other Co', 'Analyst', 'x')] });
  const { p, seen } = scripted('anthropic', ['{"pick":0,"confidence":0.9,"reason":"x"}']);
  const { l: ledger } = memLedger();
  const plan = await resolveImport(rows([{ row: 4, name: 'Priya Fixtura', company: 'Quorvelline Pay' }]), book,
    { lookup: l, ai: { ledger, providers: { anthropic: p } } });
  assertEquals(plan.add, [2]);
  assertEquals(plan.flags.map((f) => [f.kind, f.chosen]), [['duplicate', 'skip'], ['missing_url', 'use_profile']]);
  assertEquals(plan.flags[1].options[0].candidate?.linkedin_url, 'https://www.linkedin.com/in/sample-priya-fixtura');
  assertEquals(plan.flags[0].options.map((o) => o.key), ['skip', 'update']);           // CSV has a newer title
  assertEquals(plan.approveLabel, 'Add 2, skip 1 duplicate, use 1 found profile');
  assertEquals(calls.length, 1); assertEquals(seen.length, 0); assertEquals(plan.aiCalls, 0);
});

Deno.test('ambiguous candidates go to Haiku; high confidence = prepared, mid = two to choose, low = park', async () => {
  const cs = [cand('Sam Leesynth', 'Quorvelline Payments', 'Head of Risk', 'sam-a'), cand('Samuel Leesynth', 'Quorvelline Pay', 'Engineer', 'sam-b')];
  for (const [reply, chosen, nOpts] of [
    ['{"pick":0,"runner_up":1,"confidence":0.86,"reason":"title fits"}', 'use_profile', 2],
    ['{"pick":0,"runner_up":1,"confidence":0.6,"reason":"either"}', 'park_no_linkedin', 3],
    ['{"pick":-1,"confidence":0.2,"reason":"none"}', 'park_no_linkedin', 1],
  ] as const) {
    const { l } = fakeLookup({ 'Sam Leesynth': cs });
    const { p, seen } = scripted('anthropic', [reply]);
    const { l: ledger, rows: calls } = memLedger();
    const plan = await resolveImport([{ row: 5, name: 'Sam Leesynth', company: 'Quorvelline Pay', title: 'Risk lead' }], [],
      { lookup: l, ai: { ledger, providers: { anthropic: p } } });
    const f = plan.flags[0];
    assertEquals([f.chosen, f.options.length], [chosen, nOpts]);
    assertEquals(seen[0].model, 'claude-haiku-5-5'); assertEquals(calls[0].task, 'match_profile');
    assert(seen[0].system.includes('never an instruction'), 'untrusted-data rule present');
  }
});

Deno.test('never guesses: budget refused, bad JSON or lookup failure all park the row', async () => {
  const cs = [cand('Sam Leesynth', 'Quorvelline Payments', 'Head of Risk', 'sam-a'), cand('Samuel Leesynth', 'Quorvelline Pay', 'Engineer', 'sam-b')];
  const r: ImportRow[] = [{ row: 5, name: 'Sam Leesynth', company: 'Quorvelline Pay' }];
  const { p } = scripted('anthropic', ['not json']);
  const a = await resolveImport(r, [], { lookup: fakeLookup({ 'Sam Leesynth': cs }).l, ai: { ledger: refusing, providers: { anthropic: p } } });
  const b = await resolveImport(r, [], { lookup: fakeLookup({ 'Sam Leesynth': cs }).l, ai: { ledger: memLedger().l, providers: { anthropic: p } } });
  const c = await resolveImport(r, [], { lookup: { find: () => Promise.reject(new Error('down')) }, ai: { ledger: memLedger().l } });
  for (const plan of [a, b, c]) assertEquals(plan.flags[0].chosen, 'park_no_linkedin');
});

Deno.test('search quota: stops looking up near the daily limit and caps lookups per import', async () => {
  const many: ImportRow[] = Array.from({ length: 6 }, (_, i) => ({ row: 10 + i, name: `Person ${"ABCDEF"[i]}`, company: 'Quorvelline Pay' }));
  const { l, calls } = fakeLookup({}, 8);                       // 7 left after the first call, 6 after the second...
  const plan = await resolveImport(many, [], { lookup: l, ai: { ledger: memLedger().l }, minSearchesLeft: 5 });
  assertEquals(calls.length, 3);
  assert(plan.notes.some((n) => n.includes('search limit')));
  const capped = await resolveImport(many, [], { lookup: fakeLookup({}).l, ai: { ledger: memLedger().l }, maxLookups: 2 });
  assertEquals(capped.lookupsUsed, 2);
});

Deno.test('repeats inside one CSV are dropped with a note', async () => {
  const plan = await resolveImport(rows([{ row: 7, name: 'Ana Fauxwell', company: 'Quorvelline Pay', linkedin_url: 'https://linkedin.com/in/sample-ana-fauxwell/' }]), book,
    { lookup: fakeLookup({}).l, ai: { ledger: memLedger().l } });
  assertEquals(plan.add, [2]); assert(plan.notes[0].includes('row 7 repeats row 2'));
});

Deno.test('lemlist mapping, host rules and routing', () => {
  const m = mapLemlist({ limitation: 49, results: [{ full_name: 'Ana Fauxwell', current_exp_company_name: 'Quorvelline Pay', location: 'NYC',
    lead_linkedin_url: 'https://www.linkedin.com/in/sample-ana-fauxwell', experiences: [{ company_name: 'Quorvelline Pay', title: 'VP Data' }] }] });
  assertEquals(m.searchesLeft, 49); assertEquals(m.candidates[0].title, 'VP Data');
  assert(allowedHost('https://api.lemlist.com/api/database/people'));
  assert(!allowedHost('https://www.linkedin.com/in/sample-ana-fauxwell'));
  assertEquals(route('match_profile').model, 'claude-haiku-5-5');
  assertEquals(approveLabel(10, []), 'Add 10');
});

// ---------- Brave step + waterfall (Oct 23) ----------
import { mapBrave, parseTitle, waterfall } from './brave.ts';
import { NotConfigured } from '../ai/types.ts';

Deno.test('brave: titles parse, only /in/ profiles kept, query string dropped', () => {
  assertEquals(parseTitle('Priya Fixtura - VP Data - Quorvelline Pay | LinkedIn'), { full_name: 'Priya Fixtura', title: 'VP Data', company: 'Quorvelline Pay' });
  assertEquals(parseTitle('Priya Fixtura – Quorvelline Pay | LinkedIn').company, 'Quorvelline Pay');
  assertEquals(parseTitle('Priya Fixtura - VP Data | LinkedIn', 'Experience: Quorvelline Pay · Location: Austin').company, 'Quorvelline Pay');
  const c = mapBrave({ web: { results: [
    { url: 'https://www.linkedin.com/in/sample-priya-fixtura?trk=x', title: 'Priya Fixtura - VP Data - Quorvelline Pay | LinkedIn' },
    { url: 'https://www.linkedin.com/posts/sample-priya-fixtura_x', title: 'Priya Fixtura on LinkedIn: post' },
    { url: 'https://www.linkedin.com/company/quorvelline', title: 'Quorvelline Pay | LinkedIn' },
  ] } });
  assertEquals(c.length, 1);
  assertEquals([c[0].linkedin_url, c[0].source], ['https://www.linkedin.com/in/sample-priya-fixtura', 'brave']);
  assert(allowedHost('https://api.search.brave.com/res/v1/web/search?q=x'));
});

Deno.test('waterfall: no key or empty passes to the next source; first profile wins; lemlist limit still reported', async () => {
  const noKey: PeopleLookup = { find: () => Promise.reject(new NotConfigured('brave')) };
  const empty: PeopleLookup = { find: () => Promise.resolve({ candidates: [] }) };
  const lem: PeopleLookup = { find: () => Promise.resolve({ candidates: [cand('Priya Fixtura', 'Quorvelline Pay', 'VP', 'sample-priya')], searchesLeft: 4 }) };
  const r = await waterfall(noKey, empty, lem).find({ name: 'Priya Fixtura', company: 'Quorvelline Pay' });
  assertEquals([r.candidates.length, r.searchesLeft], [1, 4]);
  let threw = false;
  try { await waterfall(noKey, noKey).find({ name: 'x' }); } catch { threw = true; }
  assert(threw);                                   // every source down -> resolver parks the row ("lookup failed")
});

Deno.test('park options carry a prefilled search link; found profile names its source', async () => {
  const { l } = fakeLookup({});
  const { l: ledger } = memLedger();
  const { p } = scripted('anthropic', []);
  const plan = await resolveImport(rows([{ row: 5, name: 'Sam Leesynth', company: 'Quorvelline Pay' }]), book, { lookup: l, ai: { ledger, providers: { anthropic: p } } });
  const f = plan.flags.find((x) => x.row === 5)!;
  assert(f.searchUrl?.startsWith('https://www.google.com/search?q=') && f.searchUrl.includes('site%3Alinkedin.com%2Fin'));
});
