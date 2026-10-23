import { describe, expect, it } from 'vitest';
import { approveLabelFor, cleanLinkedIn, confidenceText, defaultChoices, fitsOneRequest, mapHeaders, MAX_IMPORT_ROWS, parseImportCsv, splitCsv,
  type Flag, type ImportPlan } from './importPlan';
import { fixturePlan, SAMPLE_CSV } from './fixtures/importPlans';
import { resolveErrorOf } from './imports';

describe('splitCsv', () => {
  it('handles quotes, doubled quotes, commas and line breaks inside quotes, CRLF and a BOM', () => {
    const t = '\uFEFFname,company\r\n"Lark, Jr.","Say ""hi"" Co"\r\n"Two\nLines",Ixterlane\r\n\r\n';
    expect(splitCsv(t)).toEqual([['name', 'company'], ['Lark, Jr.', 'Say "hi" Co'], ['Two\nLines', 'Ixterlane']]);
  });
  it('keeps a last row with no trailing newline and drops blank rows', () => {
    expect(splitCsv('a,b\n,\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('mapHeaders', () => {
  it('reads common export headers', () => {
    expect(mapHeaders(['First Name', 'Last Name', 'Company Name', 'Job Title', 'City', 'Person Linkedin Url']))
      .toEqual({ first: 0, last: 1, company: 2, title: 3, location: 4, linkedin_url: 5 });
    expect(mapHeaders(['Full name', 'Account', 'Position', 'LinkedIn'])).toMatchObject({ name: 0, company: 1, title: 2, linkedin_url: 3 });
  });
});

describe('cleanLinkedIn', () => {
  it('adds https://www and refuses anything that is not a profile link', () => {
    expect(cleanLinkedIn('linkedin.com/in/sana-fauxwell-example')).toBe('https://www.linkedin.com/in/sana-fauxwell-example');
    expect(cleanLinkedIn('http://uk.linkedin.com/in/x-example')).toBe('https://uk.linkedin.com/in/x-example');
    expect(cleanLinkedIn('https://www.linkedin.com/company/ixterlane')).toBeUndefined();
    expect(cleanLinkedIn('https://example.com/in/x')).toBeUndefined();
    expect(cleanLinkedIn('')).toBeUndefined();
  });
});

describe('parseImportCsv', () => {
  it('parses the sample: names, numbered rows, optional fields left out', () => {
    const p = parseImportCsv(SAMPLE_CSV);
    expect(p.error).toBeUndefined();
    expect(p.rows).toHaveLength(6);
    expect(p.rows[0]).toEqual({ row: 1, name: 'Mira Fakerton', company: 'Norquiveth Pay', title: 'VP Data', location: 'Remote',
      linkedin_url: 'https://www.linkedin.com/in/mira-fakerton-example' });
    expect(p.rows[3]).toEqual({ row: 4, name: 'Tess Sampleton', company: 'Clovardine Labs', title: undefined, location: undefined, linkedin_url: undefined });
    expect(p.rows[5]!.linkedin_url).toBe('https://www.linkedin.com/in/sana-fauxwell-example');
  });
  it('joins first and last name, reads semicolon files, skips rows with no name or company', () => {
    const p = parseImportCsv('First name;Last name;Organisation\nNell;Vargample;Quellivarn\n;;Nameless Co\nOnly;Name;\n');
    expect(p.rows).toEqual([{ row: 1, name: 'Nell Vargample', company: 'Quellivarn', title: undefined, location: undefined, linkedin_url: undefined }]);
    expect(p.skipped).toBe(2);
  });
  it('caps at 100 rows and says how many were usable', () => {
    const body = Array.from({ length: 130 }, (_, i) => `Person ${i},Co ${i}`).join('\n');
    const p = parseImportCsv(`name,company\n${body}`);
    expect(p.rows).toHaveLength(MAX_IMPORT_ROWS);
    expect(p.usable).toBe(130);
    expect(p.capped).toBe(true);
    expect(p.rows[99]!.row).toBe(100);
  });
  it('explains a file it cannot use', () => {
    expect(parseImportCsv('').error).toMatch(/no rows/);
    expect(parseImportCsv('name,title\nA,B').error).toMatch(/name column and a company column/);
    expect(parseImportCsv('name,company\n,\n ,x').error).toMatch(/No row has both/);
  });
  it('clips fields to the server caps and a full 100 row file fits one request', () => {
    const long = 'x'.repeat(500);
    const p = parseImportCsv(`name,company,title\n${long},${long},${long}`);
    expect(p.rows[0]!.name).toHaveLength(120);
    expect(p.rows[0]!.title).toHaveLength(200);
    const rows = Array.from({ length: 100 }, (_, i) => `Person Number ${i},Company Name ${i},Director of Platform Engineering,Remote,https://www.linkedin.com/in/person-${i}-example`);
    expect(fitsOneRequest(parseImportCsv(`name,company,title,location,linkedin\n${rows.join('\n')}`).rows)).toBe(true);
  });
});

/** approveLabel() from resolve.ts, copied verbatim, so the local recompute is checked against the server's own rule. */
function serverApproveLabel(adds: number, flags: Flag[]): string {
  const c = (k: Flag['chosen']) => flags.filter((f) => f.chosen === k).length;
  const added = adds + c('use_profile');
  const parts = [`Add ${added}`];
  if (c('skip')) parts.push(`skip ${c('skip')} duplicate${c('skip') > 1 ? 's' : ''}`);
  if (c('update')) parts.push(`update ${c('update')}`);
  if (c('use_profile')) parts.push(`use ${c('use_profile')} found profile${c('use_profile') > 1 ? 's' : ''}`);
  if (c('park_no_linkedin')) parts.push(`park ${c('park_no_linkedin')}`);
  return parts.join(', ');
}

describe('approveLabelFor', () => {
  const plan: ImportPlan = fixturePlan(parseImportCsv(SAMPLE_CSV).rows);
  const idx = (row: number) => plan.flags.findIndex((f) => f.row === row);

  it('matches the server label on the prepared defaults', () => {
    const d = defaultChoices(plan);
    expect(approveLabelFor(plan, d)).toBe(serverApproveLabel(plan.add.length, plan.flags));
    expect(approveLabelFor(plan, d)).toBe('Add 3, skip 1 duplicate, use 1 found profile, park 2');
  });
  it('matches the server rule for every single change between skip, update, use_profile and park', () => {
    for (const [fi, f] of plan.flags.entries()) {
      f.options.forEach((o, oi) => {
        if (o.key === 'choose_profile') return;
        const c = defaultChoices(plan); c[fi] = oi;
        const flags = plan.flags.map((g, j) => (j === fi ? { ...g, chosen: o.key } : g));
        expect(approveLabelFor(plan, c)).toBe(serverApproveLabel(plan.add.length, flags));
      });
    }
  });
  it('counts a profile picked from the list as an add with a found profile', () => {
    const c = defaultChoices(plan);
    c[idx(4)] = 1;                                 // Tess: first of the two possible profiles
    expect(approveLabelFor(plan, c)).toBe('Add 4, skip 1 duplicate, use 2 found profiles, park 1');
  });
  it('updates and parks change the words, not the add count', () => {
    const c = defaultChoices(plan);
    c[idx(2)] = 1;                                 // Avery: update title
    c[idx(3)] = 1;                                 // Jonah: park instead of the found profile
    expect(approveLabelFor(plan, c)).toBe('Add 2, update 1, park 3');
  });
  it('preselects the prepared default even when it is not the first option', () => {
    const f: Flag = { kind: 'missing_url', row: 1, name: 'A B', detail: 'x', chosen: 'use_profile',
      options: [{ key: 'park_no_linkedin', label: 'Park' }, { key: 'use_profile', label: 'Use this profile' }] };
    expect(defaultChoices({ add: [], flags: [f], approveLabel: '', lookupsUsed: 0, aiCalls: 0, notes: [] })).toEqual([1]);
  });
});

describe('small helpers', () => {
  it('confidence reads as a whole percent', () => {
    expect(confidenceText(0.92)).toBe('92% match');
    expect(confidenceText(undefined)).toBeNull();
  });
  it('maps the function error codes', () => {
    expect(resolveErrorOf(413, null)).toBe('too_large');
    expect(resolveErrorOf(429, { error: 'spend_limit' })).toBe('spend_limit');
    expect(resolveErrorOf(400, { error: 'bad_request' })).toBe('bad_request');
    expect(resolveErrorOf(401, { error: 'unauthorized' })).toBe('unauthorized');
    expect(resolveErrorOf(502, { error: 'draft_failed' })).toBe('failed');
  });
  it('fixture plans flag duplicates, missing links and repeats like the resolver', () => {
    const p = fixturePlan(parseImportCsv(`${SAMPLE_CSV}\nMira Fakerton,Norquiveth Pay,,,https://www.linkedin.com/in/mira-fakerton-example`).rows);
    expect(p.add).toEqual([1, 6]);
    expect(p.flags.map((f) => [f.row, f.kind, f.chosen])).toEqual([[2, 'duplicate', 'skip'], [3, 'missing_url', 'use_profile'],
      [4, 'missing_url', 'park_no_linkedin'], [5, 'missing_url', 'park_no_linkedin']]);
    expect(p.notes).toEqual(['row 7 repeats row 1; kept the first']);
  });
});
