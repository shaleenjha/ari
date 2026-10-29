// Copy check, server version (PENDING, Oct 28 2026; AE style guide ported Oct 29 2026). Deterministic port of
// scripts/copy_check.py. Two layers, the same split as the Python check():
//  1. copy_check.py _check_v1 hard rules that need no database, no seller config file and no corpus: R11 (dash, banned phrases,
//     hedges about the reader, not-X-it's-Y shape, framing labels, P.S., more than one question, trailing dots, semicolon,
//     flattery, links), C1 (sentence over 26 words, vague referents), M1 (meeting or time ask), A2 (offer with no asset),
//     R10 (length), R3 (seller named in DM1), R5 (stock closer).
//  2. For dm1 / dm2 / dm3 (the AE style kinds), the AE style guide (plans/copy-lab/ae-styles.md v3, point first, 27 Oct 2026),
//     exactly as copy_check.py check(): the v1 rules run on the text with the guide's fixed lines taken out, the v1 rules the
//     guide replaces are dropped (M1, R3, P1, R5, R4, R2, R10, S/F structure minimums), then style_flags: G1 banned words and
//     placeholders, G3 trigger with no dated hook, G4 one closed ask, G5 word cap, G6 shapes (DM1 opener "Thanks for
//     connecting, <First>." or "<First>, quick one." and close "Worth 15 minutes?" / style B "Worth 20 minutes?"; DM2 / DM3
//     shapes), G7 style A never explains how it works, G8 concrete data, G9 no question before the ask / no open ask,
//     G10 hovering lines and "Most <peers> we talk to", G11 a follow-up reuses a concrete word from what was sent.
// NOT ported (gap, still Python on the worker): R9 example copying (needs plans/copy-lab corpus), repeat / anti-sameness checks
// (need sent history), structure picks (S2/S5/S6/F1), G2 customer names (needs the private seller config), connect-note shapes.
// Code, not a model. Keep the lists in step with scripts/copy_check.py.

export const BANNED = ['reason i reached out', 'thought this might be relevant', 'helping companies like yours', 'wanted to introduce myself',
  'would love to connect', 'just bumping this', 'i know this is a top priority', 'transform', 'revolutioni', 'unlock potential',
  'just checking in', 'circling back', 'hope this finds you well', 'i came across', "in today's landscape", "let me know if you're interested",
  'leverage', 'utilize', 'streamline', 'robust', 'seamless', 'game-changer', 'game changer', 'synergy', 'just following up', 'i never heard back'];
