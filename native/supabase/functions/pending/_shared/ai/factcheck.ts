// Fact-check stage (PENDING, Oct 28 2026; Owner: Parallel = YES, public company-level claims ONLY).
// What may leave Ari: the company name, its website domain, and a claim about the COMPANY that came from public web research
// (a DM1 source fact whose source is an https url). Never: ANY person's name or role (the contact, other executives the
// research found, founders; Owner, Oct 28 2026), the contact's title, CRM notes, AE / deal data, or the seller's own pitch text. The filter below decides that in code and logs every decision; the exact payload sent is returned
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
  /** every OTHER person name Ari knows for this account (contacts on file, brief committee). Any claim naming one is dropped. */
  people?: string[];
  seller?: string;
  /** the account's public research (research rows, research brief summary / angles): the ONLY source of the brand allowlist */
  research?: { fact?: string; source_url?: string }[];
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

/** A middle initial ("J", "J.") in a Latin-style script. Oct 28 2026: it is ignored for matching (alone it would match any
 *  stray letter, and treating it as unmatchable blocked EVERY claim for "Dana J. Whitfield"). A one-character Han / kana /
 *  Hangul part is NOT an initial: it is a real name part and still makes the name unmatchable (block all). */
export const isInitial = (tk: string) => /^\p{L}\.?$/u.test(tk.normalize('NFC')) && !NO_SPACE.test(tk);
/** Claim text with initials taken out ("Dana J. Whitfield" -> "Dana Whitfield"), so the whole-name checks still match it. */
export const stripInitials = (s: string) => s.normalize('NFC').replace(/(?<![\p{L}\p{N}])\p{Lu}\.?(?=\s+\p{Lu})/gu, ' ').replace(/\s+/g, ' ');

/** Name parts worth matching (review #51). The name is split on whitespace; each part is matched as written (outer
 *  punctuation trimmed: "(Dee)" -> "Dee") and with inner punctuation removed ("O'Brien" -> "OBrien"), plus its hyphen /
 *  apostrophe / dot pieces of 2+ letters ("Jean-Luc" -> "Jean", "Luc"). `spaceless` is the whole name with every non
 *  letter/number removed ("李 明" -> "李明", "Mary Ann" -> "maryann"); it is matched against the claim with the same characters
 *  removed. `unfoldable` = some whitespace part has fewer than 2 letters/numbers left (an initial "J.", a one-character CJK
 *  part "李", a part of only marks or symbols): such a name cannot be matched safely, so every claim is blocked. */
