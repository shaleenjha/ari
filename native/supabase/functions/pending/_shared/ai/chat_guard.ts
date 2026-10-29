// Live Ask Kyte (PENDING, Oct 30 2026). Guardrails, pure and offline-tested (chat_test.ts):
//  1. askGuard(): questions about how the app is built / run / hosted / changed, prompt or key fishing and jailbreak set-ups are
//     answered with exactly HANDLED before any model call ($0). Runs on the raw text and on a de-obfuscated copy (zero-width
//     characters, spaced or dotted letters, leetspeak, base64 blobs).
//  2. cleanAnswer(): every streamed prefix and the final answer pass through it: tags, markdown, links and URLs stripped; ISO dates
//     to "Oct 30"; email addresses and phone numbers removed; the exec-track names replaced; infrastructure words or a leaked
//     piece of the instructions trip the whole answer to HANDLED; a claim that Kyte changed or sent something trips it to
//     NO_CHANGE; dashes become commas; the final answer is capped at 4 sentences.
//  3. ChatStream: releases text to the app only at word boundaries once the cleaned prefix is stable, so a partial phone number,
//     tag or URL never goes out; the final cleaned text is authoritative (the app replaces the bubble when it differs).
//  4. findEntities(): offsets of the people and account names in the final answer, so the app can link them.

export const HANDLED = "That's handled in Hark, not here.";
export const NO_CHANGE = "I can't change anything or send anything from chat. Make the change on the person's or account's page, and you send every message yourself on LinkedIn.";
export const MAX_CHAT = 1500;

const ZW = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF\u00AD]/g;

