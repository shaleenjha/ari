// Import fixes (PENDING, not deployed). Spec: docs/specs/08_import_fix_options.md.
// Owner, Oct 23 2026: an import card must not just raise flags; each flag arrives with its fix prepared, and one tap
// approves the lot. Rule of the module: CODE DETECTS, AI JUDGES. Spotting a duplicate or a missing URL is a fact, so plain
// code does it (free, instant, testable). Only "which of these profiles is her?" is judgment, so only that reaches Haiku.
// Nothing here writes: resolveImport returns a plan; applying it is the caller's job, after the Owner's tap.
import { runTask, Deps } from '../ai/run.ts';
import { MatchOut } from '../ai/schema.ts';
import { matchProfilePrompt } from '../ai/prompts.ts';
import { Candidate, PeopleLookup } from './lemlist.ts';

export interface ImportRow { row: number; name: string; company: string; title?: string; location?: string; linkedin_url?: string }
export interface BookPerson { id: string; name: string; company: string; title?: string; linkedin_url?: string }

export type OptionKey = 'skip' | 'update' | 'use_profile' | 'choose_profile' | 'park_no_linkedin';
export interface FixOption { key: OptionKey; label: string; candidate?: Candidate; changes?: Record<string, string> }
export interface Flag {
  kind: 'duplicate' | 'missing_url';
  row: number;
  name: string;
  detail: string;                          // one plain line for the card
  options: FixOption[];                    // first option is the prepared default
  chosen: OptionKey;                       // what the one-tap approve applies
  confidence?: number;                     // missing_url: how sure the match is
  source?: string;                         // where a suggested profile came from
  searchUrl?: string;                      // missing_url: a prefilled web search the Owner can open to find the URL by hand
}
export interface ImportPlan { add: number[]; flags: Flag[]; approveLabel: string; lookupsUsed: number; aiCalls: number; notes: string[] }

export interface ResolveDeps { lookup: PeopleLookup; ai: Deps; maxLookups?: number; minSearchesLeft?: number }

