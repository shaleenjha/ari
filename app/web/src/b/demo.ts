// B+ shell demo data (Oct 24 2026). Synthetic people and companies only: no real Ari data, no real prospects.
import type { IconName } from './ui';

export type Kind = 'reply' | 'dm2' | 'dm1' | 'connect' | 'exec' | 'waiting';
export type ChipTone = 'needs' | 'due' | 'ready' | 'quiet';

export interface Person { id: string; name: string; first: string; role: string; company: string }
export interface PassItem {
  id: string;
  person: Person;
  /** Empty for Connect (connect note: none) and Waiting. */
  draft: string;
  /** One plain line on why this person is here today. */
  context: string;
  /** What comes next once it is marked sent. */
  next: string;
}
export interface KindMeta { label: string; tone: ChipTone; icon: IconName; minutes: number; draftLabel: string }

export const KINDS: readonly Kind[] = ['reply', 'dm2', 'dm1', 'connect', 'exec', 'waiting'];

export const KIND_META: Record<Kind, KindMeta> = {
  reply: { label: 'Reply', tone: 'needs', icon: 'message-circle', minutes: 3, draftLabel: 'Reply draft' },
  dm2: { label: 'DM2', tone: 'due', icon: 'clock', minutes: 1.5, draftLabel: 'DM2 draft' },
  dm1: { label: 'DM1', tone: 'ready', icon: 'send', minutes: 1.5, draftLabel: 'DM1 draft' },
  connect: { label: 'Connect', tone: 'ready', icon: 'user-plus', minutes: 0.5, draftLabel: 'Connect request' },
  exec: { label: 'Exec track', tone: 'due', icon: 'crown', minutes: 2, draftLabel: 'Intro ask draft' },
  waiting: { label: 'Waiting', tone: 'quiet', icon: 'hourglass', minutes: 0, draftLabel: '' },
};

const p = (id: string, name: string, role: string, company: string): Person => ({ id, name, first: name.split(' ')[0]!, role, company });

export const PEOPLE = {
  maya: p('maya', 'Maya Sampleton', 'VP Data Platform', 'Bravossine Health'),
  daniel: p('daniel', 'Daniel Mockley', 'Head of Security Engineering', 'Kelvarrow Labs'),
  priya: p('priya', 'Priya Testova', 'Director of Privacy', 'Marquessine Bank'),
  lucas: p('lucas', 'Lucas Demoreau', 'Staff Engineer, Payments', 'Orquadrine Systems'),
  hannah: p('hannah', 'Hannah Placeholt', 'CISO', 'Quellivarn Insurance'),
  omar: p('omar', 'Omar Nullworth', 'Data Governance Lead', 'Tolvessine Pharma'),
  sofia: p('sofia', 'Sofia Fictorio', 'VP Engineering', 'Halvenquist Freight'),
  jonah: p('jonah', 'Jonah Stubridge', 'Principal Architect', 'Bravossine Health'),
  elena: p('elena', 'Elena Synthova', 'Head of Data', 'Plessivarn Retail'),
  ravi: p('ravi', 'Ravi Shamwell', 'Director of Platform', 'Kelvarrow Labs'),
  grace: p('grace', 'Grace Dummond', 'Privacy Engineer', 'Marquessine Bank'),
  tom: p('tom', 'Tom Mockett', 'CTO', 'Halvenquist Freight'),
  nina: p('nina', 'Nina Testard', 'Security Architect', 'Quellivarn Insurance'),
  felix: p('felix', 'Felix Decoyne', 'VP Product', 'Orquadrine Systems'),
  aisha: p('aisha', 'Aisha Inventa', 'Chief Data Officer', 'Tolvessine Pharma'),
  leo: p('leo', 'Leo Mockley', 'Engineering Manager', 'Plessivarn Retail'),
} as const;
const P = PEOPLE;