const HEDGES = [/\bi'?m guessing\b/, /\bmy guess is\b/, /\bi'?d guess\b/, /\bi'?d expect\b/, /\bi imagine\b/, /\bi assume\b/, /\bi'?m assuming\b/, /\bi suspect\b/];
const NOT_X_Y = [/\bnot (just |only )?[\w ,']{1,40}, (it'?s|but)\b/, /\bless about\b.{1,60}\bmore about\b/, /\bthe question (stops|isn'?t)\b/,
  /\bisn'?t about\b.{1,60}\bit'?s about\b/];
const LABELS = [/^(short version|rough answer|the play|bottom line|tl;dr)\s*:/m, /\b(short version|rough answer|the play):/];
const MEETING = [/\b\d{1,2} ?(min|mins|minutes)\b/, /\bquick (chat|call|look|swap|walkthrough)\b/, /\bworth a (chat|call|look|quick)\b/,
  /\bopen to (a |)(call|chat|walkthrough|15|20|30)\b/, /\bnext week\b/, /\bthis month\b/, /\bcalendly\b/, /\bbook (a|some) time\b/,
  /\bjump on a call\b/, /\bgood time to talk\b/, /\bwalk (you|your team) through\b/];
const STOCK_CLOSERS = ['how is your team handling that today', 'how are you handling that today', 'is that on your roadmap',
  'worth a quick chat', 'how is your team handling that', 'curious how your team handles that today'];
const VAGUE = [/\bstill on the list\b/, /\bon (your|the) radar\b/, /\bdraw (that|the) line\b/, /\bthat layer\b/, /\bthis space\b/,
  /\bthat question\b/, /\bthat boundary\b/, /\bthat step\b/, /\bthat piece\b/, /\bthe data side\b/, /\bhandling (that|it|this)\b/,
  /\bthinking about (that|it|this)\b/, /\bapproaching (that|it|this)\b/];
const FLATTERY = /\b(congrats|congratulations|love your|loved your|great post|enjoyed your)\b/i;
const GREETING = /^(hi|hey|hello|thanks)[^,.]*[,.]( (good|great) to connect\.| thanks for connecting\.)?\s*/i;
const OFFER = /\b(send|share|pass along|forward)\b[^.?!]{0,40}\b(it|this|that|the|a|how|short|version|read|details|breakdown|map|notes|summary|over)\b|\bwant (it|a copy|the read)\b|\bmapped\b[^.?!]{0,60}\bwant\b/i;
export const LIMIT: Record<string, number> = { dm1: 300, note: 300, dm2: 350, dm3: 350 };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lastSentence = (t: string) => { const s = t.trim().split(/(?<=[.!?])\s+/).filter(Boolean); return s[s.length - 1] ?? ''; };

export interface CopyResult { pass: boolean; flags: string[]; rules_version: string; not_ported: string[] }
export interface CopyOpts {
  seller?: string; sellerLine?: boolean; hasAsset?: boolean;
  /** run only the v1 server subset (the pre-Oct-29 behaviour); default false = the AE guide runs for dm1 / dm2 / dm3 */
  v1Only?: boolean;
  /** AE style: 'B' = the style B AE's accounts (20 minute ask, 50 words), anything else 'A' (copy_check.py: every other AE and no AE) */
  style?: 'A' | 'B';
  /** a real dated trigger is on file (brief trigger or account hook in the last ~190 days). undefined = not known: never blocks
   *  (copy_check.py _hook_ok returns True when it cannot read the database) */
  hookOk?: boolean;
  /** dm2 / dm3: what was already sent in the thread (G11) */
  sentBefore?: string[];
}

function v1Flags(text: string, kind: string, opts: CopyOpts): string[] {
  const flags: string[] = [];
  const t = text.trim(), low = t.toLowerCase(), body = t.replace(GREETING, '');
  if (/[\u2014\u2013]/.test(t) || /\s-\s/.test(t)) flags.push('R11 dash');
  for (const b of BANNED) if (low.includes(b)) flags.push(`R11 banned phrase '${b}'`);
  if (HEDGES.some((h) => h.test(low))) flags.push('R11 hedge about the reader');
  if (NOT_X_Y.some((p) => p.test(low))) flags.push("R11 not-X-it's-Y shape");
  if (LABELS.some((p) => p.test(low))) flags.push('R11 framing label');
  if (low.includes('p.s') || /\bps[:.]/.test(low)) flags.push('R11 P.S.');
  if ((t.match(/\?/g) ?? []).length > 1) flags.push('R11 more than one question');
  if (t.includes('...') || t.includes('\u2026')) flags.push('R11 trailing dots');
  if (t.includes(';')) flags.push('R11 semicolon (over-polish)');
  if (FLATTERY.test(body) && (body.split('.')[0] ?? '').split(/\s+/).length <= 6) flags.push('R11 surface flattery with nothing attached');
  if (/https?:\/\/|calendly|cal\.com/.test(low)) flags.push('R11 link or calendar in a DM');
  if (body.split(/(?<=[.!?])\s+/).some((s) => s.split(/\s+/).filter(Boolean).length > 26)) flags.push('C1 sentence over 26 words, hard to parse');
  const vague = VAGUE.map((p) => low.match(p)).find(Boolean);
  if (vague) flags.push(`C1 vague phrase '${vague[0]}' (say the concrete thing)`);
  if (MEETING.some((p) => p.test(low))) flags.push('M1 meeting or time ask');
  if (!opts.hasAsset && OFFER.test(t)) flags.push('A2 offers to send something with no asset');
  const lim = LIMIT[kind] ?? 350;
  if (t.length > lim) flags.push(`R10 over ${lim} characters (${t.length})`);
  const seller = (opts.seller ?? 'Thrandvex').toLowerCase();
  if (kind === 'dm1' && !opts.sellerLine && new RegExp(`\\b${esc(seller)}\\b`).test(low)) flags.push(`R3 seller named in DM1 (default is no product line)`);
  const lastNorm = lastSentence(t).toLowerCase().replace(/[^a-z ]/g, '').trim();
  if (STOCK_CLOSERS.some((s) => lastNorm.includes(s))) flags.push('R5 stock closer');
  return flags;
}

// ---- AE style guide (copy_check.py style_flags + check, ae-styles.md v3) ----
export const GUIDE_KINDS = ['dm1', 'dm2', 'dm3'] as const;
const STYLE_BANNED = ["i'd love to", 'i would love to', "reason i'm reaching out", 'reason i am reaching out', 'unlock', 'revolutioniz',
  'transform your', 'just following up'];
// the guide's shared fixed lines, taken out before the v1 rules see the text (copy_check.py GUIDE_FIXED; the style B customer
// line is matched generically because the customer name lives in the private seller config)
const GUIDE_FIXED = new RegExp(String.raw`(thanks for connecting, [^.]+\.|^\S+, last one from me\.|we built a data privacy layer that|` +
  String.raw`teams like [^.]{1,40} use it\.|worth connecting\?|worth 15 minutes\?|worth a quick call\?|` +
  String.raw`worth 20 minutes with you and|worth 20 minutes\?|happy to show how|we talk to|on your 2027 list|did you see|one more angle|most |` +
  String.raw`^\S+, quick one\.|^\S+, following up on|^\S+, last one from me on|we keep them out\.)`, 'gi');
export const WAVE = ['curious', 'wondering', 'would love your take', 'love your take', 'swap notes', 'trade notes', 'compare notes',
  'thoughts?', 'resonate', 'on your radar', 'on your roadmap', 'how are you handling', 'how is your team',
  'the reason i asked', 'reason i asked', "i'm assuming", 'i am assuming', "i'm guessing", 'happy to share how other',
  'no worries if', 'timing is off', 'timing may be off', 'is that coming up', 'does that ring', 'open to a quick chat'];
const PEER_FILLER = /\bmost [\w ,'&/-]{2,60} we (talk|speak) (to|with)\b/i;
const OPEN_ASK = /^(how|what|which|where|who|why|when|is |are |does |do |did |would |could |should |any )/i;
const CONCRETE = new RegExp(String.raw`\b(phi|pii|pci|ssn|ssns|social security|card numbers?|card data|account numbers?|member ids?|patient|patients|` +
  String.raw`medical records?|health records?|ehr|clinical|claims?|transcripts?|recordings?|call data|bank details|bank|payment|` +
  String.raw`dates? of birth|addresses|names|identifiers?|policyholder|member data|employee data|pay data|payroll|candidate|` +
  String.raw`tickets?|customer data|personal data|financial data|training data|records|identity data|voice data|prompts?|logs|` +
  String.raw`subscriber data|caller data|caller details|participant data|id numbers?|customer fields|data fields)\b`, 'i');
const STOP = new Set(('about after again against their there these those which while would could should where every other being ' +
  'your yours with from into that this what when have will once than then them they ever only just more most also ' +
  'thanks connecting quick following last minutes worth happy show call teams team data').split(' '));
const V1_DROP = ['M1', 'R3', 'P1', 'R5', 'R4', 'R2', 'R10', 'S2 ', 'S5 ', 'S6 ', 'F1 '];
const TRIGGER = /\b(saw|noticed|congrats|just (launched|announced|raised|hired)|announced|launched|raised|hired|joined as)\b/i;
const contentWords = (t: string) => new Set([...(t ?? '').toLowerCase().matchAll(/[a-z][a-z'-]{4,}/g)].map((m) => m[0]).filter((w) => !STOP.has(w)));

/** copy_check.py style_flags for dm1 / dm2 / dm3 (G2 customer names not ported). */
export function styleFlags(kind: 'dm1' | 'dm2' | 'dm3', text: string, opts: CopyOpts = {}): string[] {
  const f: string[] = [];
  const style = opts.style === 'B' ? 'B' : 'A';
  const t = text.trim(), low = t.toLowerCase();
  const nw = t.split(/\s+/).filter(Boolean).length;
  const sents = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  const last = (sents[sents.length - 1] ?? '').toLowerCase();
  for (const b of STYLE_BANNED) if (low.includes(b)) f.push(`G1 banned by the AE guide ('${b}')`);
  if (t.includes('{{')) f.push('G1 template placeholder left in');
  if (TRIGGER.test(t) && opts.hookOk === false) f.push('G3 trigger line with no dated hook on file (drop it and use the plain problem)');
  if (!t.includes('?') || !last.endsWith('?')) f.push('G4 must end on one closed ask');
  const lim = kind === 'dm1' ? (style === 'B' ? 50 : 45) : kind === 'dm2' ? 40 : 35;
  if (nw > lim) f.push(`G5 over ${lim} words (${nw}): cut to the point`);
  if (sents.slice(0, -1).join(' ').includes('?')) f.push('G9 question before the ask: say it as a statement; the only question is the closing ask');
  if (OPEN_ASK.test(last) && !last.startsWith('worth ')) f.push('G9 the ask is an open question: end on the closed ask');
  const w = WAVE.find((x) => low.includes(x));
  if (w) f.push(`G10 hovering line ('${w}'): name the problem and the ask plainly`);
  if (PEER_FILLER.test(t)) f.push("G10 'Most <peers> we talk to' is filler: say what happens at THEIR company");
  if (!CONCRETE.test(t)) f.push('G8 name the concrete data (PHI, card numbers, transcripts, claims ...) and where it bites');
  const ask15 = 'worth 15 minutes?', ask20 = 'worth 20 minutes?';
  if (kind === 'dm1') {
    if (!(low.startsWith('thanks for connecting') || /^\S+, quick one\./.test(low))) f.push("G6 DM1 opens 'Thanks for connecting, <First>.' or '<First>, quick one.'");
    if (style === 'A') {
      if (!last.endsWith(ask15)) f.push("G6 style A DM1 ends 'Worth 15 minutes?'");
      if (/\b(20|30|45) (min|mins|minutes)\b/.test(low)) f.push('G6 style A never asks past 15 minutes');
      if (/\btokeni[sz]ation\b|\bencrypt|\bvault\b/.test(low)) f.push('G7 style A never explains how it works');
    } else if (!(last.endsWith(ask20) || /^worth 20 minutes with you and .+\?$/.test(last))) f.push("G6 style B DM1 ends 'Worth 20 minutes?'");
  }
  if (kind === 'dm2') {
    if (low.includes('last one from me')) f.push("G6 DM2 is not the close ('last one from me' is DM3)");
    if (!/^\S+, following up on [^.?!]{3,60}\./.test(low)) f.push("G6 DM2 opens '<First>, following up on <the DM1 point in a few words>.'");
    const want = style === 'B' ? ask20 : ask15;
    if (!last.endsWith(want)) f.push(`G6 DM2 ends '${want[0].toUpperCase()}${want.slice(1)}'`);
  }
  if (kind === 'dm3') {
    if (!/^\S+, last one from me on [^.?!]{3,60}\./.test(low)) f.push("G6 DM3 opens '<First>, last one from me on <the thread's point>.'");
    if (!low.includes('happy to show how')) f.push("G6 DM3 carries 'happy to show how ...'");
    if (!last.startsWith('worth a quick call')) f.push("G6 DM3 ends 'Worth a quick call?'");
  }
  if (kind !== 'dm1') {
    const prev = (opts.sentBefore ?? []).filter((x) => x && x.trim());
    const mine = contentWords(t);
    if (prev.length && !prev.some((x) => [...contentWords(x)].some((c) => mine.has(c)))) {
      f.push(`G11 not a follow-up: pick up a concrete word from what was already sent (${kind === 'dm2' ? 'DM1' : 'DM1/DM2'})`);
    }
  }
  if ((t.match(/\?/g) ?? []).length > 1) f.push('G4 one ask only');
  return f;
}

export function copyCheck(text: string, kind: 'dm1' | 'dm2' | 'dm3' | 'note', opts: CopyOpts = {}): CopyResult {
  const guide = !opts.v1Only && (GUIDE_KINDS as readonly string[]).includes(kind);
  if (!guide) {
    const flags = v1Flags(text, kind, opts);
    return { pass: flags.length === 0, flags, rules_version: 'copy_check.py v1 hard rules (server subset, Oct 28 2026)',
      not_ported: ['R9 example copying', 'repeat / anti-sameness', 'structure S2/S5/S6/F1', 'AE style guide'] };
  }
  // copy_check.py check(): v1 on the text minus the guide's fixed lines, seller line allowed, guide-replaced rules dropped
  const core = text.replace(GUIDE_FIXED, ' ');
  let flags = v1Flags(core, kind, { ...opts, sellerLine: true }).filter((x) => !V1_DROP.some((d) => x.startsWith(d)));
  if (opts.style === 'B' && kind === 'dm1') flags = flags.filter((x) => x !== 'R11 more than one question');
  flags = [...flags, ...styleFlags(kind as 'dm1' | 'dm2' | 'dm3', text, opts)];
  return { pass: flags.length === 0, flags, rules_version: 'copy_check.py check() for dm kinds: v1 server subset + AE style guide v3 (Oct 29 2026)',
    not_ported: ['R9 example copying', 'repeat / anti-sameness', 'structure S2/S5/S6/F1', 'G2 customer names'] };
}

/** The redraft instruction for a DM1 that failed the check: the flagged rules plus the guide's DM1 shape (ae-styles.md v3). */
export function dm1FixInstruction(flags: string[], style: 'A' | 'B' = 'A'): string {
  const ask = style === 'B' ? 'Worth 20 minutes?' : 'Worth 15 minutes?';
  return [`The draft below failed Owner's copy check. Flagged rules: ${flags.map((f) => f.replace(/\s+/g, ' ')).join(' | ')}.`,
    'Write DM1 again in exactly this shape (point first):',
    '1. Open with "Thanks for connecting, <First>." or "<First>, quick one."',
    '2. One statement, not a question: their product or workflow, the exact data (PHI, card numbers, member IDs, transcripts, claims) and where it bites (the review, deal or partner that stalls). A dated trigger from the brief may sit inside this statement, never as "saw that" or "congrats".',
    `3. What we do in under 10 words, for example "We keep them out." Never how it works${style === 'A' ? ' (no tokenization, encryption or vault)' : ''}.`,
    `4. End with exactly "${ask}". That is the only question mark in the message.`,
    `Under ${style === 'B' ? 50 : 45} words. Never: open questions, "curious", "wondering", "how is your team", "how are you handling", "on your radar", "Most <peers> we talk to", dashes, links, the seller's name.`,
    'Use only facts from the context. Same reply format as before.'].join('\n');
}
