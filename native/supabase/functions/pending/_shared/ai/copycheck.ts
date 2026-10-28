// Copy check, server version (PENDING, Oct 28 2026). Deterministic port of the HARD rules in scripts/copy_check.py
// _check_v1 that need no database, no seller config file and no corpus: R11 (dash, banned phrases, hedges about the reader,
// not-X-it's-Y shape, framing labels, P.S., more than one question, trailing dots, semicolon, flattery, links), C1 (sentence
// over 26 words, vague referents), M1 (meeting or time ask), A2 (offer with no asset), R10 (length), R3 (seller named in DM1),
// R5 (stock closer). NOT ported (gap, still Python on the worker): R9 example copying (needs plans/copy-lab corpus), repeat /
// anti-sameness checks (need sent history), structure picks (S2/S5/S6/F1), the AE style guide (style_flags, needs seller_config).
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

export function copyCheck(text: string, kind: 'dm1' | 'dm2' | 'dm3' | 'note', opts: { seller?: string; sellerLine?: boolean; hasAsset?: boolean } = {}): CopyResult {
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
  return { pass: flags.length === 0, flags, rules_version: 'copy_check.py v1 hard rules (server subset, Oct 28 2026)',
    not_ported: ['R9 example copying', 'repeat / anti-sameness', 'structure S2/S5/S6/F1', 'AE style guide'] };
}