// ---------- normalisers (pure) ----------
export function slugOf(u?: string | null): string | null {
  const m = /linkedin\.com\/(?:in|pub)\/([^/?#\s]+)/i.exec(u ?? '');
  if (!m) return null;
  try { return decodeURIComponent(m[1]).toLowerCase().replace(/\/+$/, ''); } catch { return m[1].toLowerCase(); }
}
const SUFFIX = /\b(inc|incorporated|corp|corporation|co|company|llc|ltd|limited|plc|gmbh|sa|ag|holdings|group|the)\b/g;
export function normCompany(c?: string | null): string {
  return (c ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[.,'’()]/g, ' ').replace(SUFFIX, ' ').replace(/\s+/g, ' ').trim();
}
export function normName(n?: string | null): string {
  return (n ?? '').toLowerCase().replace(/,.*$/, '')                     // "Jose Marlow, PhD" -> "jose marlow"
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s'-]/g, ' ').replace(/\s+/g, ' ').trim();
}
const sameCompany = (a?: string, b?: string) => { const x = normCompany(a), y = normCompany(b); return !!x && !!y && (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' ')); };

// ---------- step 1: duplicates (code only) ----------
export function findDuplicate(r: ImportRow, book: BookPerson[]): { person: BookPerson; how: 'same_profile' | 'same_name_company' } | null {
  const s = slugOf(r.linkedin_url);
  if (s) { const p = book.find((b) => slugOf(b.linkedin_url) === s); if (p) return { person: p, how: 'same_profile' }; }
  const n = normName(r.name);
  const p = book.find((b) => normName(b.name) === n && sameCompany(b.company, r.company));
  return p ? { person: p, how: 'same_name_company' } : null;
}

function duplicateFlag(r: ImportRow, d: { person: BookPerson; how: string }): Flag {
  const changes: Record<string, string> = {};
  if (r.title && r.title !== d.person.title) changes.title = r.title;
  if (r.linkedin_url && !d.person.linkedin_url) changes.linkedin_url = r.linkedin_url;
  const opts: FixOption[] = [{ key: 'skip', label: `Skip ${first(r.name)}, keep your record` }];
  if (Object.keys(changes).length) opts.push({ key: 'update', label: `Update ${first(r.name)}'s ${Object.keys(changes).join(' and ').replace('linkedin_url', 'LinkedIn')}`, changes });
  return { kind: 'duplicate', row: r.row, name: r.name, detail: `${r.name} is already in your book`, options: opts, chosen: 'skip' };
}

// ---------- step 2: missing LinkedIn URL (lookup, then code, then Haiku only if needed) ----------
async function missingUrlFlag(r: ImportRow, deps: ResolveDeps, budget: { lookups: number; ai: number; stop: boolean }): Promise<Flag> {
  const park: FixOption = { key: 'park_no_linkedin', label: `Park ${first(r.name)} on ${r.company}, no LinkedIn step` };
  const base = { kind: 'missing_url' as const, row: r.row, name: r.name, searchUrl: searchUrl(r) };
  if (budget.stop || budget.lookups >= (deps.maxLookups ?? 20)) {
    return { ...base, detail: `${r.name} has no LinkedIn URL (lookup paused: daily limit)`, options: [park], chosen: 'park_no_linkedin' };
  }
  let cands: Candidate[] = [];
  try {
    const res = await deps.lookup.find({ name: r.name, company: r.company });
    budget.lookups++;
    cands = res.candidates.filter((c) => slugOf(c.linkedin_url));
    if (res.searchesLeft !== undefined && res.searchesLeft <= (deps.minSearchesLeft ?? 5)) budget.stop = true;
  } catch {
    return { ...base, detail: `${r.name} has no LinkedIn URL (lookup failed)`, options: [park], chosen: 'park_no_linkedin' };
  }
  if (!cands.length) return { ...base, detail: `${r.name} has no LinkedIn URL and no match was found`, options: [park], chosen: 'park_no_linkedin' };

  // Code first: exactly one candidate with the same name at the same company is a match without asking a model.
  const exact = cands.filter((c) => normName(c.full_name) === normName(r.name) && sameCompany(c.company, r.company));
  if (exact.length === 1) return found(r, exact[0], 0.95, 'Same name and company');

  // Judgment: several plausible profiles (or near-miss names). Haiku picks; the rule below decides what Owner sees.
  budget.ai++;
  try {
    const { value } = await runTask('match_profile', matchProfilePrompt(rowCtx(r), cands.map(candCtx)), MatchOut, deps.ai);
    const pick = value.pick >= 0 ? cands[value.pick] : undefined;
    if (pick && value.confidence >= 0.8) return found(r, pick, value.confidence, value.reason);
    const top = [pick, value.runner_up !== undefined && value.runner_up >= 0 ? cands[value.runner_up] : undefined]
      .filter((c): c is Candidate => !!c);
    const two = (top.length ? top : cands).slice(0, 2);
    if (value.confidence >= 0.5 && two.length) {
      return { ...base, detail: `${r.name} has no LinkedIn URL. ${two.length > 1 ? 'Two possible profiles' : 'One possible profile'}`,
        options: [park, ...two.map((c) => ({ key: 'choose_profile' as const, label: describe(c), candidate: c }))],
        chosen: 'park_no_linkedin', confidence: value.confidence, source: sourceLabel(two[0]) };
    }
  } catch { /* budget refused or invalid output: fall through to park, never guess */ }
  return { ...base, detail: `${r.name} has no LinkedIn URL and no confident match`, options: [park], chosen: 'park_no_linkedin' };
}

function found(r: ImportRow, c: Candidate, confidence: number, why: string): Flag {
  return { kind: 'missing_url', row: r.row, name: r.name, detail: `Found ${first(r.name)}: ${describe(c)}`,
    options: [{ key: 'use_profile', label: 'Use this profile', candidate: c }, { key: 'park_no_linkedin', label: `Park ${first(r.name)} on ${r.company}` }],
    chosen: 'use_profile', confidence, source: `${sourceLabel(c)} (${why})`, searchUrl: searchUrl(r) };
}

const sourceLabel = (c: Candidate) => c.source === 'brave' ? 'web search' : 'lemlist People';
/** Opened on the Owner's phone, never fetched by Ari. */
export const searchUrl = (r: ImportRow) =>
  `https://www.google.com/search?q=${encodeURIComponent(`"${r.name}" "${r.company}" site:linkedin.com/in`)}`;

const first = (n: string) => n.trim().split(/\s+/)[0] || n;
const describe = (c: Candidate) => [c.title, c.company].filter(Boolean).join(' at ') || c.full_name;
const rowCtx = (r: ImportRow) => ({ name: r.name, company: r.company, title: r.title, location: r.location });
const candCtx = (c: Candidate) => ({ name: c.full_name, company: c.company, title: c.title, location: c.location });

// ---------- the plan + the one-tap label ----------
export async function resolveImport(rows: ImportRow[], book: BookPerson[], deps: ResolveDeps): Promise<ImportPlan> {
  const flags: Flag[] = [], add: number[] = [], notes: string[] = [];
  const budget = { lookups: 0, ai: 0, stop: false };
  const seen = new Map<string, number>();                         // duplicates inside the same CSV
  for (const r of rows) {
    const key = slugOf(r.linkedin_url) ?? `${normName(r.name)}|${normCompany(r.company)}`;
    if (seen.has(key)) { notes.push(`row ${r.row} repeats row ${seen.get(key)}; kept the first`); continue; }
    seen.set(key, r.row);
    const d = findDuplicate(r, book);
    if (d) { flags.push(duplicateFlag(r, d)); continue; }
    if (!slugOf(r.linkedin_url)) { flags.push(await missingUrlFlag(r, deps, budget)); continue; }
    add.push(r.row);
  }
  if (budget.stop) notes.push('daily search limit nearly used; remaining missing URLs were parked');
  return { add, flags, approveLabel: approveLabel(add.length, flags), lookupsUsed: budget.lookups, aiCalls: budget.ai, notes };
}

/** "Add 11, skip 1 duplicate, use 1 found profile". Counts what the default choices will do. */
export function approveLabel(adds: number, flags: Flag[]): string {
  const c = (k: OptionKey) => flags.filter((f) => f.chosen === k).length;
  const added = adds + c('use_profile');                          // updates touch existing records, parks go to the account
  const parts = [`Add ${added}`];
  if (c('skip')) parts.push(`skip ${c('skip')} duplicate${c('skip') > 1 ? 's' : ''}`);
  if (c('update')) parts.push(`update ${c('update')}`);
  if (c('use_profile')) parts.push(`use ${c('use_profile')} found profile${c('use_profile') > 1 ? 's' : ''}`);
  if (c('park_no_linkedin')) parts.push(`park ${c('park_no_linkedin')}`);
  return parts.join(', ');
}
