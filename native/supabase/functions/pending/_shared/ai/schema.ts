// Live AI layer (PENDING, not deployed). Tiny zod-style validator: no npm dependency, so the offline tests and the edge
// bundle need nothing fetched. s.object({...}).parse(x) -> { ok: true, value } | { ok: false, error }.
// Unknown keys are dropped (strip), strings are trimmed and length-capped, numbers range-checked.

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };
export interface Schema<T> { parse(x: unknown, path?: string): Result<T>; optional(): Schema<T | undefined> }

function mk<T>(fn: (x: unknown, path: string) => Result<T>): Schema<T> {
  const self: Schema<T> = {
    parse: (x, path = '$') => fn(x, path),
    optional: () => mk<T | undefined>((x, p) => (x === undefined || x === null ? { ok: true, value: undefined } : fn(x, p))),
  };
  return self;
}
const fail = (path: string, msg: string) => ({ ok: false as const, error: `${path}: ${msg}` });

export const s = {
  string: (o: { min?: number; max?: number } = {}) => mk<string>((x, p) => {
    if (typeof x !== 'string') return fail(p, 'expected string');
    const v = x.trim();
    if (o.min !== undefined && v.length < o.min) return fail(p, `shorter than ${o.min}`);
    if (o.max !== undefined && v.length > o.max) return fail(p, `longer than ${o.max}`);
    return { ok: true, value: v };
  }),
  number: (o: { min?: number; max?: number } = {}) => mk<number>((x, p) => {
    if (typeof x !== 'number' || !Number.isFinite(x)) return fail(p, 'expected number');
    if (o.min !== undefined && x < o.min) return fail(p, `below ${o.min}`);
    if (o.max !== undefined && x > o.max) return fail(p, `above ${o.max}`);
    return { ok: true, value: x };
  }),
  boolean: () => mk<boolean>((x, p) => (typeof x === 'boolean' ? { ok: true, value: x } : fail(p, 'expected boolean'))),
  enum: <E extends string>(vals: readonly E[]) => mk<E>((x, p) =>
    (typeof x === 'string' && (vals as readonly string[]).includes(x) ? { ok: true, value: x as E } : fail(p, `expected one of ${vals.join('|')}`))),
  array: <T>(item: Schema<T>, o: { min?: number; max?: number } = {}) => mk<T[]>((x, p) => {
    if (!Array.isArray(x)) return fail(p, 'expected array');
    if (o.min !== undefined && x.length < o.min) return fail(p, `fewer than ${o.min} items`);
    if (o.max !== undefined && x.length > o.max) return fail(p, `more than ${o.max} items`);
    const out: T[] = [];
    for (let i = 0; i < x.length; i++) { const r = item.parse(x[i], `${p}[${i}]`); if (!r.ok) return r; out.push(r.value); }
    return { ok: true, value: out };
  }),
  // deno-lint-ignore no-explicit-any
  object: <S extends Record<string, Schema<any>>>(shape: S) => mk<{ [K in keyof S]: S[K] extends Schema<infer U> ? U : never }>((x, p) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return fail(p, 'expected object');
    // deno-lint-ignore no-explicit-any
    const out: any = {};
    for (const k of Object.keys(shape)) {
      const r = shape[k].parse((x as Record<string, unknown>)[k], `${p}.${k}`);
      if (!r.ok) return r;
      if (r.value !== undefined) out[k] = r.value;
    }
    return { ok: true, value: out };
  }),
};

export type Infer<S> = S extends Schema<infer T> ? T : never;

// ---------- output contracts ----------
const fact = s.object({ fact: s.string({ min: 1, max: 400 }), source: s.string({ max: 500 }).optional() });

/** draft / rewrite / draft_dm1: {text, rationale, source_facts[], confidence, needs_review} */
export const DraftOut = s.object({
  text: s.string({ min: 1, max: 1900 }),          // LinkedIn DM limit is far above this; drafts stay short
  rationale: s.string({ min: 1, max: 600 }),
  source_facts: s.array(fact, { max: 8 }),
  confidence: s.number({ min: 0, max: 1 }),
  needs_review: s.boolean(),
});

/** classify (accept confirm + person match) */
export const ClassifyOut = s.object({
  is_accept: s.boolean(),
  person_id: s.string({ max: 40 }).optional(),
  confidence: s.number({ min: 0, max: 1 }),
  reason: s.string({ max: 300 }),
});

/** triage_reply step 1 (Haiku, classify only): intent + urgency */
export const TriageClassOut = s.object({
  intent: s.enum(['interested', 'meeting', 'question', 'referral', 'not_now', 'not_interested', 'unsubscribe', 'other'] as const),
  urgency: s.enum(['high', 'normal', 'low'] as const),
  summary: s.string({ min: 1, max: 300 }),
  needs_review: s.boolean(),
});
/** triage_reply step 2 (Opus, drafting): same contract as the worker's reply drafts (0018 ari_worker_reply_drafts):
 *  exactly book, answer, soft; body <= 300 chars */
export const ReplyDraftsOut = s.object({
  drafts: s.array(s.object({ key: s.enum(['book', 'answer', 'soft'] as const), label: s.string({ min: 1, max: 60 }),
    body: s.string({ min: 1, max: 300 }) }), { min: 3, max: 3 }),
  needs_review: s.boolean(),
});
/** match_profile (Haiku, classify only): which candidate is the CSV row's person. pick = candidate index or -1 for none */
export const MatchOut = s.object({
  pick: s.number({ min: -1, max: 9 }),
  runner_up: s.number({ min: -1, max: 9 }).optional(),
  confidence: s.number({ min: 0, max: 1 }),
  reason: s.string({ max: 200 }),
});
/** Grok signal search result (one search) */
export const SearchOut = s.object({
  results: s.array(s.object({ title: s.string({ max: 300 }).optional(), url: s.string({ min: 8, max: 500 }),
    snippet: s.string({ max: 600 }).optional(), published: s.string({ max: 30 }).optional() }), { max: 10 }),
});
export function triageKeysOk(d: { key: string }[]): boolean {
  return d.map((x) => x.key).sort().join(',') === 'answer,book,soft';
}

/** quick_research / deep_research findings */
export const ResearchOut = s.object({
  summary: s.string({ min: 1, max: 1500 }),
  findings: s.array(s.object({
    fact: s.string({ min: 1, max: 500 }),
    source_url: s.string({ min: 8, max: 500 }),
    dated: s.string({ max: 10 }).optional(),        // YYYY-MM-DD when the source gives one
  }), { max: 12 }),
  angles: s.array(s.string({ min: 1, max: 300 }), { max: 5 }),
  confidence: s.number({ min: 0, max: 1 }),
});

/** Pull the first JSON object out of a model reply (tolerates ```json fences and leading prose). */
export function extractJson(text: string): unknown {
  const t = text.replace(/```(?:json)?/gi, '');
  const i = t.indexOf('{'), j = t.lastIndexOf('}');
  if (i < 0 || j <= i) throw new Error('no json object in reply');
  return JSON.parse(t.slice(i, j + 1));
}

/** Research URLs must be http(s); anything else is dropped before a write. */
export function cleanFindings<T extends { source_url: string }>(xs: T[]): T[] {
  return xs.filter((f) => /^https?:\/\/[^\s]+$/i.test(f.source_url));
}
