// Nightly shadow comparison (job kind 'gmail-shadow-diff'): parser ingest rows vs what the current worker recorded.
// Schema-level: worker records mirror the prod columns the LLM worker writes today (people.accepted_at + ts_approx,
// replies.gmail_id / person_id / received_at / matched_by). Output is a versioned report (ari.shadow-diff/v1) that is stored
// via app.shadow_report_put and rendered as markdown for the Council / ops view. Synthetic data only in tests.
import type { IngestRow } from './handler';

/** Prod people row, only the columns the comparison needs. accepted_approx = day-granular time (ts_approx in prod). */
export interface WorkerPersonRecord { personId: string; acceptedAt?: string; acceptedApprox?: boolean; repliedAt?: string }
/** Prod replies row. */
export interface WorkerReplyRecord { id: string; personId?: string; gmailId?: string; receivedAt: string; matchedBy?: string }

export type DiffStatus = 'match' | 'time_mismatch' | 'missing_in_parser' | 'extra_in_parser' | 'person_mismatch' | 'unmatched';
export interface DiffItem {
  kind: 'accept' | 'reply'; status: DiffStatus; personId?: string; parserPersonId?: string; sourceMsgId?: string; workerReplyId?: string;
  parserAt?: string; workerAt?: string; deltaMinutes?: number; note?: string;
}
export interface ShadowReport {
  schema: 'ari.shadow-diff/v1'; workspaceId: string; night: string; window: { from: string; to: string }; generatedAt: string;
  counts: Record<DiffStatus, number>; agree: boolean; items: DiffItem[];
  rules: { exactToleranceMin: number; approxDayZone: string; maxUnmatched: number };
}
export interface ShadowOptions { exactToleranceMin?: number; approxDayZone?: string; maxUnmatched?: number; generatedAt?: string }

const DAY_FMT = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
const inWindow = (iso: string | undefined, w: { from: string; to: string }) => !!iso && Date.parse(iso) >= Date.parse(w.from) && Date.parse(iso) < Date.parse(w.to);
const minutes = (a: string, b: string) => Math.round((Date.parse(a) - Date.parse(b)) / 60000);

export function compareShadow(workspaceId: string, night: string, window: { from: string; to: string }, rows: IngestRow[],
  people: WorkerPersonRecord[], replies: WorkerReplyRecord[], o: ShadowOptions = {}): ShadowReport {
  const tol = o.exactToleranceMin ?? 10; const zone = o.approxDayZone ?? 'Asia/Kolkata'; const maxUnmatched = o.maxUnmatched ?? 1;
  const day = DAY_FMT(zone);
  const sameDay = (a: string, b: string) => day.format(new Date(a)) === day.format(new Date(b));
  const items: DiffItem[] = [];
  const shadow = rows.filter((r) => r.workspaceId === workspaceId && inWindow(r.receivedAt, window));

  // accepts: parser (matched) vs people.accepted_at in the window
  const pAccept = new Map<string, IngestRow>();
  for (const r of shadow.filter((x) => x.kind === 'accept')) {
    if (!r.matchedPersonId) { items.push({ kind: 'accept', status: 'unmatched', sourceMsgId: r.sourceMsgId, parserAt: r.receivedAt, note: r.parsed.name }); continue; }
    const prev = pAccept.get(r.matchedPersonId);
    if (!prev || Date.parse(r.receivedAt) < Date.parse(prev.receivedAt)) pAccept.set(r.matchedPersonId, r);   // first accept email wins, like person_mark
  }
  const wAccept = new Map(people.filter((p) => inWindow(p.acceptedAt, window)).map((p) => [p.personId, p]));
  for (const [pid, r] of pAccept) {
    const w = wAccept.get(pid) ?? people.find((p) => p.personId === pid && p.acceptedAt);
    if (!w?.acceptedAt) { items.push({ kind: 'accept', status: 'extra_in_parser', personId: pid, sourceMsgId: r.sourceMsgId, parserAt: r.receivedAt }); continue; }
    const ok = w.acceptedApprox ? sameDay(r.receivedAt, w.acceptedAt) : Math.abs(minutes(r.receivedAt, w.acceptedAt)) <= tol;
    items.push({ kind: 'accept', status: ok ? 'match' : 'time_mismatch', personId: pid, sourceMsgId: r.sourceMsgId, parserAt: r.receivedAt,
      workerAt: w.acceptedAt, deltaMinutes: minutes(r.receivedAt, w.acceptedAt), note: w.acceptedApprox ? 'worker time is day-granular' : undefined });
  }
  for (const [pid, w] of wAccept) if (!pAccept.has(pid)) items.push({ kind: 'accept', status: 'missing_in_parser', personId: pid, workerAt: w.acceptedAt });

  // replies: join on Gmail id first, then person + time
  const pReply = shadow.filter((x) => x.kind === 'reply');
  const wReply = replies.filter((x) => inWindow(x.receivedAt, window));
  const usedW = new Set<string>();
  for (const r of pReply) {
    let w = wReply.find((x) => x.gmailId && x.gmailId === r.sourceMsgId);
    if (!w && r.matchedPersonId) w = wReply.find((x) => !usedW.has(x.id) && !x.gmailId && x.personId === r.matchedPersonId && Math.abs(minutes(r.receivedAt, x.receivedAt)) <= tol);
    if (w) usedW.add(w.id);
    if (!r.matchedPersonId) {
      items.push({ kind: 'reply', status: 'unmatched', sourceMsgId: r.sourceMsgId, parserAt: r.receivedAt, workerReplyId: w?.id, personId: w?.personId, note: r.parsed.name });
      continue;
    }
    if (!w) { items.push({ kind: 'reply', status: 'extra_in_parser', personId: r.matchedPersonId, sourceMsgId: r.sourceMsgId, parserAt: r.receivedAt }); continue; }
    if (w.personId && w.personId !== r.matchedPersonId) {
      items.push({ kind: 'reply', status: 'person_mismatch', personId: w.personId, parserPersonId: r.matchedPersonId, sourceMsgId: r.sourceMsgId, workerReplyId: w.id,
        parserAt: r.receivedAt, workerAt: w.receivedAt });
      continue;
    }
    const d = minutes(r.receivedAt, w.receivedAt);
    items.push({ kind: 'reply', status: Math.abs(d) <= tol ? 'match' : 'time_mismatch', personId: r.matchedPersonId, sourceMsgId: r.sourceMsgId,
      workerReplyId: w.id, parserAt: r.receivedAt, workerAt: w.receivedAt, deltaMinutes: d });
  }
  for (const w of wReply) if (!usedW.has(w.id)) items.push({ kind: 'reply', status: 'missing_in_parser', personId: w.personId, workerReplyId: w.id, workerAt: w.receivedAt });

  const counts = { match: 0, time_mismatch: 0, missing_in_parser: 0, extra_in_parser: 0, person_mismatch: 0, unmatched: 0 } as Record<DiffStatus, number>;
  for (const i of items) counts[i.status]++;
  const order: Record<DiffStatus, number> = { person_mismatch: 0, missing_in_parser: 1, extra_in_parser: 2, time_mismatch: 3, unmatched: 4, match: 5 };
  items.sort((a, b) => order[a.status] - order[b.status] || (a.parserAt ?? a.workerAt ?? '').localeCompare(b.parserAt ?? b.workerAt ?? ''));
  const agree = counts.missing_in_parser + counts.extra_in_parser + counts.person_mismatch + counts.time_mismatch === 0 && counts.unmatched <= maxUnmatched;
  return { schema: 'ari.shadow-diff/v1', workspaceId, night, window, generatedAt: o.generatedAt ?? new Date().toISOString(), counts, agree, items,
    rules: { exactToleranceMin: tol, approxDayZone: zone, maxUnmatched } };
}

