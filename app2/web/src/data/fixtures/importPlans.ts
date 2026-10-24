// Synthetic import plans for mock mode and tests. Invented names only, never real leads. The fixture resolver builds a plan
// from whatever rows the CSV has, using the same shapes resolve.ts returns, so every flag kind and band shows on screen:
//   a name in BOOK                -> duplicate (Skip default; Update when the CSV has a new title or link)
//   a row with a LinkedIn link    -> clean add
//   a row without one, in turn    -> found profile (0.92, Use this profile default), two possible profiles (0.64, Park
//                                    default), no match (Park)
import type { Candidate, Flag, ImportPlan, ImportRow } from '../importPlan';
import { approveLabelFor, defaultChoices } from '../importPlan';

const BOOK: Record<string, { title?: string; linkedin_url?: string }> = {
  'avery pseudova': { title: 'Head of Data', linkedin_url: 'https://www.linkedin.com/in/avery-pseudova-example' },
  'rowan ternby': { title: 'CISO' },
};
const first = (n: string) => n.trim().split(/\s+/)[0] || n;
const search = (r: ImportRow) => `https://www.google.com/search?q=${encodeURIComponent(`"${r.name}" "${r.company}" site:linkedin.com/in`)}`;
const slug = (n: string, k = '') => `https://www.linkedin.com/in/${n.toLowerCase().replace(/[^a-z]+/g, '-')}${k}-example`;
const describe = (c: Candidate) => [c.title, c.company].filter(Boolean).join(' at ') || c.full_name;

function duplicate(r: ImportRow, b: { title?: string; linkedin_url?: string }): Flag {
  const changes: Record<string, string> = {};
  if (r.title && r.title !== b.title) changes.title = r.title;
  if (r.linkedin_url && !b.linkedin_url) changes.linkedin_url = r.linkedin_url;
  const options: Flag['options'] = [{ key: 'skip', label: `Skip ${first(r.name)}, keep your record` }];
  if (Object.keys(changes).length) options.push({ key: 'update', label: `Update ${first(r.name)}'s ${Object.keys(changes).join(' and ').replace('linkedin_url', 'LinkedIn')}`, changes });
  return { kind: 'duplicate', row: r.row, name: r.name, detail: `${r.name} is already in your book`, options, chosen: 'skip' };
}

function missing(r: ImportRow, band: number): Flag {
  const park = { key: 'park_no_linkedin' as const, label: `Park ${first(r.name)} on ${r.company}, no LinkedIn step` };
  const base = { kind: 'missing_url' as const, row: r.row, name: r.name, searchUrl: search(r) };
  if (band === 0) {
    const c: Candidate = { full_name: r.name, company: r.company, title: r.title ?? 'Director of Platform', linkedin_url: slug(r.name), source: 'brave' };
    return { ...base, detail: `Found ${first(r.name)}: ${describe(c)}`, chosen: 'use_profile', confidence: 0.92, source: 'web search (Same name and company)',
      options: [{ key: 'use_profile', label: 'Use this profile', candidate: c }, { key: 'park_no_linkedin', label: `Park ${first(r.name)} on ${r.company}` }] };
  }
  if (band === 1) {
    const two: Candidate[] = [
      { full_name: r.name, company: r.company, title: 'VP Engineering', linkedin_url: slug(r.name, '-a'), source: 'lemlist' },
      { full_name: r.name, company: `${r.company} Labs`, title: 'Engineering Manager', linkedin_url: slug(r.name, '-b'), source: 'lemlist' },
    ];
    return { ...base, detail: `${r.name} has no LinkedIn URL. Two possible profiles`, chosen: 'park_no_linkedin', confidence: 0.64, source: 'lemlist People',
      options: [park, ...two.map((c) => ({ key: 'choose_profile' as const, label: describe(c), candidate: c }))] };
  }
  return { ...base, detail: `${r.name} has no LinkedIn URL and no match was found`, options: [park], chosen: 'park_no_linkedin' };
}

/** A plan shaped like resolveImport's, from any rows. Deterministic. */
export function fixturePlan(rows: ImportRow[]): ImportPlan {
  const add: number[] = [], flags: Flag[] = [], notes: string[] = [];
  const seen = new Map<string, number>();
  let band = 0;
  for (const r of rows) {
    const key = r.linkedin_url ?? `${r.name.toLowerCase()}|${r.company.toLowerCase()}`;
    if (seen.has(key)) { notes.push(`row ${r.row} repeats row ${seen.get(key)}; kept the first`); continue; }
    seen.set(key, r.row);
    const b = BOOK[r.name.toLowerCase()];
    if (b) flags.push(duplicate(r, b));
    else if (!r.linkedin_url) flags.push(missing(r, band++ % 3));
    else add.push(r.row);
  }
  const plan: ImportPlan = { add, flags, approveLabel: '', lookupsUsed: flags.filter((f) => f.kind === 'missing_url').length, aiCalls: 0, notes };
  return { ...plan, approveLabel: approveLabelFor(plan, defaultChoices(plan)) };
}

/** Mock mode resolver. ?delay=<ms> in the URL holds it like the other mock reads (main.tsx). */
export const fixtureResolver = (delayMs = 0) => async (rows: ImportRow[]): Promise<ImportPlan> => {
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  return fixturePlan(rows);
};

/** A small synthetic CSV that shows every flag kind (tests and the e2e check). */
export const SAMPLE_CSV = [
  'Full Name,Company,Job Title,Location,LinkedIn URL',
  'Mira Fakerton,Norquiveth Pay,VP Data,Remote,https://www.linkedin.com/in/mira-fakerton-example',
  'Avery Pseudova,Exquorra Bank,Chief Data Officer,,',
  'Jonah Exampleton,Thessquorn Health,Head of Security,,',
  'Tess Sampleton,Clovardine Labs,,,',
  'Ilan Brookample,Moquadrel,Staff Engineer,,',
  'Sana Fauxwell,Norquiveth Pay,Director of Risk,,linkedin.com/in/sana-fauxwell-example',
].join('\n');
