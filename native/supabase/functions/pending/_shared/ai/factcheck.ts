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
export const normClaim = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').replace(/[^\w %$.,:/-]/g, '').trim();
export async function claimHash(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normClaim(s)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export function domainOk(d: string): string | null {
  const x = d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(x) ? x : null;
}

/** Pick the claims that MAY be sent. Pure; every item gets a logged decision. */
export function selectClaims(f: FactInput): { eligible: { claim: string; source: string }[]; decisions: Decision[] } {
  const decisions: Decision[] = [], eligible: { claim: string; source: string }[] = [];
  const nameParts = (f.contact.name ?? '').split(/\s+/).filter((p) => p.length >= 3).map((p) => p.toLowerCase());
  const title = (f.contact.title ?? '').toLowerCase().trim();
  const seller = (f.seller ?? 'Thrandvex').toLowerCase();
  for (const sf of f.source_facts ?? []) {
    const c = String(sf.fact ?? '').trim(), low = c.toLowerCase(), src = String(sf.source ?? '');
    const why = !c ? 'empty'
      : !/^https:\/\//i.test(src) ? 'blocked: not from public web research (record field or no url)'
      : nameParts.some((p) => new RegExp(`\\b${p.replace(/[^a-z]/g, '')}\\b`).test(low)) ? 'blocked: mentions the contact'
      : title && low.includes(title) ? 'blocked: mentions the contact title'
      : low.includes(seller) ? 'blocked: seller pitch'
      : /\b(ae|account executive|deal|opportunity|pipeline|crm|crm|meeting with us|our call)\b/.test(low) ? 'blocked: sales or CRM data'
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
  return { verdict: String(a.choice ?? 'unverifiable'), confidence: typeof a.confidence === 'number' ? Math.round(a.confidence * 1000) / 1000 : null,
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
  // claims are independent: check them in parallel
  const fresh = await Promise.all(todo.map(async (c, i) => {
    try { const v = readVerdict(await post(payloads[i])); await d.cachePut(domain, c.hash, c.claim, v); return [c.hash, v] as const; }
    catch (e) { return [c.hash, { verdict: 'error', confidence: null, citations: [], error: String((e as Error)?.message ?? e).slice(0, 120) }] as const; }
  }));
  const all: Record<string, unknown> = { ...cached, ...Object.fromEntries(fresh) };
  const verdicts = claims.map((c) => ({ claim: c.claim, source: c.source, claim_hash: c.hash, cached: !!cached[c.hash], ...(all[c.hash] as object) }));
  const flagged = verdicts.some((v) => (v as { verdict?: string }).verdict === 'false');
  return { status: 'done', decisions, payloads, verdicts, calls: todo.length, flagged, ms: Date.now() - t0 };
}
