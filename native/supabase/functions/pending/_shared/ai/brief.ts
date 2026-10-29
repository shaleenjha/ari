// Server brief stage (PENDING, Oct 28 2026). Port of scripts/brief_upsert.py's brief contract to TypeScript, built ONLY from
// what the research stage saved (no model call, no web): the research brief (summary + angles) and the research rows.
// Shapes are the ones the app reads (brief_upsert.py header):
//   why_now     [{date:'YYYY-MM-DD'|'', kind:'trigger'|'context', label:'Verified'|'Inference', text, url}]
//   committee   [{team, who, moves, people:[{person_id, name, title, priority, role, objection, answer, why}]}]
//   soft_angles [{kind:'role_pain', text}]       quick_check: 1 item      sequences: NOT built here (gap, stays [])
// Labels are decided by rules, never by the model: Verified = a cited https url AND a date; otherwise Inference.
// Trigger rule (Owner, Oct 28 2026): kind 'trigger' ONLY for dated news, an SEC / regulatory filing, a press release or a job
// post, dated within TRIGGER_DAYS, with an https url. Policy pages, product pages, directories, vendor-risk scans and undated
// pages are 'context', never the trigger (the Oct 28 staging brief had marked a privacy-policy capture as a Verified trigger).
// checkBrief() = brief_upsert.py check() minus the sequences rule (same banned strings, labels, quick_check range).

// deno-lint-ignore no-explicit-any
type Any = any;
export interface BriefIn {
  person: { id: string; name?: string; title?: string; company?: string; research_brief?: { summary?: string; angles?: string[]; confidence?: number } | null };
  account: { id: string; company?: string; domain?: string } | null;
  research: { source_url?: string; dated?: string | null; fact?: string }[];
  people: { person_id: string; name?: string; title?: string }[];
}
export interface Brief {
  account_id: string; thesis: string; why_now: Any[]; committee: Any[]; angle: string; soft_angles: Any[]; quick_check: Any[];
}

// brief_upsert.py BAD list: dashes, location words and P.S. never appear in a brief
export const BAD = ['\u2014', '\u2013', 'Bengaluru', 'Bangalore', 'India', ' IST', 'P.S.'];
const TRIGGER_DAYS = 120;
const clean = (s: unknown, n: number) => String(s ?? '').replace(/[\u2014\u2013]/g, ',').replace(/\s+/g, ' ').trim().slice(0, n);
const isoDate = (d: unknown) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : '';

export type TriggerSource = 'news' | 'filing' | 'press_release' | 'job_post';
const host = (u: string) => { try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; } };
const path = (u: string) => { try { return new URL(u).pathname.toLowerCase(); } catch { return ''; } };
const onHost = (h: string, list: string[]) => list.some((d) => h === d || h.endsWith('.' + d));
const FILING_HOSTS = ['sec.gov', 'ocrportal.hhs.gov', 'federalregister.gov', 'regulations.gov', 'fca.org.uk', 'sedarplus.ca'];
const WIRE_HOSTS = ['businesswire.com', 'prnewswire.com', 'globenewswire.com', 'accesswire.com', 'newswire.com', 'prweb.com', 'einpresswire.com',
  'newsfilecorp.com', 'newswire.ca'];
const JOB_HOSTS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'myworkdayjobs.com', 'smartrecruiters.com', 'workable.com', 'icims.com',
  'indeed.com', 'wellfound.com', 'jobvite.com', 'bamboohr.com', 'recruitee.com', 'rippling-ats.com'];
const NEWS_HOSTS = ['reuters.com', 'bloomberg.com', 'wsj.com', 'nytimes.com', 'ft.com', 'cnbc.com', 'apnews.com', 'axios.com', 'techcrunch.com',
  'theverge.com', 'forbes.com', 'businessinsider.com', 'fiercehealthcare.com', 'healthcaredive.com', 'statnews.com', 'beckershospitalreview.com',
  'modernhealthcare.com', 'healthcareitnews.com', 'hipaajournal.com', 'securityweek.com', 'bleepingcomputer.com', 'darkreading.com',
  'therecord.media', 'cybersecuritydive.com', 'theregister.com', 'zdnet.com', 'venturebeat.com', 'siliconangle.com', 'crn.com',
  'fintechfutures.com', 'americanbanker.com', 'finextra.com', 'pymnts.com', 'medcitynews.com', 'mobihealthnews.com', 'healthleadersmedia.com'];
