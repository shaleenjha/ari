// CSV import card, pure logic (spec docs/specs/08_import_fix_options.md). Parses the file on the phone, shapes rows for the
// import_resolve action, and recomputes the one-tap label when the Owner changes a choice. No network and no writes here.
// The plan types mirror native/supabase/functions/pending/_shared/import/resolve.ts (ImportPlan, Flag, FixOption).

export type OptionKey = 'skip' | 'update' | 'use_profile' | 'choose_profile' | 'park_no_linkedin';
export interface Candidate { full_name: string; company?: string; title?: string; location?: string; linkedin_url?: string; source: 'lemlist' | 'brave' }
export interface FixOption { key: OptionKey; label: string; candidate?: Candidate; changes?: Record<string, string> }
export interface Flag {
  kind: 'duplicate' | 'missing_url';
  row: number;
  name: string;
  detail: string;
  options: FixOption[];
  chosen: OptionKey;
  confidence?: number;
  source?: string;
  searchUrl?: string;
}
export interface ImportPlan { add: number[]; flags: Flag[]; approveLabel: string; lookupsUsed: number; aiCalls: number; notes: string[] }

/** One row as import_resolve takes it. `row` is the row's number in the file (header excluded), so notes point at it. */
export interface ImportRow { row: number; name: string; company: string; title?: string; location?: string; linkedin_url?: string }

/** import_resolve takes at most 100 rows per call (actions.ts MAX_IMPORT_ROWS). */
export const MAX_IMPORT_ROWS = 100;
/** The request body cap for import_resolve (handler.ts MAX_IMPORT_BODY), with room for the action field. */
export const MAX_IMPORT_BYTES = 65_000;
/** Same field caps as the server (actions.ts importRows), so a row is never cut differently on the two sides. */
const CAP = { name: 120, company: 120, title: 200, location: 120, linkedin_url: 300 } as const;

export interface ParsedCsv {
  rows: ImportRow[];
  /** Data rows in the file with a name and a company, before the 100 cap. */
  usable: number;
  /** Data rows dropped for having no name or no company. */
  skipped: number;
  /** True when more than MAX_IMPORT_ROWS usable rows were in the file. */
  capped: boolean;
  /** Set when the file cannot be used at all. Plain copy for the card. */
  error?: string;
}

/** RFC 4180 style split: quoted fields, doubled quotes, commas and line breaks inside quotes, CRLF, a leading BOM. */
export function splitCsv(text: string, delim = ','): string[][] {
  const s = text.replace(/^\uFEFF/, '');
  const out: string[][] = [];
  let row: string[] = [], field = '', quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field); out.push(row); row = []; field = '';
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); out.push(row); }
  return out.filter((r) => r.some((x) => x.trim() !== ''));
}

/** Comma unless the header line clearly uses semicolons or tabs (spreadsheet exports in some locales). */
export function sniffDelimiter(text: string): string {
  const head = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const n = (d: string) => head.split(d).length - 1;
  const best = [',', ';', '\t'].sort((a, b) => n(b) - n(a))[0]!;
  return n(best) > 0 ? best : ',';
}

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** Header names seen in common exports (Sales Navigator, Apollo, lemlist, hand-made sheets), normalised. */
const ALIASES: Record<keyof typeof CAP | 'first' | 'last', string[]> = {
  name: ['name', 'full name', 'fullname', 'person', 'person name', 'contact', 'contact name', 'lead name', 'prospect', 'prospect name'],
  first: ['first name', 'firstname', 'first', 'given name'],
  last: ['last name', 'lastname', 'last', 'surname', 'family name'],
  company: ['company', 'company name', 'account', 'account name', 'organization', 'organisation', 'organization name', 'employer',
    'current company', 'companyname'],
  title: ['title', 'job title', 'jobtitle', 'position', 'role', 'headline', 'current title'],
  location: ['location', 'city', 'region', 'geography', 'geo', 'country', 'person location'],
  linkedin_url: ['linkedin', 'linkedin url', 'linkedinurl', 'linkedin profile', 'linkedin profile url', 'person linkedin url', 'profile url',
    'li url', 'linkedin link', 'url', 'profile'],
};

export type Columns = Partial<Record<keyof typeof ALIASES, number>>;
/** Which column holds which field. First matching header wins; aliases are tried in order. */
export function mapHeaders(header: string[]): Columns {
  const h = header.map(norm);
  const cols: Columns = {};
  for (const [field, names] of Object.entries(ALIASES) as [keyof typeof ALIASES, string[]][]) {
    for (const n of names) { const i = h.indexOf(n); if (i >= 0) { cols[field] = i; break; } }
  }
  return cols;
}

