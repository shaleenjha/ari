// Fact-check stage (PENDING, Oct 28 2026; Owner: Parallel = YES, public company-level claims ONLY).
// What may leave Ari: the company name, its website domain, and a claim about the COMPANY that came from public web research
// (a DM1 source fact whose source is an https url). Never: the contact's name or title, CRM notes, AE / deal data, or the
// seller's own pitch text. The filter below decides that in code and logs every decision; the exact payload sent is returned
// so the job row records it. Verdicts are cached by (company_domain, claim_hash) so other contacts at the same account do
// not pay again. Parallel Decisions API: POST https://api.parallel.ai/v1/decisions, header x-api-key (docs checked Oct 28).
// A verdict only FLAGS (needs_review); it never edits or strikes a draft.
import { guardedFetch } from './http.ts';

export interface FactInput {
  dm_text: string;
  source_facts: { fact: string; source?: string }[];
  company: string;
  domain: string;
  contact: { name?: string; title?: string };
  seller?: string;
}
export interface Decision { item: string; decision: string }
export interface Claim { claim: string; hash: string; source: string }

const MAX_CLAIMS = 3;
const CHECKED = new Set(['true', 'false', 'unverifiable']);
export const normClaim = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w %$.,:/-]/g, '').trim();
export async function claimHash(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normClaim(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function domainOk(d: string): string | null {
  const x = d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x) ? x : null;
}

// Name matching is Unicode-aware (review #50): "Müller" / "José" must be caught whether a claim writes the accented form,
// the plain form ("Muller", "Jose") or the German transliteration ("Mueller"). Each side is compared in every form.
const MARKS = /\p{M}/gu;
/** Accent-folded, case-folded form: NFKD, drop combining marks, lower case, a few full case folds JS lacks. */
export const fold = (s: string) => s.normalize('NFKD').replace(MARKS, '').toLowerCase().replace(/ß/g, 'ss').replace(/ı/g, 'i').normalize('NFC');
const translit = (s: string) => s.normalize('NFC').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss');
/** All forms a text may be compared in: raw lower case, folded, transliterated (deduped). */
export const forms = (s: string) => [...new Set([s.normalize('NFC').toLowerCase(), fold(s), fold(translit(s))])];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** true when `part` appears as a whole word (Unicode letter/number boundaries) in any form of `text`. */
export function mentions(text: string, part: string): boolean {
  const texts = forms(text);
  return forms(part).some((p) => p && texts.some((t) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(p)}(?![\\p{L}\\p{N}])`, 'u').test(t)));
}
// Scripts written without spaces between words (Han, kana, Hangul, Thai, Lao, Khmer, Myanmar): a word boundary means nothing
// there ("李明是..." has no boundary after 明), so a name part in one of them is matched as a plain substring.
const NO_SPACE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const NOT_LN = /[^\p{L}\p{N}]/gu;
/** Letters and numbers only, folded ("(Dee)" -> "dee", "李 明" -> "李明", "O'Brien" -> "obrien"). */
export const core = (s: string) => fold(s).replace(NOT_LN, '');

/** Name parts worth matching (review #51). The name is split on whitespace; each part is matched as written (outer
 *  punctuation trimmed: "(Dee)" -> "Dee") and with inner punctuation removed ("O'Brien" -> "OBrien"), plus its hyphen /
 *  apostrophe / dot pieces of 2+ letters ("Jean-Luc" -> "Jean", "Luc"). `spaceless` is the whole name with every non
 *  letter/number removed ("李 明" -> "李明", "Mary Ann" -> "maryann"); it is matched against the claim with the same characters
 *  removed. `unfoldable` = some whitespace part has fewer than 2 letters/numbers left (an initial "J.", a one-character CJK
 *  part "李", a part of only marks or symbols): such a name cannot be matched safely, so every claim is blocked. */
export function nameParts(name: string): { parts: string[]; spaceless: string; unfoldable: boolean } {
  const n = name.normalize('NFC').trim(); if (!n) return { parts: [], spaceless: '', unfoldable: false };
  const tokens = n.split(/\s+/).filter(Boolean);
  const unfoldable = tokens.some((tk) => [...core(tk)].length < 2);
  const trimP = (s: string) => s.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  const parts: string[] = [];
  const add = (s: string) => { if ([...core(s)].length >= 2) parts.push(s); };
  add(n);
  for (const tk of tokens) {
    add(trimP(tk)); add(tk.replace(NOT_LN, ''));
    for (const piece of tk.split(/[\-\u2010\u2011'\u2019.,()\[\]{}"\u201c\u201d]+/)) add(trimP(piece));
  }
  return { parts: [...new Set(parts)], spaceless: core(n), unfoldable };
}

/** true when the claim names the contact in any matched form. */
export function mentionsName(text: string, np: { parts: string[]; spaceless: string }): boolean {
  if (np.parts.some((p) => NO_SPACE.test(p) ? forms(text).some((t) => forms(p).some((x) => x && t.includes(x))) : mentions(text, p))) return true;
  // space-free whole name: "李明" for "李 明", "DanaWhitfield" / "dana-whitfield" for "Dana Whitfield". Substring on purpose:
  // a false hit only blocks a claim (safe side). Needs 4+ characters (or a no-space script) so it cannot hit by chance.
  const s = np.spaceless;
  if (!s || ([...s].length < 4 && !NO_SPACE.test(s))) return false;
  return forms(text).some((t) => t.replace(NOT_LN, '').includes(s)) || core(text).includes(s);
}

/** Pick the claims that MAY be sent. Pure; every item gets a logged decision. */
export function selectClaims(f: FactInput): { eligible: { claim: string; source: string }[]; decisions: Decision[] } {
  const decisions: Decision[] = [], eligible: { claim: string; source: string }[] = [];
  const np = nameParts(f.contact.name ?? '');
  const title = (f.contact.title ?? '').trim();
  const seller = f.seller ?? 'Thrandvex';
  for (const sf of f.source_facts ?? []) {
    const c = String(sf.fact ?? '').trim(), low = fold(c), src = String(sf.source ?? '');
    const why = !c ? 'empty'
      : !/^https:\/\//i.test(src) ? 'blocked: not from public web research (record field or no url)'
      : np.unfoldable ? 'blocked: contact name cannot be matched safely'
      : mentionsName(c, np) ? 'blocked: mentions the contact'
      : title && forms(c).some((t) => forms(title).some((x) => t.includes(x))) ? 'blocked: mentions the contact title'
      : mentions(c, seller) ? 'blocked: seller pitch'
      : /(?<![\p{L}\p{N}])(ae|account executive|deal|opportunity|pipeline|crm|crm|meeting with us|our call)(?![\p{L}\p{N}])/u.test(low) ? 'blocked: sales or CRM data'
      : c.length > 400 ? 'blocked: too long to be one claim'
      : eligible.length >= MAX_CLAIMS ? 'skipped: claim cap'
      : null;
    decisions.push({ item: c.slice(0, 160), decision: why ?? 'eligible: public company-level claim' });
    if (!why) eligible.push({ claim: c, source: src });
  }
  return { eligible, decisions };
}

/** The exact request body for one claim (same question shape as the Oct 28 G12 eval, work/parallel-eval/stress/d3_run.py). */
export function decisionBody(company: string, domain: string, claim: string) {
  return {
    state: { company, website: `https://${domain}`, claim },
    questions: {
      verdict: { type: 'choice', instructions: `Based on public evidence, is this claim about the company accurate in every stated detail, including dates, numbers and names? Claim: "${claim}". Select unverifiable when evidence is insufficient.`,
        criteria: { true: 'Evidence confirms every detail of the claim', false: 'Evidence contradicts at least one detail (wrong date, number, name or event)',
          unverifiable: 'Evidence insufficient to confirm or contradict' } },
    },
    include_excerpts: false,
  };
}

// deno-lint-ignore no-explicit-any
export function readVerdict(j: any): { verdict: string; confidence: number | null; citations: string[] } {
  const a = j?.answers?.verdict;
  if (!a || a.type === 'refusal') return { verdict: 'refusal', confidence: null, citations: [] };
  return { verdict: a.choice == null ? 'refusal' : String(a.choice), confidence: typeof a.confidence === 'number' ? Math.round(a.confidence * 1000) / 1000 : null,
    citations: (Array.isArray(j?.citations) ? j.citations : []).map((c: { url?: string }) => c?.url).filter((u: unknown) => typeof u === 'string').slice(0, 5) };
}

export interface FactDeps {
  cacheGet(domain: string, hashes: string[]): Promise<Record<string, unknown>>;
  cachePut(domain: string, hash: string, claim: string, verdict: unknown): Promise<void>;
  key?: string;                                   // PARALLEL_API_KEY; missing = stage reports not_configured, sends nothing
  post?: (body: unknown) => Promise<unknown>;     // tests
}

export async function factCheck(f: FactInput, d: FactDeps) {
  const t0 = Date.now();
  const domain = domainOk(f.domain);
  const { eligible, decisions } = selectClaims(f);
  if (!domain) return { status: 'skipped', reason: 'no valid company domain', decisions, payloads: [], verdicts: [], calls: 0 };
  if (!eligible.length) return { status: 'done', reason: 'no eligible public company claims', decisions, payloads: [], verdicts: [], calls: 0 };
  const claims: Claim[] = await Promise.all(eligible.map(async (e) => ({ ...e, hash: await claimHash(e.claim) })));
  const cached = await d.cacheGet(domain, claims.map((c) => c.hash));
  const todo = claims.filter((c) => !cached[c.hash]);
  if (todo.length && !d.key && !d.post) return { status: 'blocked', reason: 'PARALLEL_API_KEY not configured', decisions, payloads: [], verdicts: [], calls: 0 };
  const post = d.post ?? (async (body: unknown) => {
    const r = await guardedFetch('https://api.parallel.ai/v1/decisions', { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-api-key': d.key! } }, { timeoutMs: 20_000, retries: 1 });
    return await r.json();
  });
  const payloads = todo.map((c) => decisionBody(f.company, domain, c.claim));
  // claims are independent: check them in parallel. Only real answers (true / false / unverifiable) are cached: an error or a
  // refusal is NOT a check, so it is never cached and never reads as clean (review #50).
  const fresh = await Promise.all(todo.map(async (c, i) => {
    try {
      const v = readVerdict(await post(payloads[i]));
      if (CHECKED.has(v.verdict)) await d.cachePut(domain, c.hash, c.claim, v);
      return [c.hash, v] as const;
    } catch (e) { return [c.hash, { verdict: 'error', confidence: null, citations: [], error: String((e as Error)?.message ?? e).slice(0, 120) }] as const; }
  }));
  const all: Record<string, unknown> = { ...cached, ...Object.fromEntries(fresh) };
  const verdicts = claims.map((c) => ({ claim: c.claim, source: c.source, claim_hash: c.hash, cached: !!cached[c.hash], ...(all[c.hash] as object) }));
  const vs = verdicts.map((v) => String((v as { verdict?: string }).verdict ?? ''));
  const unchecked = vs.filter((v) => !CHECKED.has(v)).length;          // error, refusal or anything unexpected
  const errors = vs.filter((v) => v === 'error').length;
  // flagged = a human must look: a false claim OR any claim we could not check
  const flagged = vs.includes('false') || unchecked > 0;
  return { status: unchecked ? 'unchecked' : 'done', decisions, payloads, verdicts, calls: todo.length, flagged, unchecked, errors, ms: Date.now() - t0 };
}