export const DEMO_PASSES: Record<Kind, PassItem[]> = {
  reply: [
    { id: 'r1', person: P.priya, context: 'Replied to your DM2 this morning and asked how long a pilot takes.',
      draft: 'Thanks Priya. Most teams run a pilot in two weeks on one data set. Would Tuesday or Wednesday next week work for a 20 minute call?',
      next: 'Ari watches for her answer.' },
  ],
  dm2: [
    { id: 'd21', person: P.daniel, context: 'DM1 went out 4 days ago. No reply yet.',
      draft: 'Daniel, Kelvarrow posted two security roles this week that mention customer data in test systems. Is that on your plate this quarter?',
      next: 'DM3 comes up in 7 days.' },
    { id: 'd22', person: P.sofia, context: 'DM1 went out 5 days ago. She viewed your profile.',
      draft: 'Sofia, quick one. When Halvenquist moves shipment data to new partners, who decides which fields they can see?',
      next: 'DM3 comes up in 7 days.' },
    { id: 'd23', person: P.elena, context: 'DM1 went out 4 days ago.',
      draft: 'Elena, saw Plessivarn is rolling out loyalty in three new markets. How are you keeping card data out of the analytics copy?',
      next: 'DM3 comes up in 7 days.' },
  ],
  dm1: [
    { id: 'd11', person: P.maya, context: 'Accepted your connect request yesterday at 6:10 PM.',
      draft: 'Thanks for connecting, Maya. Teams like yours tell us analysts keep asking for patient data they do not need. We hand back only the fields policy allows. Worth 15 minutes?',
      next: 'DM2 comes up in 4 days.' },
    { id: 'd12', person: P.lucas, context: 'Accepted your connect request this morning.',
      draft: 'Thanks for connecting, Lucas. Payments teams often copy card data into logs by accident. We keep it out by default. Open to a short chat?',
      next: 'DM2 comes up in 4 days.' },
    { id: 'd13', person: P.nina, context: 'Accepted your connect request 2 days ago.',
      draft: 'Thanks for connecting, Nina. How does Quellivarn keep claim data private when new vendors plug in? Happy to share what peers do.',
      next: 'DM2 comes up in 4 days.' },
  ],
  connect: [
    { id: 'c1', person: P.jonah, context: 'Same account as Maya. Fits the data platform buyer.', draft: '', next: 'Ari watches for the accept.' },
    { id: 'c2', person: P.ravi, context: 'Same account as Daniel. Runs the platform team.', draft: '', next: 'Ari watches for the accept.' },
    { id: 'c3', person: P.grace, context: 'Works with Priya on privacy reviews.', draft: '', next: 'Ari watches for the accept.' },
    { id: 'c4', person: P.felix, context: 'Owns the new payments product at Orquadrine.', draft: '', next: 'Ari watches for the accept.' },
    { id: 'c5', person: P.leo, context: 'Leads the loyalty build at Plessivarn.', draft: '', next: 'Ari watches for the accept.' },
  ],
  exec: [
    { id: 'e1', person: P.hannah, context: 'No reply after DM3. The exec track asks for an intro instead.',
      draft: 'Hannah, I have been trying to reach the right person on claims data privacy at Quellivarn. Would you point me to them, or is it you?',
      next: 'Ari watches for her answer.' },
  ],
  waiting: [
    { id: 'w1', person: P.omar, context: 'Invite sent 9 days ago. Withdraw on day 14.', draft: '', next: '' },
    { id: 'w2', person: P.aisha, context: 'DM3 due Thursday.', draft: '', next: '' },
    { id: 'w3', person: P.tom, context: 'Invite sent 3 days ago.', draft: '', next: '' },
    { id: 'w4', person: P.grace, context: 'Invite sent 1 day ago.', draft: '', next: '' },
  ],
};

export interface PlanStep { day: number; what: string }
export interface Motion {
  id: string;
  account: string;
  whyNow: string;
  people: { person: Person; step: string }[];
  plan: PlanStep[];
  pacing: string[];
  state: 'suggested' | 'running' | 'closed';
  day: number;
}

const PLAN: PlanStep[] = [
  { day: 1, what: 'Connect with all four, no note' },
  { day: 3, what: 'Like or comment on one recent post each' },
  { day: 5, what: 'DM1 to everyone who accepted' },
  { day: 9, what: 'DM2 with the account news' },
  { day: 12, what: 'DM3, or move the senior person to the exec track' },
  { day: 14, what: 'Close the motion and withdraw open invites' },
];
const PACING = ['At most 2 touches per person each week', 'Only inside your hours, Monday to Friday', 'Stop for a person the moment they reply'];

