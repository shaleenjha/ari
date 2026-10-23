// Live AI layer (PENDING). Copied VERBATIM from app2/jobs/src/draft-eval/style.ts (Quill); keep in step. Used to force
// needs_review on any model draft that breaks a hard house-style gate. Below this line: verbatim.
// Quill: DM style scorer for Ari's drafting engine. Deterministic, no LLM. Scores a LinkedIn DM against the house style:
// 1 to 2 lines, under 300 characters (works as a connection note), no em/en dashes, no hedging, no banned phrases, one ask,
// no unfilled placeholders, and it names the person or their company. Hard gates (lines, length, dashes, placeholders, hedging, banned phrases) fail the draft; soft rules cost points.
export type RuleId = 'lines' | 'length' | 'dash' | 'placeholder' | 'hedge' | 'banned' | 'asks' | 'personal' | 'opener' | 'exclaim';
export interface Violation { rule: RuleId; hard: boolean; detail: string }
export interface StyleScore { score: number; pass: boolean; violations: Violation[]; chars: number; lines: number }
export interface DraftContext { firstName?: string; company?: string }

export const MAX_CHARS = 300;
// hedges weaken the ask; matched as whole words / phrases, case-insensitive
export const HEDGES = ['just', 'maybe', 'perhaps', 'possibly', 'hopefully', 'i think', 'i believe', 'i feel', 'i guess', 'sort of', 'kind of',
  'might be', 'could be worth', 'i was wondering', 'wondering if', 'no worries if not', 'if you have a moment', 'if it makes sense',
  'not sure if', 'apologies', 'sorry to bother', 'feel free', 'a little', 'quick question'];
export const BANNED = ['p.s.', 'ps:', 'hope this finds you well', 'hope you are well', "hope you're well", 'circle back', 'touch base',
  'synergy', 'game changer', 'game-changer', 'revolutionary', 'cutting-edge', 'best-in-class', 'pick your brain', 'reaching out because',
  'wanted to reach out', 'per my last', 'as per', 'let me know your thoughts'];
const DASHES = /[\u2013\u2014\u2012\u2015]|\s-{1,2}\s/;          // en, em, figure, horizontal bar, or a spaced hyphen used as a dash
const PLACEHOLDER = /\{\{[^}]*\}\}|\[(?:first ?name|name|company|title)\]|<(?:name|company)>|\bXX+\b/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phraseRe = (p: string) => new RegExp(`(^|[^a-z'])${esc(p)}(?=$|[^a-z'])`, 'i');

export function scoreDraft(body: string, ctx: DraftContext = {}): StyleScore {
  const v: Violation[] = [];
  const text = body.trim();
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 1 || lines.length > 2) v.push({ rule: 'lines', hard: true, detail: `${lines.length} lines (1 to 2)` });
  if (text.length > MAX_CHARS) v.push({ rule: 'length', hard: true, detail: `${text.length} chars (max ${MAX_CHARS})` });
  const dash = text.match(DASHES);
  if (dash) v.push({ rule: 'dash', hard: true, detail: `dash "${dash[0].trim()}"` });
  const ph = text.match(PLACEHOLDER);
  if (ph) v.push({ rule: 'placeholder', hard: true, detail: `unfilled "${ph[0]}"` });
  for (const h of HEDGES) if (phraseRe(h).test(text)) v.push({ rule: 'hedge', hard: true, detail: h });
  for (const b of BANNED) if (text.toLowerCase().includes(b)) v.push({ rule: 'banned', hard: true, detail: b });
  const q = (text.match(/\?/g) ?? []).length;
  if (q > 1) v.push({ rule: 'asks', hard: false, detail: `${q} questions (one ask)` });
  if (ctx.firstName || ctx.company) {
    const named = [ctx.firstName, ctx.company].filter((x): x is string => !!x).some((x) => text.toLowerCase().includes(x.toLowerCase()));
    if (!named) v.push({ rule: 'personal', hard: false, detail: 'names neither the person nor the company' });
  }
  if (/^(dear|greetings|hello there|to whom)/i.test(text)) v.push({ rule: 'opener', hard: false, detail: 'stiff opener' });
  if ((text.match(/!/g) ?? []).length > 1) v.push({ rule: 'exclaim', hard: false, detail: 'more than one "!"' });
  const cost: Record<RuleId, number> = { lines: 40, length: 40, dash: 40, placeholder: 60, banned: 30, hedge: 10, asks: 15, personal: 15, opener: 10, exclaim: 5 };
  const score = Math.max(0, 100 - v.reduce((s, x) => s + cost[x.rule], 0));
  return { score, pass: !v.some((x) => x.hard) && score >= 70, violations: v, chars: text.length, lines: lines.length };
}