const clip = (v: string | undefined, max: number): string | undefined => {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : undefined;
};

/** A LinkedIn profile link in the shape the server accepts (https, /in/ path), or undefined. Adds a missing https://www. */
export function cleanLinkedIn(v?: string): string | undefined {
  let u = (v ?? '').trim();
  if (!u) return undefined;
  if (!/^https?:\/\//i.test(u)) u = `https://${u.replace(/^\/+/, '')}`;
  u = u.replace(/^http:\/\//i, 'https://').replace(/^https:\/\/linkedin\.com/i, 'https://www.linkedin.com');
  return /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^/?#\s]+/i.test(u) ? u.slice(0, CAP.linkedin_url) : undefined;
}

/** Parse a CSV file's text into import rows. Never throws; a file it cannot use comes back with `error`. */
export function parseImportCsv(text: string): ParsedCsv {
  const empty = (error: string): ParsedCsv => ({ rows: [], usable: 0, skipped: 0, capped: false, error });
  const table = splitCsv(text, sniffDelimiter(text));
  if (table.length < 2) return empty('This file has no rows under the header.');
  const cols = mapHeaders(table[0]!);
  const hasName = cols.name !== undefined || cols.first !== undefined;
  if (!hasName || cols.company === undefined) return empty('This file needs a name column and a company column.');
  const at = (r: string[], k: keyof Columns) => (cols[k] === undefined ? undefined : r[cols[k]!]);
  const rows: ImportRow[] = [];
  let skipped = 0, usable = 0;
  table.slice(1).forEach((r, i) => {
    const joined = [at(r, 'first'), at(r, 'last')].filter((x) => x && x.trim()).join(' ');
    const name = clip(at(r, 'name') || joined, CAP.name);
    const company = clip(at(r, 'company'), CAP.company);
    if (!name || !company) { skipped++; return; }
    usable++;
    if (rows.length >= MAX_IMPORT_ROWS) return;
    rows.push({ row: i + 1, name, company, title: clip(at(r, 'title'), CAP.title), location: clip(at(r, 'location'), CAP.location),
      linkedin_url: cleanLinkedIn(at(r, 'linkedin_url')) });
  });
  if (!rows.length) return { ...empty('No row has both a name and a company.'), skipped };
  return { rows, usable, skipped, capped: usable > MAX_IMPORT_ROWS };
}

/** The request body for import_resolve. Fields left out when empty, so the body stays small. */
export const resolveBody = (rows: ImportRow[]) => JSON.stringify({ action: 'import_resolve', rows });
export const fitsOneRequest = (rows: ImportRow[]) => new TextEncoder().encode(resolveBody(rows)).length <= MAX_IMPORT_BYTES;

// ---------- choices and the one-tap label ----------

/** Owner's pick per flag: index into flag.options. */
export type Choices = number[];
/** The prepared default for each flag: the option whose key is flag.chosen (the first one if several share it). */
export const defaultChoices = (plan: ImportPlan): Choices => plan.flags.map((f) => Math.max(0, f.options.findIndex((o) => o.key === f.chosen)));
export const chosenKey = (f: Flag, i: number | undefined): OptionKey => f.options[i ?? -1]?.key ?? f.chosen;

/**
 * Same rules as approveLabel() in resolve.ts, counted from the Owner's current choices. One extension: a profile the
 * Owner picked from the list (choose_profile) adds the person with that profile, so it counts with use_profile. The
 * server never preselects choose_profile, so on the prepared defaults both functions give the same label.
 */
export function approveLabelFor(plan: ImportPlan, choices: Choices): string {
  const keys = plan.flags.map((f, i) => chosenKey(f, choices[i]));
  const c = (k: OptionKey) => keys.filter((x) => x === k).length;
  const used = c('use_profile') + c('choose_profile');
  const parts = [`Add ${plan.add.length + used}`];
  if (c('skip')) parts.push(`skip ${c('skip')} duplicate${c('skip') > 1 ? 's' : ''}`);
  if (c('update')) parts.push(`update ${c('update')}`);
  if (used) parts.push(`use ${used} found profile${used > 1 ? 's' : ''}`);
  if (c('park_no_linkedin')) parts.push(`park ${c('park_no_linkedin')}`);
  return parts.join(', ');
}

/** "92% match" for a found profile. Confidence is 0 to 1. */
export const confidenceText = (x?: number) => (x == null ? null : `${Math.round(Math.min(1, Math.max(0, x)) * 100)}% match`);