const YOU = String.raw`(?:you|your|you're|kyte'?s?|ari'?s?|kelvarrow'?s?|this app'?s?|the app'?s?|this thing'?s?)`;
const ASK: RegExp[] = [
  // vendors, stack, code hosting
  /\b(supabase|postgres(ql)?|pgmq|pg_net|sql|nosql|vercel|github|gitlab|repo(sitory)?|edge ?functions?|cron(job| job|tab)?|deno|anthropic|openai|claude|chat ?gpt|gpt[- ]?\d*(\.\d)?[a-z]?|grok|xai|llms?|gemini|mistral|llama|sonnet|opus)\b/i,
  // prompt / instruction fishing
  /\b(system|developer|hidden|initial|original|worker|your)\s+(prompts?|instructions|guidelines|rules|config(uration)?)\b/i,
  /\b(system ?prompt|prompt injection|jailbreak|developer mode|dan mode|god mode|debug mode|admin mode|sudo)\b/i,
  // keys and passwords
  /\b((api|secret|service[ _-]?role|private|anon|publishable|signing)[ _-]?keys?|access tokens?|bearer tokens?|jwts?|env(ironment)? var(iable)?s?|\.env)\b/i,
  new RegExp(String.raw`\b(${YOU}|admin|database|db|postgres|root|service|master|server)\s+(passwords?|passwd|credentials?|logins?)\b|\bpasswords?\s+(for|to)\s+(the\s+)?(app|database|db|server|admin|${YOU})\b`, 'i'),
  // how it is built / stored / hosted / run
  new RegExp(String.raw`\b${YOU}\s+(databases?|db|schemas?|tables?|columns?|back[ -]?end|servers?|hosting|host|infrastructure|infra|tech ?stack|stack|source ?code|code ?base|codebase|code|architecture|vendors?|providers?|models?|keys?|secrets?)\b`, 'i'),
  /\b(what|which)\s+(vendors?|providers?|tools|services|platforms?|ai|cloud)\s+(do|does|are|is)\s+(you|kyte|kelvarrow|ari|it|this app)\s+(use|using|run|running|built|on)\b/i,
  /\b(what|which)\s+(databases?|db|tables?|schemas?|columns?|back[ -]?end|servers?|tech ?stack|stack|cloud|hosting)\b/i,
  /\b(stored?|stores|kept|keep|saved?|lives?)\b.{0,40}\b(databases?|tables?|db|servers?|schemas?)\b|\b(databases?|tables?|db|servers?|schemas?)\b.{0,40}\b(stores?|stored|keeps?|holds?)\b/i,
  new RegExp(String.raw`\bhost(s|ed)?\s+${YOU}\b|\bwho\s+hosts\b|\bwhere\s+(are|is)\s+${YOU}\s+(hosted|running|deployed|stored)\b|\b(deploy(ed|s|ment)?|hosted|running)\s+(on|in|at)\b.{0,20}\b${YOU}\b|\b${YOU}\s+(deploy(ed|s|ment)?)\b`, 'i'),
  new RegExp(String.raw`\b(what|which)\s+(ai\s+|language\s+|llm\s+|large language\s+)?models?\s+(do|are|is|does|did|writes?|wrote|powers?|runs?|drafts?|generates?)\s+(you|kyte|ari|kelvarrow|this|the app|my drafts|my messages|it)\b|\bmodels?\s+(do you|are you|writes?|powers?|behind|runs? (you|kyte))\b`, 'i'),
  new RegExp(String.raw`\b(are|were|is|was)\s+${YOU}\s+(built|made|powered|trained|coded|written)\s+(with|on|by|using|in)\b|\bhow\s+(are|were|is|was|do|does)\s+${YOU}\s+(built|made|run|hosted|coded|work(ing)?\s+under|deployed|trained|powered|engineered|set up)\b`, 'i'),
  /\b(scheduled tasks?|background (jobs?|runs?|tasks?)|the worker|your worker|hark tasks?|job queue|queue table|ai_calls|ai_budget|service_role|ari_worker|cron schedule)\b/i,
  // asks to change the app itself
  /\b(change|redesign|fix|tweak|update|edit|modify|rename|recolou?r|restyle|rebuild|reprogram)\s+(the\s+|this\s+|your\s+|a\s+)?(app|ui|design|screen|layout|buttons?|tabs?|icons?|colou?rs?|fonts?|features?|code|settings page|menu)\b/i,
  /\b(rename|recolou?r|restyle|redesign|reorder)\s+(the\s+|my\s+)?[\w' ]{0,20}\b(tabs?|buttons?|screens?|icons?|menus?|pages?|cards?|headers?)\b/i,
  /\b(feature requests?|add (a |the |new )?features?|new features?|bugs? in (the |this )?app|app changes?|app fix(es)?|change the app|make the app)\b/i,
  // jailbreak set-ups
  /\b(ignore|disregard|forget|override|bypass|drop|skip)\s+(all\s+|any\s+|your\s+|the\s+|previous\s+|prior\s+|above\s+|earlier\s+|these\s+|those\s+|of\s+)*(rules|instructions|guardrails|guidelines|prompts?|system|restrictions|filters?|policies|programming)\b/i,
  /\bpretend\s+(you\s+are|you're|to\s+be)\s+(the\s+|a\s+|an\s+)?(developer|dev|admin|administrator|engineer|system|root|owner of the app|unrestricted|different ai|evil)\b|\bact as (the |a |an )?(developer|admin|unrestricted|system|root)\b|\brole-?play\b.{0,60}\b(developer|admin|no rules|unrestricted)\b/i,
  /\b(i am|i'm|this is)\s+(the\s+|your\s+)?(developer|admin|administrator|engineer|hark|anthropic|owner of (this|the) app|system)\b/i,
  // other languages (Hindi, Spanish, Italian, Portuguese, German, French)
  /(डेटाबेस|डाटाबेस|सर्वर|प्रॉम्प्ट|प्रोम्प्ट|पासवर्ड|टेबल्स|कोड बेस|base de datos|base di dati|banco de dados|datenbank|mot de passe|contraseña|passwort|senha|chiave api|clave api|clé api|instrucciones del sistema|istruzioni di sistema|prompt di sistema|prompt del sistema|systemprompt|system-prompt)/i,
];

const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's', '|': 'l' };
/** A copy with tricks undone: zero-width chars, s.u.p.a.b.a.s.e / s u p a b a s e, leetspeak inside words, base64 blobs. */
export function deobfuscate(t: string): string {
  let s = t.normalize('NFKC').replace(ZW, '');
  s = s.replace(/\b(?:[A-Za-z][\s._*-]){3,}[A-Za-z]\b/g, (m) => m.replace(/[\s._*-]/g, ''));
  s = s.replace(/\S*[A-Za-z]\S*/g, (w) => /[A-Za-z]/.test(w) && /[0-9@$|]/.test(w) ? w.replace(/[013457@$|]/g, (c) => LEET[c] ?? c) : w);
  const extra: string[] = [];
  for (const b of t.match(/[A-Za-z0-9+/]{20,}={0,2}/g) ?? []) {
    try { const d = atob(b.length % 4 ? b + '='.repeat(4 - (b.length % 4)) : b); if (/^[\x20-\x7E\s]+$/.test(d)) extra.push(d); } catch { /* not base64 */ }
  }
  return [s, ...extra].join('\n');
}

/** true = answer with exactly HANDLED and do not call the model. */
export function askGuard(text: string): boolean {
  const t = String(text ?? '').slice(0, 4 * MAX_CHAT);
  const d = deobfuscate(t);
  return ASK.some((r) => r.test(t) || r.test(d));
}

// ---------------- answers ----------------
// whole answer becomes HANDLED: a vendor, a stack word, a leaked piece of the instructions
const HARD_OUT = /\b(supabase|postgres(ql)?|pgmq|pg_net|sql|edge ?functions?|cron|anthropic|claude|openai|chat ?gpt|gpt[-\w.]*|grok|xai|llms?|sonnet|opus|haiku|gemini|api ?keys?|service[ _-]?role|vercel|github|repo(sitory)?|databases?|system ?prompt|sheet id|deno|1QEiIa|how_kyte_works|snapshot_json|rpc|row level security)\b|<\/?(snapshot|rules|how_kyte_works)>|\bKC-RULESET\b/i;
// first-person claims of an action Kyte cannot take
const ACTION_CLAIM = /\b(i(?:'ve| have| just| already)?|done[,.!]?\s*i(?:'ve)?)\s+(?:just\s+|already\s+|now\s+)?(sent|emailed|messaged|dm'?d|texted|deleted|removed|marked|updated|changed|moved|added|scheduled|booked|archived|cleared|edited|saved|queued|submitted|posted|withdrew|withdrawn|accepted|unsubscribed|snoozed)\b|\b(i'll|i will|let me|i can)\s+(send|email|message|delete|remove|mark|update|change|move|add|schedule|book|archive|clear|edit|post|withdraw)\b(?!\s+(?:you|that)\s+(?:on|in)\b)/i;
const SOFT: [RegExp, string][] = [
  [/\bschedul(e|es) (a|an|the|time|call|meeting|it)\b/gi, 'book $2'], [/\bscheduled\b/gi, 'set'], [/\bscheduling\b/gi, 'booking'],
  [/\bschedules\b/gi, 'timings'], [/\bschedule\b/gi, 'timing'], [/\btables\b/gi, 'lists'], [/\btable\b/gi, 'list'],
  [/\bprompted\b/gi, 'led'], [/\bprompts\b/gi, 'nudges'], [/\bprompt\b/gi, 'nudge'], [/\bworkers\b/gi, 'Kyte'], [/\bworker\b/gi, 'Kyte'],
  [/\bagents\b/gi, 'assistants'], [/\bagent\b/gi, 'assistant'], [/\btokens\b/gi, 'words'], [/\btoken\b/gi, 'word'],
  [/\bsecrets\b/gi, 'private details'], [/\bsecret\b/gi, 'private'], [/\bservers\b/gi, 'systems'], [/\bserver\b/gi, 'system'],
  [/\bback[ -]?end\b/gi, 'systems'],
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
export const PHONE = /\+?\d[\d ().-]{8,}\d/g;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface CleanOpts { deny?: string[]; final?: boolean; maxSentences?: number }
export interface Clean { text: string; tripped: null | 'handled' | 'no_change' }

/** Shared by the snapshot sanitizer and the answer filter: tags, URLs, contact data, exec names. */
export function scrub(s: string, deny: string[] = []): string {
  let t = String(s ?? '').replace(ZW, '');
  t = t.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ').replace(/<\/?[A-Za-z][^<>]{0,300}>/g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  t = t.replace(/\b(javascript|data|vbscript):\S*/gi, ' ');
  t = t.replace(/\[([^\]]{1,120})\]\((?:[^()\s]+)\)/g, '$1');
  t = t.replace(/\bhttps?:\/\/\S+|\bwww\.\S+/gi, ' ');
  t = t.replace(/\b(20\d\d)-(\d\d)-(\d\d)(?:[T ][\d:.+Z-]+)?\b/g, (_m, _y, mo, d) => `${MONTHS[Number(mo) - 1] ?? mo} ${Number(d)}`);
  t = t.replace(EMAIL, '(not shared here)').replace(PHONE, '(not shared here)');
  for (const n of deny) if (n && n.length >= 3) t = t.replace(new RegExp(`\\b${esc(n)}('s)?\\b`, 'gi'), (_m, s2) => `the exec track${s2 ?? ''}`);
  t = t.replace(/the exec track('s)?\s+(via|and|or|,)\s+the exec track('s)?/gi, 'the exec track$3');
  return t;
}

export function cleanAnswer(raw: string, o: CleanOpts = {}): Clean {
  if (HARD_OUT.test(raw)) return { text: HANDLED, tripped: 'handled' };
  let t = scrub(raw, o.deny ?? []);
  t = t.replace(/\*\*|__|`+|^#{1,6}\s+|^\s*[-*•]\s+/gm, '');
  t = t.replace(/\s+[\u2013\u2014]\s+|[\u2013\u2014]/g, ', ').replace(/\s+-\s+/g, ', ');
  if (HARD_OUT.test(t) || HARD_OUT.test(deobfuscate(t))) return { text: HANDLED, tripped: 'handled' };
  if (ACTION_CLAIM.test(t)) return { text: NO_CHANGE, tripped: 'no_change' };
  for (const [r, w] of SOFT) t = t.replace(r, w);
  if (o.final) {
    t = t.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/,\s*,/g, ',').trim();
    const max = o.maxSentences ?? 4;
    const parts = t.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g) ?? [t];
    if (parts.length > max) t = parts.slice(0, max).join('').trim();
    if (!t) t = "I don't have that here.";
  }
  return { text: t, tripped: null };
}

/** Streams only stable, cleaned text: word boundaries, never inside a possible number, tag, URL or address. */
export class ChatStream {
  raw = ''; sent = ''; tripped: Clean['tripped'] = null; diverged = false;
  constructor(private deny: string[] = []) {}
  push(delta: string): string {
    this.raw += delta;
    if (this.tripped || this.diverged) return '';
    const cut = this.raw.search(/\s\S*$/);              // last whitespace: never release half a word
    if (cut <= 0) return '';
    let seg = this.raw.slice(0, cut);
    const num = seg.match(/[+(]?\d[\d\s().+-]*$/);       // a number still being written (maybe a phone): hold it whole
    if (num) seg = seg.slice(0, num.index);
    const lt = seg.lastIndexOf('<');
    if (lt >= 0 && seg.indexOf('>', lt) < 0) seg = seg.slice(0, lt);   // an open tag
    const tok = (seg.match(/\S*$/) ?? [''])[0];
    if (/[@:]|^www\./i.test(tok)) seg = seg.slice(0, seg.length - tok.length);   // a possible address or link
    if (seg.trim().length <= this.sent.length) return '';
    const c = cleanAnswer(seg, { deny: this.deny });
    if (c.tripped) { this.tripped = c.tripped; return ''; }
    const text = c.text.replace(/\s+$/, '');
    if (!text.startsWith(this.sent)) { this.diverged = true; return ''; }
    const out = text.slice(this.sent.length);
    this.sent = text;
    return out;
  }
  /** final answer + whether the app must replace what it already showed */
  end(): { text: string; tripped: Clean['tripped']; replace: boolean; tail: string } {
    const c = cleanAnswer(this.raw, { deny: this.deny, final: true });
    const tripped = this.tripped ?? c.tripped;
    const text = this.tripped === 'handled' ? HANDLED : this.tripped === 'no_change' ? NO_CHANGE : c.text;
    const prefix = this.sent.trim();
    if (!prefix) return { text, tripped, replace: false, tail: text };
    if (text.startsWith(prefix)) return { text, tripped, replace: false, tail: text.slice(this.sent.length) };
    return { text, tripped, replace: true, tail: '' };
  }
}

export interface Entity { kind: 'person' | 'account'; id: string; name: string }
export interface EntitySpan extends Entity { start: number; end: number }
/** Names in the answer that match the snapshot's people / accounts (longest first, whole words, no overlaps). */
export function findEntities(text: string, ents: Entity[]): EntitySpan[] {
  const list = ents.filter((e) => e && typeof e.name === 'string' && e.name.trim().length >= 3).sort((a, b) => b.name.length - a.name.length);
  const taken: boolean[] = []; const out: EntitySpan[] = [];
  for (const e of list.slice(0, 2000)) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${esc(e.name.trim())})(?=$|[^\\p{L}\\p{N}])`, 'giu');
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index + m[1].length, end = start + m[2].length;
      let free = true; for (let i = start; i < end; i++) if (taken[i]) { free = false; break; }
      if (!free) continue;
      for (let i = start; i < end; i++) taken[i] = true;
      out.push({ kind: e.kind, id: e.id, name: e.name.trim(), start, end });
      if (out.length >= 12) break;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}