export const DEMO_MOTIONS: Motion[] = [
  { id: 'tolvessine', account: 'Tolvessine Pharma', state: 'suggested', day: 0, plan: PLAN, pacing: PACING,
    whyNow: 'Hired a new Chief Data Officer on Oct 19 and posted three data privacy roles this month.',
    people: [{ person: P.aisha, step: 'Not contacted' }, { person: P.omar, step: 'Invite sent' }, { person: p('t3', 'Iris Vancemock', 'Head of Clinical Data', 'Tolvessine Pharma'), step: 'Not contacted' }, { person: p('t4', 'Marco Silvample', 'Security Lead', 'Tolvessine Pharma'), step: 'Not contacted' }] },
  { id: 'orquadrine', account: 'Orquadrine Systems', state: 'suggested', day: 0, plan: PLAN, pacing: PACING,
    whyNow: 'Said on its Oct 21 earnings call that it is moving into payments next quarter.',
    people: [{ person: P.felix, step: 'Not contacted' }, { person: P.lucas, step: 'Accepted' }, { person: p('o3', 'Dana Mockwhit', 'VP Compliance', 'Orquadrine Systems'), step: 'Not contacted' }, { person: p('o4', 'Kai Morsynth', 'Head of Risk', 'Orquadrine Systems'), step: 'Not contacted' }] },
  { id: 'halvenquist', account: 'Halvenquist Freight', state: 'running', day: 6, plan: PLAN, pacing: PACING,
    whyNow: 'Opened two partner data hubs in October and is hiring a data protection lead.',
    people: [{ person: P.sofia, step: 'DM2 due' }, { person: P.tom, step: 'Invite sent' }, { person: p('h3', 'Ben Ashsynth', 'Data Engineer', 'Halvenquist Freight'), step: 'Accepted' }, { person: p('h4', 'Lena Foxample', 'IT Director', 'Halvenquist Freight'), step: 'DM1 sent' }] },
];

export interface Research { id: string; account: string; done: number; total: number }
export const DEMO_RESEARCH: Research[] = [{ id: 'marquessine', account: 'Marquessine Bank', done: 3, total: 4 }];

export interface Suggestion { id: string; text: string; done: string }
export const DEMO_SUGGESTIONS: Suggestion[] = [
  { id: 's1', text: 'Withdraw 6 invites that are older than 14 days.', done: '6 invites added to your Withdraw list.' },
  { id: 's2', text: 'Two DM2s are due tomorrow. Write them now so they are ready in the morning.', done: 'Ari is writing 2 DM2s.' },
];

export const REPORT = {
  rows: [
    { label: 'Connects', now: 72, before: 68 },
    { label: 'Accepts', now: 23, before: 19 },
    { label: 'Messages', now: 41, before: 37 },
    { label: 'Replies', now: 6, before: 4 },
    { label: 'Meetings', now: 2, before: 1 },
  ],
  ab: [
    { arm: 'A', name: 'Question opener', sent: 18, replies: 3 },
    { arm: 'B', name: 'News opener', sent: 17, replies: 5 },
  ],
};

export interface AccountRow { company: string; people: { person: Person; step: string }[] }
/** The Accounts sheet: every person grouped by company, with their sequence step. */
export function accountRows(passes: Record<Kind, PassItem[]>): AccountRow[] {
  const step: Record<Kind, string> = { reply: 'Replied', dm2: 'DM2 due', dm1: 'DM1 ready', connect: 'Connect today', exec: 'Exec track', waiting: 'Waiting' };
  const by = new Map<string, Map<string, { person: Person; step: string }>>();
  for (const k of KINDS) for (const it of passes[k]) {
    const m = by.get(it.person.company) ?? new Map();
    if (!m.has(it.person.id)) m.set(it.person.id, { person: it.person, step: step[k] });
    by.set(it.person.company, m);
  }
  return [...by.entries()].map(([company, m]) => ({ company, people: [...m.values()] })).sort((a, b) => a.company.localeCompare(b.company));
}

export const REP = { name: 'Alex Morsynth', first: 'Alex', role: 'Sales development rep', hours: '9 AM to 6 PM' };
