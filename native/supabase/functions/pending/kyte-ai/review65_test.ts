// Review #65 (Claude review of 395e25c, low security): the brand allowlist is built from untrusted web research, so it must not
// (a) lift the CRM vendor word for a whole account, or (b) let a firm named after a person pass the person-name net.
// Synthetic data only: the account is Quillfeather (synthetic), people and firms below are invented.
import { assert, assertEquals } from 'jsr:@std/assert@1';
import { brandAllowlist, selectClaims } from '../_shared/ai/factcheck.ts';

const ELIGIBLE = 'eligible: public company-level claim';
const CRM = 'blocked: sales or CRM data';
const NAME = 'blocked: names a person (person name)';
const RESEARCH = [
  { source_url: 'https://www.quillfeather.example/news/top-list/', fact: "Quillfeather was named to TIME's 2026 World's Top HealthTech Companies list." },
  { source_url: 'https://www.breachdesk.example/databreaches/quillfeather', fact: 'A third-party tool in its CRM environment exposed support tickets. Its CRM platform was audited.' },
  { source_url: 'https://marketfeed.example/QF/PressReleases/', fact: "Quillfeather's ProviderConnect Audiences became available in the DeepIntent Audience Marketplace." },
];
const base = (source_facts: { fact: string; source: string }[], research = RESEARCH) => ({ dm_text: '', company: 'Quillfeather',
  domain: 'quillfeather.example', contact: { name: 'Dana Whitfield', title: 'VP Security' }, people: [] as string[], research, source_facts });
const decide = (source_facts: { fact: string; source: string }[], research = RESEARCH) => selectClaims(base(source_facts, research)).decisions.map((d) => d.decision);

Deno.test('review #65 (a): the CRM / vendor word passes only when the claim itself cites a research site', () => {
  const vendorClaim = 'Quillfeather is reviewing third-party risk after a breach in its CRM environment';
  const crm = 'Quillfeather moved its support desk to a new CRM platform in 2026';
  // cited to a research row's host (www. ignored, any path on that host): passes the CRM rule
  assertEquals(decide([{ fact: vendorClaim, source: 'https://breachdesk.example/other/page' }, { fact: crm, source: 'https://www.breachdesk.example/databreaches/quillfeather' }]),
    [ELIGIBLE, ELIGIBLE]);
  // the same research is on file, but the claim's own source is NOT a research site: blocked, even though the research says
  // "CRM platform" and "CRM environment" (the account-wide lift review #65 found)
  assertEquals(decide([{ fact: vendorClaim, source: 'https://notes.example/crm/opportunity/77' }, { fact: crm, source: 'https://quillfeather.example.evil.example/x' }]),
    [CRM, CRM]);
  // Owner's own CRM text: no url / a record field / plain http never pass (the url rule comes first)
  assertEquals(decide([{ fact: crm, source: 'crm:account.notes' }, { fact: crm, source: '' }]).every((d) => d.startsWith('blocked: not from public web research')), true);
  assertEquals(decide([{ fact: crm, source: 'http://www.breachdesk.example/databreaches/quillfeather' }])[0], 'blocked: not from public web research (record field or no url)');
  // a research row with no https url (brief summary / angles) adds no host
  assertEquals(decide([{ fact: crm, source: 'https://summary.example/x' }], [...RESEARCH, { source_url: '', fact: 'Uses a CRM platform.' }, { source_url: 'http://summary.example/x', fact: 'x' }]), [CRM]);
  // with no research at all, every CRM / vendor word blocks
  assertEquals(decide([{ fact: vendorClaim, source: 'https://www.breachdesk.example/databreaches/quillfeather' }], []), [CRM]);
  // generic sales words still block whatever the source
  assertEquals(decide([{ fact: 'Quillfeather has an open deal in the pipeline', source: 'https://www.breachdesk.example/databreaches/quillfeather' }]), [CRM]);
});

Deno.test('review #65 (b): a firm named after a person is never allowlisted; anchored brand runs still are', () => {
  const research = [...RESEARCH,
    { source_url: 'https://deals.example/a', fact: 'Quillfeather hired Jane Doe Group for the audit. Smith Partners advised on the deal.' },
    { source_url: 'https://deals.example/b', fact: 'Coverage ran on Hale Media and Quorrelby Company. Rowan Vasquez Companies list was cited.' },
    { source_url: 'https://deals.example/c', fact: 'The Ostrander Analytics platform added HIPAA logs. The MORGAN HALE platform shipped.' },
  ];
  const al = brandAllowlist(research, ['Dana Whitfield']);
  for (const p of ['jane', 'doe', 'smith', 'hale', 'quorrelby', 'rowan', 'vasquez', 'ostrander', 'analytics', 'morgan']) assert(!al.has(p), p);
  // anchored runs keep working: CamelCase (DeepIntent, HealthTech) and an ALL-CAPS possessive (TIME's list)
  for (const b of ['deepintent', 'audience', 'marketplace', 'providerconnect', 'audiences', 'healthtech', 'world', 'top', 'time']) assert(al.has(b), b);
  // an acronym anchors a run too ("HIPAA Vault platform"), but only for that run
  assert(brandAllowlist([{ source_url: '', fact: 'It runs the HIPAA Vault platform.' }]).has('vault'));
  const pick = (xs: string[]) => decide(xs.map((fact) => ({ fact, source: 'https://deals.example/a' })), research);
  assertEquals(pick(['Jane Doe Group audited Quillfeather in 2026', 'Smith Partners advised Quillfeather on the vault',
    'Quillfeather retained Hale Media for its launch', 'Quillfeather used the Ostrander Analytics platform', 'Quillfeather retained Rowan Vasquez Companies']),
    Array(5).fill(NAME));
  assertEquals(pick(["Quillfeather was named to TIME's 2026 World's Top HealthTech Companies list", "Quillfeather made TIME's list in 2026",
    "Quillfeather's ProviderConnect Audiences became available in the DeepIntent Audience Marketplace"]), [ELIGIBLE, ELIGIBLE, ELIGIBLE]);
});