export function nameParts(name: string): { parts: string[]; spaceless: string; unfoldable: boolean } {
  const full = name.normalize('NFC').trim(); if (!full) return { parts: [], spaceless: '', unfoldable: false };
  const tokens = full.split(/\s+/).filter((tk) => tk && !isInitial(tk));          // initials ignored (Oct 28 2026)
  if (!tokens.length) return { parts: [], spaceless: '', unfoldable: true };       // a name of initials only: block all
  const n = tokens.join(' ');
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
export function mentionsName(raw: string, np: { parts: string[]; spaceless: string }): boolean {
  const text = stripInitials(raw);
  if (np.parts.some((p) => NO_SPACE.test(p) ? forms(text).some((t) => forms(p).some((x) => x && t.includes(x))) : mentions(text, p))) return true;
  // space-free whole name: "李明" for "李 明", "DanaWhitfield" / "dana-whitfield" for "Dana Whitfield". Substring on purpose:
  // a false hit only blocks a claim (safe side). Needs 4+ characters (or a no-space script) so it cannot hit by chance.
  const s = np.spaceless;
  if (!s || ([...s].length < 4 && !NO_SPACE.test(s))) return false;
  return forms(text).some((t) => t.replace(NOT_LN, '').includes(s)) || core(text).includes(s);
}

// ---- any person, not just the contact (Owner, Oct 28 2026: only company-level facts go to Parallel) ----
// A claim that names or describes ANY person is dropped, whoever it is (the contact, another executive the research found,
// a founder, a board member). Three nets, any one blocks: (1) a name Ari knows (contact + people on file + brief committee);
// (2) a person role or appointment word (CEO, Chief ... Officer, General Counsel, VP, founder, "appointed", ...): a claim
// about a role holder is about a person, named or not; (3) a name-shaped token or run (fail-closed, review #54, below);
// (4) a personal pronoun. False hits only drop a claim (safe side); a dropped claim is logged in decisions with its reason.
const ROLE = /(?<![\p{L}\p{N}])(ceo|cfo|cto|cio|ciso|coo|cpo|cmo|cro|cso|cdo|chief\s+[\p{L} &-]{0,40}?officer|general counsel|vice president|s?e?vp|president|founder|co-?founder|chair(man|woman|person)?|board member|board of directors|director|head of|executive|exec|spokes(person|man|woman)|appoint(s|ed|ment)?|named as|promot(ed|es)|steps? down|stepped down|resign(s|ed)?|retir(es|ed)|hired as|joins as|joined as)(?![\p{L}\p{N}])/iu;
const HONORIFIC = /(?<![\p{L}\p{N}])(mr|mrs|ms|mx|dr|prof|sir|dame)\.?\s+\p{Lu}/u;
// capitalised words that commonly start or fill a non-name phrase (kept short; a miss here only drops a claim)
const COMMON = new Set(('january february march april may june july august september october november december jan feb mar apr jun jul aug ' +
  'sep sept oct nov dec monday tuesday wednesday thursday friday saturday sunday the a an and or of in on at for to by with from its it ' +
  'this that these those new north south east west united states america american europe european asia global national federal state ' +
  'inc corp corporation co company ltd llc plc group holdings health healthcare care medical hospital patient patients data security ' +
  'privacy cloud service services platform software systems system solutions technology technologies network networks digital ' +
  'report reports policy policies notice credit monitoring business associate agreement act rule law office department agency ' +
  'commission exchange securities stock nasdaq nyse annual quarter quarterly fiscal year form filing release press news newsroom ' +
  'information management officer partners partner capital fund series round series ai machine learning api app apps labs lab ' +
  'center centre university institute foundation association council board team teams community program programs project index ' +
  'insights research survey study vendor risk breach incident attack malware ransomware infostealer customer customers product ' +
  'products launch launched announces announced expands expanded acquires acquired acquisition merger partnership public private ' +
  'general street journal times post daily weekly magazine wire newswire business').split(' '));
// Review #54 (Oct 29 2026): the name net is FAIL-CLOSED. When the code cannot tell whether a capitalised token is a person,
// the claim is dropped (a dropped claim costs one fact check; a leaked name breaks the rule). It catches:
//  (a) a run of 2+ capitalised tokens (Title Case, ALL CAPS, CamelCase, initials, with name particles such as von / van / de /
//      al / bin / le / da inside) when ANY token in the run is not a known safe word. A safe word (COMMON, the company's own
//      words, a known acronym) no longer breaks or hides a run: "Grant Post", "May Chen" and "Hale Norquiveth" all block;
//  (b) a particle-joined token ("al-Rashid", "d'Souza", "bin-Salman") on its own;
//  (c) a SINGLE unknown capitalised token right after said / says / told / tells / by / led / from / named / per / quoted /
//      according to (particles skipped), or right before a speech verb ("Hale told", "HALE said");
//  (d) any letter of a script without capital letters (Han, kana, Hangul, Arabic, Devanagari, Thai, ...): shape cannot be judged.
// Only a run made entirely of safe words passes ("Business Associate", "Privacy Rule", "Series J."). Trade-off, on purpose:
// a product name next to an unknown word ("Ixterlane Credit Monitoring") is now dropped too.
const PARTICLES = new Set('von van de del della der den di da du dos das al el bin ibn bint le la ter ten zu af'.split(' '));
const PARTICLE_JOINED = /^(von|van|de|del|der|di|da|du|al|el|bin|ibn|bint|le|la|d|o)[-\u2010\u2011'\u2019]\p{Lu}/u;
// acronyms that are not names (ALL-CAPS words are otherwise treated as possible names: "MORGAN HALE")
const ACRONYMS = new Set(('hipaa hitrust hitech soc iso nist pci dss gdpr ccpa cpra phi pii ehr emr sec hhs ocr fda cms onc ftc doj fbi cisa eu uk us usa ' +
  'ipo saas paas iaas baa sso mfa iam api sdk llm ai ml it hr usd eur gbp q1 q2 q3 q4 fy aws gcp b2b b2c kpi roi esg').split(' '));
const CUE_BEFORE = new Set('said says told tells by led from named per quoted quoting'.split(' '));
const CUE_AFTER = new Set(('said says told tells stated states noted notes added adds explained explains wrote writes confirmed confirms argued argues ' +
  'claimed claims warned warns testified recalled commented admitted acknowledged emphasized emphasised believes believed thinks thought ' +
  'recommended posted tweeted spoke speaks presented presents').split(' '));
/** a letter in a script that has no upper / lower case (Lo): a name there has no shape to check */
const UNCASED = /\p{Lo}/u;
const capitalised = (w: string) => /^\p{Lu}/u.test(w) || PARTICLE_JOINED.test(w);
const isInitialTok = (w: string) => /^\p{Lu}$/u.test(w);

const SPLIT = /[\s,;:()"\u201c\u201d\u2014\u2013]+/;
const trimTok = (w: string) => w.replace(/[.!?]+$/u, '').replace(/['\u2019]s$/u, '').replace(/^['\u2018\u2019]+|['\u2018\u2019]+$/gu, '').replace(/[.!?]+$/u, '');
const tokenize = (text: string) => text.normalize('NFC').split(SPLIT).map(trimTok);

/** true when the claim may carry a person's name (see the rules above). Fail-closed: unsure = true.
 *  `brands` = the research allowlist (brandAllowlist below): those tokens count as safe inside a capitalised run, exactly like
 *  COMMON words, but NOT for the cue rule (c): "TIME said" or "according to DeepIntent" still blocks, as does every other net. */
export function looksLikePersonName(text: string, companyWords: Set<string> = new Set(), brands: Set<string> = new Set()): boolean {
  if (HONORIFIC.test(text)) return true;
  if (UNCASED.test(text.normalize('NFC'))) return true;
  const toks = tokenize(text);
  const safeCore = (w: string) => { const f = fold(w); return COMMON.has(f) || companyWords.has(f) || ACRONYMS.has(f); };
  const safe = (w: string) => safeCore(w) || brands.has(fold(w));
  const unknownCap = (w: string) => !!w && capitalised(w) && !isInitialTok(w) && !safe(w);
  const cueCap = (w: string) => !!w && capitalised(w) && !isInitialTok(w) && !safeCore(w);   // the cue rule ignores the allowlist
  // (a) + (b): runs of capitalised tokens; particles may sit inside a run
  let size = 0, unknown = false;
  const close = () => { const hit = size >= 2 && unknown; size = 0; unknown = false; return hit; };
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i];
    if (w && PARTICLE_JOINED.test(w)) return true;
    if (w && capitalised(w)) { size++; if (unknownCap(w)) unknown = true; continue; }
    if (w && PARTICLES.has(w) && size > 0 && toks[i + 1] && capitalised(toks[i + 1])) continue;   // "Ludwig van Beethoven"
    if (w && PARTICLES.has(w) && size === 0 && toks[i + 1] && unknownCap(toks[i + 1])) { size = 1; continue; } // "de Souza"
    if (close()) return true;
  }
  if (close()) return true;
  // (c): a lone unknown capitalised token next to a speech / agency cue
  const low = toks.map((w) => fold(w));
  for (let i = 0; i < toks.length; i++) {
    if (!cueCap(toks[i])) continue;
    let j = i - 1; while (j >= 0 && PARTICLES.has(low[j])) j--;
    if (j >= 0 && (CUE_BEFORE.has(low[j]) || (low[j] === 'to' && low[j - 1] === 'according'))) return true;
    if (i + 1 < toks.length && CUE_AFTER.has(low[i + 1])) return true;
  }
  return false;
}
// ---- research brand allowlist (Owner, Oct 29 2026, staging finding 1) ----
// The fail-closed net above dropped every normal claim on the staging run ("TIME's 2026 ... list", "ProviderConnect Audiences in
// the DeepIntent Audience Marketplace"), so Parallel checked nothing. A token may now pass the run rule (a) when the account's
// OWN public research shows it as a brand, product, company or publication, by one of these shapes in a research text:
//  B1 CamelCase brand shape ("ProviderConnect", "DeepIntent", "HealthTech"), not a name prefix (Mc / Mac / De / La / O ...);
//  B2 inside a capitalised run that ends with, or is followed by, a product / organisation / publication noun
//     ("DeepIntent Audience Marketplace", "CRM environment", "World's Top HealthTech Companies list");
//  B3 an ALL-CAPS word (2 to 6 letters) whose possessive is followed within 6 words by a publication or list noun ("TIME's 2026 ... list");
//  B4 a label of a research source's host name ("example" for https://www.example.com/...).
// A token is NEVER allowlisted (veto) when the research also uses its capitalised run like a person: right after a speech /
// agency cue (said, told, by, led, from, named, per, according to ...), an honorific, "lists", "hired" or "appointed"; right
// before a speech verb, a personal pronoun or "who"; holding or followed by a role word ("CISO X", "X as CISO"); or when it is
// part of the contact's or any known person's name. Research is read sentence by sentence. Unsure = not on the list = the
// claim fails closed.
const NAME_PREFIX = /^(mc|mac|de|di|da|du|la|le|van|von|o|d|fitz|st|al|el|ben|bin|abu|del|della|ter|ten)$/;
const CAMEL = /^\p{Lu}\p{Ll}+(?:\p{Lu}\p{Ll}*)+$/u;
/** "McAllister", "DeVries", "MacLeod", "O'Brien": a name shape, never allowlisted by any rule */
const namePrefixed = (w: string) => { const m = w.match(/^(\p{Lu}\p{Ll}*)['\u2019]?\p{Lu}/u); return !!m && NAME_PREFIX.test(fold(m[1])); };
const ORG_NOUN = new Set(('marketplace marketplaces platform platforms environment environments instance integration integrations app apps ' +
  'cloud suite api crm software tool tools magazine list lists ranking rankings index award awards network networks store portal ' +
  'product products service audience audiences inc corp corporation llc ltd plc group labs technologies systems media journal ' +
  'newswire wire exchange database dashboard system solution solutions program partnership partners companies company').split(' '));
const PUB_NOUN = new Set('list lists ranking rankings index award awards magazine report edition issue survey'.split(' '));
const VETO_BEFORE = new Set([...CUE_BEFORE, 'mr', 'mrs', 'ms', 'mx', 'dr', 'prof', 'sir', 'dame', 'lists', 'listed', 'hired', 'hires', 'appointed', 'appoints', 'promoted']);
const PERSON_AFTER = new Set(['he', 'she', 'his', 'her', 'him', 'hers', 'who', 'whose']);
const ROLE_TOKEN = /^(ceo|cfo|cto|cio|ciso|coo|cpo|cmo|cro|cso|cdo|chief|officer|counsel|president|vp|svp|evp|founder|cofounder|co-founder|chair|chairman|chairwoman|director|head|executive|spokesperson|spokesman|spokeswoman|manager|lead|engineer|analyst|partner)$/;

/** Brand / product / company / publication tokens the research itself shows, as folded words. Pure; see the rules above. */
export function brandAllowlist(research: { fact?: string; source_url?: string }[], people: string[] = []): Set<string> {
  const ok = new Set<string>(), veto = new Set<string>();
  for (const n of people) for (const w of tokenize(n)) if (w) { veto.add(fold(w)); for (const piece of w.split(/[-'\u2019.]+/)) if (piece) veto.add(fold(piece)); }
  for (const r of research ?? []) for (const text of String(r?.fact ?? '').split(/(?<=[.!?])\s+/)) {
    const raw = text.normalize('NFC').split(SPLIT);
    const toks = raw.map(trimTok);
    const low = toks.map((w) => fold(w));
    const possessive = raw.map((w) => /['\u2019]s[.!?]*$/u.test(w));
    // veto: a capitalised run used like a person: right after a person cue (particles skipped) or "according to", right before a
    // speech verb, holding a role word ("CISO Morgan Pryce"), or followed by "as <role>" / a role word
    const isRole = (k: number) => k >= 0 && k < toks.length && ROLE_TOKEN.test(low[k]);
    for (let i = 0; i < toks.length;) {
      if (!toks[i] || !capitalised(toks[i])) { i++; continue; }
      let j = i; while (j < toks.length && toks[j] && capitalised(toks[j])) j++;
      let b = i - 1; while (b >= 0 && PARTICLES.has(low[b])) b--;
      const before = b >= 0 && (VETO_BEFORE.has(low[b]) || (low[b] === 'to' && low[b - 1] === 'according'));
      const after = j < toks.length && (CUE_AFTER.has(low[j]) || PERSON_AFTER.has(low[j]) || isRole(j) || (low[j] === 'as' && (isRole(j + 1) || isRole(j + 2))));
      let roleIn = false; for (let k = i; k < j; k++) if (isRole(k)) roleIn = true;
      if (before || after || roleIn) for (let k = i; k < j; k++) if (!isRole(k)) veto.add(low[k]);
      i = j;
    }
    // B1 CamelCase
    for (const w of toks) if (CAMEL.test(w) && !namePrefixed(w)) ok.add(fold(w));
    // B2 capitalised runs that end with / are followed by an organisation noun
    for (let i = 0; i < toks.length;) {
      if (!toks[i] || !capitalised(toks[i]) || isInitialTok(toks[i])) { i++; continue; }
      let j = i; while (j < toks.length && toks[j] && capitalised(toks[j]) && !isInitialTok(toks[j])) j++;
      const lastNoun = ORG_NOUN.has(low[j - 1]), nextNoun = j < toks.length && ORG_NOUN.has(low[j]);
      if (lastNoun || nextNoun) for (let k = i; k < j; k++) if (!namePrefixed(toks[k])) ok.add(low[k]);
      i = j;
    }
    // B3 ALL-CAPS possessive + a publication / list noun within 6 words
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i];
      if (!possessive[i] || !/^\p{Lu}{2,6}$/u.test(w)) continue;
      if (low.slice(i + 1, i + 7).some((x) => PUB_NOUN.has(x))) ok.add(fold(w));
    }
  }
  for (const r of research ?? []) {
    // B4 host-name labels of the source
    try {
      const h = new URL(String(r?.source_url ?? '')).hostname.toLowerCase().replace(/^www\./, '');
      for (const lab of h.split('.').slice(0, -1)) if (lab.length >= 3) ok.add(lab);
    } catch { /* no url */ }
  }
  for (const v of veto) ok.delete(v);
  for (const c of [...ok]) if (COMMON.has(c) || PARTICLES.has(c)) ok.delete(c);           // already safe; never widen a particle
  return ok;
}
// claims about a company say "it" / "its"; a personal pronoun means the claim is about a person
const PRONOUN = /(?<![\p{L}\p{N}])(he|she|him|his|her|hers|himself|herself)(?![\p{L}\p{N}])/iu;
export type PersonHit = 'contact' | 'known person' | 'person role' | 'person name' | 'person pronoun';
/** Why a claim is about a person, or null when it is company-level. */
export function personHit(claim: string, contact: { parts: string[]; spaceless: string }, others: { parts: string[]; spaceless: string }[],
  companyWords: Set<string>, brands: Set<string> = new Set()): PersonHit | null {
  if (mentionsName(claim, contact)) return 'contact';
  if (others.some((np) => mentionsName(claim, np))) return 'known person';
  if (ROLE.test(claim)) return 'person role';
  if (looksLikePersonName(claim, companyWords, brands)) return 'person name';
  if (PRONOUN.test(claim)) return 'person pronoun';
  return null;
}
const wordsOf = (s: string) => new Set(s.split(/[^\p{L}\p{N}]+/u).filter(Boolean).map(fold));

/** Pick the claims that MAY be sent. Pure; every item gets a logged decision. */
export function selectClaims(f: FactInput): { eligible: { claim: string; source: string }[]; decisions: Decision[]; allowlist: string[] } {
  const decisions: Decision[] = [], eligible: { claim: string; source: string }[] = [];
  const np = nameParts(f.contact.name ?? '');
  const others = (f.people ?? []).filter((n) => typeof n === 'string' && n.trim()).map(nameParts);
  const companyWords = new Set([...wordsOf(f.company ?? ''), ...wordsOf((f.domain ?? '').replace(/\.[a-z]+$/i, ''))]);
  const brands = brandAllowlist(f.research ?? [], [f.contact.name ?? '', ...(f.people ?? [])].filter((n) => typeof n === 'string'));
  const title = (f.contact.title ?? '').trim();
  const seller = f.seller ?? 'Thrandvex';
  const reason = (c: string, src: string): string | null => {
    const low = fold(c);
    if (!c) return 'empty';
    if (!/^https:\/\//i.test(src)) return 'blocked: not from public web research (record field or no url)';
    if (np.unfoldable) return 'blocked: contact name cannot be matched safely';
    if (others.some((o) => o.unfoldable)) return 'blocked: a known person name cannot be matched safely';
    if (mentionsName(c, np)) return 'blocked: mentions the contact';
    if (title && forms(c).some((t) => forms(title).some((x) => t.includes(x)))) return 'blocked: mentions the contact title';
    if (mentions(c, seller)) return 'blocked: seller pitch';
    if (/(?<![\p{L}\p{N}])(ae|account executive|deal|opportunity|pipeline|meeting with us|our call)(?![\p{L}\p{N}])/u.test(low)) return 'blocked: sales or CRM data';
    // a CRM vendor word blocks unless the account's public research names it as a vendor / product (brand allowlist), e.g. a
    // breach "in its CRM environment": then it is a public company fact, not Owner's CRM record
    const crm = low.match(/(?<![\p{L}\p{N}])(crm|crm)(?![\p{L}\p{N}])/gu) ?? [];
    if (crm.some((w) => !brands.has(w))) return 'blocked: sales or CRM data';
    const h = personHit(c, np, others, companyWords, brands);
    if (h) return `blocked: names a person (${h})`;
    if (c.length > 400) return 'blocked: too long to be one claim';
    if (eligible.length >= MAX_CLAIMS) return 'skipped: claim cap';
    return null;
  };
  for (const sf of f.source_facts ?? []) {
    const c = String(sf.fact ?? '').trim(), src = String(sf.source ?? '');
    const why = reason(c, src);
    decisions.push({ item: c.slice(0, 160), decision: why ?? 'eligible: public company-level claim' });
    if (!why) eligible.push({ claim: c, source: src });
  }
  return { eligible, decisions, allowlist: [...brands].sort() };
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
  const { eligible, decisions, allowlist } = selectClaims(f);
  if (!domain) return { status: 'skipped', reason: 'no valid company domain', decisions, allowlist, payloads: [], verdicts: [], calls: 0 };
  if (!eligible.length) return { status: 'done', reason: 'no eligible public company claims', decisions, allowlist, payloads: [], verdicts: [], calls: 0 };
  const claims: Claim[] = await Promise.all(eligible.map(async (e) => ({ ...e, hash: await claimHash(e.claim) })));
  const cached = await d.cacheGet(domain, claims.map((c) => c.hash));
  const todo = claims.filter((c) => !cached[c.hash]);
  if (todo.length && !d.key && !d.post) return { status: 'blocked', reason: 'PARALLEL_API_KEY not configured', decisions, allowlist, payloads: [], verdicts: [], calls: 0 };
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
  return { status: unchecked ? 'unchecked' : 'done', decisions, allowlist, payloads, verdicts, calls: todo.length, flagged, unchecked, errors, ms: Date.now() - t0 };
}
