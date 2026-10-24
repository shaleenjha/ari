// Match a parsed LinkedIn event to a person in the workspace. Order: profile URL vanity, then exact name + company,
// then none (-> a "Who is this?" task for a human). Ambiguity is never guessed: two candidates = none.
import type { ParsedEvent } from './parse';

export interface Candidate { id: string; fullName: string; company?: string; linkedinUrl?: string }
export type MatchMethod = 'profile_url' | 'vanity' | 'name_company' | 'none';
export interface MatchResult { personId?: string; method: MatchMethod; candidates: string[] }

const norm = (s?: string): string => (s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/\b(inc|llc|ltd|corp|co|ai|io|labs|technologies|the)\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export const vanityOf = (url?: string): string | undefined =>
  url?.match(/linkedin\.com\/(?:comm\/)?in\/([^/?#]+)/i)?.[1]?.toLowerCase();

export function matchPerson(ev: ParsedEvent, people: Candidate[]): MatchResult {
  if (ev.vanity) {
    const hits = people.filter((p) => vanityOf(p.linkedinUrl) === ev.vanity);
    if (hits.length === 1) return { personId: hits[0]!.id, method: 'vanity', candidates: [hits[0]!.id] };
  }
  if (ev.name) {
    const byName = people.filter((p) => norm(p.fullName) === norm(ev.name));
    const byBoth = ev.company ? byName.filter((p) => norm(p.company) && norm(p.company) === norm(ev.company)) : [];
    if (byBoth.length === 1) return { personId: byBoth[0]!.id, method: 'name_company', candidates: [byBoth[0]!.id] };
    return { method: 'none', candidates: (byBoth.length ? byBoth : byName).map((p) => p.id) };
  }
  return { method: 'none', candidates: [] };
}