// never a trigger, whatever the date: policies / terms, product and marketing pages, people directories, vendor-risk scans,
// policy-change trackers, company profiles
const NOT_TRIGGER_HOSTS = ['upguard.com', 'tostracker.app', 'comparably.com', 'crunchbase.com', 'zoominfo.com', 'rocketreach.co', 'pitchbook.com',
  'craft.co', 'owler.com', 'wikipedia.org', 'g2.com', 'capterra.com', 'securityscorecard.com', 'bitsight.com', 'glassdoor.com'];
const NOT_TRIGGER_PATH = /(^|\/)(privacy|privacy-policy|policy|policies|terms|terms-of-service|terms-of-use|legal|cookies?|tos|trust|security|product|products|platform|solutions|features|pricing|about|about-us|team|leadership|management|executive-team|customers|partners|resources|docs|documentation|help|support|faq)(\/|$)/;
const NOT_TRIGGER_TEXT = /\b(privacy policy|terms of (service|use)|cookie policy|product page|pricing page|security report|risk report|vendor risk|lists? [\p{L} .'-]{1,40} as)\b/iu;
const FILING_TEXT = /\b(10-k|10-q|8-k|s-1|20-f|6-k|def 14a|form d|filed with the (sec|securities and exchange commission)|sec filing|regulatory filing)\b/i;

/** Which trigger source a research row is, or null when it may only be context. Order: strong sources (filing host, wire,
 *  job board), then the never-a-trigger list, then news (news host, a news / press path, or a dated article url). */
export function triggerSource(url: string, text = ''): TriggerSource | null {
  if (!/^https:\/\//i.test(url)) return null;
  const h = host(url), p = path(url);
  if (!h) return null;
  if (onHost(h, FILING_HOSTS)) return 'filing';
  if (onHost(h, WIRE_HOSTS)) return 'press_release';
  if (onHost(h, JOB_HOSTS) || (h === 'linkedin.com' && p.startsWith('/jobs/'))) return 'job_post';
  if (onHost(h, NOT_TRIGGER_HOSTS) || NOT_TRIGGER_TEXT.test(text)) return null;
  if (onHost(h, NEWS_HOSTS)) return 'news';
  if (NOT_TRIGGER_PATH.test(p)) return null;
  if (/^(jobs|careers)\./.test(h) || /\/(careers|jobs)\/[^/]+/.test(p)) return 'job_post';
  if (/^(ir|investors?)\./.test(h) && /(sec-filings|financial-information|filings)/.test(p)) return 'filing';
  if (/\/(press-releases?|news-releases?|newsroom|pressroom|press)(\/|$)/.test(p) || (/^(ir|investors?)\./.test(h) && /news/.test(p))) return 'press_release';
  if (FILING_TEXT.test(text) && /\/(news|investors?|ir)\b/.test(p)) return 'filing';
  if (/\/(news|article|articles|story|stories)\//.test(p) || /\/20\d\d\/\d{2}\//.test(p)) return 'news';
  return null;
}

/** The ONE trigger judgment both buildBrief and checkBrief use (review #54): the fact is normalized exactly as the brief stores
 *  it (clean(fact, 500): dashes to commas, whitespace collapsed, capped), so build and check can never disagree on a row
 *  (a raw "privacy\npolicy" used to pass build as a trigger and then fail check). */
export const whyNowText = (fact: unknown) => clean(fact, 500);
export function judgeTrigger(url: string, fact: unknown): TriggerSource | null {
  return url ? triggerSource(url, whyNowText(fact)) : null;
}

export function priorityOf(title = ''): 'P1' | 'P2' | 'P3' {
  if (/\b(ciso|cio|cto|chief|vp|vice president|head)\b/i.test(title)) return 'P1';
  if (/\b(director|principal|lead)\b/i.test(title)) return 'P2';
  return 'P3';
}
function teamOf(title = ''): string {
  if (/secur|privacy|risk|compliance|grc|trust/i.test(title)) return 'Security and privacy';
  if (/data|analytics|ai|ml|machine learning/i.test(title)) return 'Data and AI';
  if (/engineer|platform|architect|infrastructure|cto|devops/i.test(title)) return 'Engineering';
  return 'Other';
}

export function buildBrief(c: BriefIn, today = new Date()): Brief {
  if (!c.account?.id) throw new Error('no account');
  const rb = c.person.research_brief ?? {};
  const company = clean(c.account.company ?? c.person.company ?? 'the account', 120);
  const rows = c.research.filter((r) => clean(r.fact, 10));
  const all = rows.map((r) => {
    const url = /^https:\/\//i.test(r.source_url ?? '') ? String(r.source_url) : '';
    const date = isoDate(r.dated);
    const age = date ? (today.getTime() - Date.parse(date)) / 864e5 : NaN;
    const fresh = !!date && age >= -2 && age <= TRIGGER_DAYS;
    const text = whyNowText(r.fact);
    const src = judgeTrigger(url, text);
    return { row: { date, kind: fresh && src ? 'trigger' : 'context', label: url && date ? 'Verified' : 'Inference', text, url }, src };
  });
  // triggers first (newest first), then context in research order; the brief keeps 6
  const trig = all.filter((x) => x.row.kind === 'trigger').sort((a, b) => b.row.date.localeCompare(a.row.date));
  const picked = [...trig, ...all.filter((x) => x.row.kind !== 'trigger')].slice(0, 6);
  const why_now = picked.map((x) => x.row);
  if (!why_now.length) throw new Error('no research rows');
  const thesis = clean(rb.summary, 1200) || clean(`${company}: ${why_now[0].text}`, 1200);
  const angles = (rb.angles ?? []).map((a) => clean(a, 300)).filter(Boolean);
  const groups = new Map<string, Any[]>();
  for (const p of c.people.slice(0, 12)) {
    const t = teamOf(p.title);
    groups.set(t, [...(groups.get(t) ?? []), { person_id: p.person_id, name: clean(p.name, 120), title: clean(p.title, 160),
      priority: priorityOf(p.title), role: p.person_id === c.person.id ? 'Accepted contact' : 'Contact on file', objection: '', answer: '', why: '' }]);
  }
  const committee = [...groups].map(([team, people]) => ({ team, who: people.map((x: Any) => x.title).filter(Boolean).slice(0, 3).join(', '),
    moves: '', people }));
  const top = why_now[0];
  const topSrc = picked[0].src;
  const why = top.kind === 'trigger'
    ? `${top.label} trigger (${String(topSrc).replace('_', ' ')}) dated ${top.date}.`
    : `No dated news, filing, press release or job post found; ${top.label} context${top.date ? ' dated ' + top.date : ''}.`;
  return {
    account_id: c.account.id, thesis, why_now, committee, angle: angles[0] ?? '',
    soft_angles: angles.slice(1, 4).map((text) => ({ kind: 'role_pain', text })),
    quick_check: [{ id: 'qc1', kind: 'choice', q: `Lead DM1 with this: "${clean(top.text, 160)}"?`,
      options: ['Yes, lead with it', 'No, use the role angle'], answer: top.kind === 'trigger' ? 0 : 1, why }],
  };
}

/** brief_upsert.py check(), server version (sequences are not built server-side yet, so that rule is not applied). */
export function checkBrief(b: Brief): string[] {
  const errs: string[] = [];
  for (const k of ['account_id', 'thesis', 'why_now', 'committee', 'quick_check'] as const) {
    const v = b[k] as unknown; if (!v || (Array.isArray(v) && !v.length)) errs.push('missing ' + k);
  }
  const t = JSON.stringify(b);
  for (const w of BAD) if (t.includes(w)) errs.push('contains ' + JSON.stringify(w));
  const qc = b.quick_check ?? [];
  if (qc.length < 1 || qc.length > 2) errs.push('quick_check needs 1 or 2 items');
  for (const i of qc) if (!Number.isInteger(i.answer) || i.answer < 0 || i.answer >= (i.options ?? []).length) errs.push('quick_check answer out of range: ' + i.id);
  for (const w of b.why_now ?? []) {
    if (!['Verified', 'Inference', 'Hypothesis'].includes(w.label)) errs.push('why_now label must be Verified/Inference/Hypothesis');
    if (w.label === 'Verified' && w.kind === 'trigger' && !(w.url && w.date)) errs.push('a Verified trigger needs a date and a url');
    if (w.kind === 'trigger' && !(w.date && w.url && judgeTrigger(w.url, w.text ?? ''))) {
      errs.push('a trigger must be dated news, a filing, a press release or a job post: ' + String(w.url || w.text).slice(0, 80));
    }
    if (w.url && !/^https:\/\//.test(w.url)) errs.push('url must be https');
  }
  return errs;
}

/** What DM1 may read from the brief (short; the drafter still gets the full research rows through its own context). */
export function briefForDraft(b: Pick<Brief, 'thesis' | 'angle' | 'why_now'>) {
  return { thesis: b.thesis, angle: b.angle, why_now: b.why_now.slice(0, 3).map((w) => ({ text: w.text, date: w.date, label: w.label, url: w.url })) };
}
