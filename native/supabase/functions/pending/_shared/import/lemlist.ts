// Import fixes (PENDING, not deployed). lemlist People database lookup: the ONE vendor call the import resolver makes.
// Licensed data only; nothing here (or anywhere in Ari) calls LinkedIn. Key: env LEMLIST_API_KEY (server-side secret), sent
// as HTTP Basic with an empty username. Each call spends one of the account's daily searches (trial: about 100 / 24h) and
// zero credits; the response's `limitation` field is the searches left, surfaced so the resolver can stop early.
import { guardedFetch } from '../ai/http.ts';
import { NotConfigured } from '../ai/types.ts';

export interface Candidate { full_name: string; company?: string; title?: string; location?: string; linkedin_url?: string; source: 'lemlist' | 'brave' }
export interface LookupResult { candidates: Candidate[]; searchesLeft?: number }
export interface PeopleLookup { find(q: { name: string; company?: string }): Promise<LookupResult> }

const URL_ = 'https://api.lemlist.com/api/database/people';
const env = (k: string): string | undefined => { try { return Deno.env.get(k) || undefined; } catch { return undefined; } };

// deno-lint-ignore no-explicit-any
export function mapLemlist(j: any): LookupResult {
  const rows = Array.isArray(j?.results) ? j.results : [];
  const candidates: Candidate[] = rows.slice(0, 10).map((x: Record<string, unknown>) => {
    // deno-lint-ignore no-explicit-any
    const exps = Array.isArray(x.experiences) ? (x.experiences as any[]) : [];
    const cur = exps.find((e) => e?.company_name === x.current_exp_company_name) ?? exps[0];
    return {
      full_name: String(x.full_name ?? ''), company: (x.current_exp_company_name as string) || undefined,
      title: cur?.title || undefined, location: (x.location as string) || undefined,
      linkedin_url: typeof x.lead_linkedin_url === 'string' ? x.lead_linkedin_url : undefined, source: 'lemlist' as const,
    };
  }).filter((c: Candidate) => c.full_name);
  return { candidates, searchesLeft: typeof j?.limitation === 'number' ? j.limitation : undefined };
}

export const lemlist: PeopleLookup = {
  async find(q) {
    const key = env('LEMLIST_API_KEY');
    if (!key) throw new NotConfigured('lemlist');
    const filters = q.company ? [{ filterId: 'currentCompany', in: [q.company], out: [] }] : [];
    const r = await guardedFetch(URL_, {
      method: 'POST',
      headers: { authorization: `Basic ${btoa(`:${key}`)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ filters, search: q.name.slice(0, 120), page: 1, size: 10 }),
    }, { timeoutMs: 15_000 });
    return mapLemlist(await r.json());
  },
};
