// Import fixes (PENDING, not deployed). Step 2 of the missing-URL waterfall: one Brave Search API query per row,
// '"Name" "Company" site:linkedin.com/in'. We read only the public result title + URL that the SEARCH ENGINE returns; no
// request ever reaches linkedin.com (http.ts blocks it). Key: env BRAVE_SEARCH_API_KEY (server-side secret), header
// X-Subscription-Token. Cost: $5 per 1,000 queries with $5 free credit a month (1,000 queries), checked Oct 23 2026;
// set the account's usage cap to the free credit. Brave's terms forbid storing results: the plan holds candidates only in
// memory, and only the ONE URL the Owner approves is ever written.
import { guardedFetch } from '../ai/http.ts';
import { NotConfigured } from '../ai/types.ts';
import { Candidate, lemlist, PeopleLookup } from './lemlist.ts';

const URL_ = 'https://api.search.brave.com/res/v1/web/search';
const env = (k: string): string | undefined => { try { return Deno.env.get(k) || undefined; } catch { return undefined; } };
const clean = (s: string) => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();

/** "Priya Fixtura - VP Data - Quorvelline Pay | LinkedIn" -> name, title, company. Description "Experience: X" fills a missing company. */
export function parseTitle(rawTitle: string, rawDesc = ''): Pick<Candidate, 'full_name' | 'title' | 'company'> {
  const t = clean(rawTitle).replace(/\s*[|·]\s*LinkedIn.*$/i, '');
  const parts = t.split(/\s+[-–—]\s+/).map((x) => x.trim()).filter(Boolean);
  const exp = /Experience:\s*([^·|\n]+?)(?:\s*[·|]|$)/i.exec(clean(rawDesc))?.[1]?.trim();
  const full_name = parts[0] ?? '';
  if (parts.length >= 3) return { full_name, title: parts[1], company: parts.slice(2).join(' - ') };
  if (parts.length === 2) return exp ? { full_name, title: parts[1], company: exp } : { full_name, company: parts[1] };
  return { full_name, company: exp };
}

// deno-lint-ignore no-explicit-any
export function mapBrave(j: any): Candidate[] {
  const rows = Array.isArray(j?.web?.results) ? j.web.results : [];
  const out: Candidate[] = [];
  for (const r of rows.slice(0, 10)) {
    const url = typeof r?.url === 'string' ? r.url : '';
    if (!/^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^/?#]+/i.test(url)) continue;   // profiles only, no posts/companies
    const p = parseTitle(String(r?.title ?? ''), String(r?.description ?? ''));
    if (p.full_name) out.push({ ...p, linkedin_url: url.split(/[?#]/)[0], source: 'brave' });
  }
  return out;
}

export const brave: PeopleLookup = {
  async find(q) {
    const key = env('BRAVE_SEARCH_API_KEY');
    if (!key) throw new NotConfigured('brave');
    const qs = `"${q.name.replace(/"/g, '').slice(0, 80)}"${q.company ? ` "${q.company.replace(/"/g, '').slice(0, 80)}"` : ''} site:linkedin.com/in`;
    const r = await guardedFetch(`${URL_}?q=${encodeURIComponent(qs)}&count=10&safesearch=off`, {
      method: 'GET', headers: { 'X-Subscription-Token': key, accept: 'application/json' },
    }, { timeoutMs: 10_000 });
    return { candidates: mapBrave(await r.json()) };
  },
};

/** Waterfall: ask each source in order and stop at the first that returns a profile. A source with no key, an error or no
 *  profile passes to the next. searchesLeft is reported only by lemlist, so the resolver's daily-limit stop still works. */
export function waterfall(...sources: PeopleLookup[]): PeopleLookup {
  return {
    async find(q) {
      let searchesLeft: number | undefined; let failures = 0;
      for (const s of sources) {
        try {
          const res = await s.find(q);
          if (res.searchesLeft !== undefined) searchesLeft = res.searchesLeft;
          if (res.candidates.some((c) => c.linkedin_url)) return { ...res, searchesLeft };
        } catch { failures++; }
      }
      if (failures === sources.length) throw new Error('all lookups failed');
      return { candidates: [], searchesLeft };
    },
  };
}

/** The import job's lookup: CSV URL first (free, in resolve.ts), then Brave, then lemlist while its trial lasts, then park. */
export const defaultLookup: PeopleLookup = waterfall(brave, lemlist);