/** Same rule as app.shadow_promotion_ready: last 3 consecutive nights agree, unmatched <= 1 each. */
export function promotionReady(history: Array<{ night: string; agree: boolean; unmatched: number }>): boolean {
  const last = [...history].sort((a, b) => b.night.localeCompare(a.night)).slice(0, 3);
  if (last.length < 3 || !last.every((n) => n.agree && n.unmatched <= 1)) return false;
  const d = (s: string) => Date.parse(`${s}T00:00:00Z`) / 864e5;
  return d(last[0]!.night) - d(last[2]!.night) === 2;
}

/** Markdown view of a report (no prospect names: person ids and Gmail ids only, so it can sit in logs and CI artefacts). */
export function renderShadowReport(r: ShadowReport): string {
  const c = r.counts;
  const lines = [
    `# Shadow diff ${r.night} (${r.agree ? 'AGREE' : 'DISAGREE'})`,
    `workspace ${r.workspaceId} · window ${r.window.from} to ${r.window.to} · ${r.schema}`,
    '',
    `| match | time mismatch | missing in parser | extra in parser | person mismatch | unmatched |`,
    `|---|---|---|---|---|---|`,
    `| ${c.match} | ${c.time_mismatch} | ${c.missing_in_parser} | ${c.extra_in_parser} | ${c.person_mismatch} | ${c.unmatched} |`,
  ];
  const off = r.items.filter((i) => i.status !== 'match');
  if (off.length) {
    lines.push('', '| kind | status | person | gmail id | parser at | worker at | delta min |', '|---|---|---|---|---|---|---|');
    for (const i of off) lines.push(`| ${i.kind} | ${i.status} | ${i.parserPersonId ? `${i.personId ?? '?'} vs ${i.parserPersonId}` : (i.personId ?? '')} | ${i.sourceMsgId ?? ''} | ${i.parserAt ?? ''} | ${i.workerAt ?? ''} | ${i.deltaMinutes ?? ''} |`);
  }
  lines.push('', `Rules: exact times within ${r.rules.exactToleranceMin} min; day-granular worker times compared by day in ${r.rules.approxDayZone}; agree needs zero mismatches and unmatched <= ${r.rules.maxUnmatched}.`);
  return lines.join('\n');
}

/** Runtime handler for 'gmail-shadow-diff' (payload: { night, from, to }). */
export function shadowDiffHandler(deps: {
  rows: (ws: string, from: string, to: string) => Promise<IngestRow[]>;
  worker: (ws: string, from: string, to: string) => Promise<{ people: WorkerPersonRecord[]; replies: WorkerReplyRecord[] }>;
  put: (ws: string, night: string, report: ShadowReport) => Promise<void>;
}) {
  return async (job: { workspaceId: string; payload: unknown }) => {
    const p = job.payload as { night?: string; from?: string; to?: string };
    if (!p?.night || !p.from || !p.to) throw new Error('payload.night/from/to required');
    const w = await deps.worker(job.workspaceId, p.from, p.to);
    const report = compareShadow(job.workspaceId, p.night, { from: p.from, to: p.to }, await deps.rows(job.workspaceId, p.from, p.to), w.people, w.replies);
    await deps.put(job.workspaceId, p.night, report);
    return { agree: report.agree, counts: report.counts };
  };
}
