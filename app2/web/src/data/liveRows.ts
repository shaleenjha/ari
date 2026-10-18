// Production row shapes (native/supabase/migrations 0001 to 0036, schema `public`, every tenant table carries workspace_id)
// and the pure mappers from them to the app2 domain types. No I/O here; live.ts does the bounded reads.
import type { Account, AccountStage, Activity, Brief, BriefClaim, HygieneFinding, Person, PersonStage, Reply, Task, WeekReport } from './types';
import { acceptToDm1Median } from './domain';
import { toFinding, type HygieneRow } from './rows';

/** The workspace clock. app.workspaces.timezone is not readable from the client yet (see the 0037 notes). */
export const WORKSPACE_TZ = 'Asia/Kolkata';

export interface ProdPerson {
  id: string; workspace_id?: string; account_id?: string | null; company?: string | null; name: string; title?: string | null;
  linkedin_url?: string | null; stage: string; connect_day?: string | null; connect_sent?: string | null; accepted?: string | null;
  dm1_sent?: string | null; dm2_due?: string | null; dm2_sent?: string | null; dm3_due?: string | null; dm3_sent?: string | null;
  replied?: string | null; meeting?: string | null; withdrawn?: string | null; review?: string | null; lane?: string | null;
  route?: string | null; deleted_at?: string | null; dm?: string | null; dm2_text?: string | null; dm3_text?: string | null;
  /** Columns whose time is a backfill placeholder (the day is known, the time is not). */
  ts_approx?: string[] | null;
}
export interface ProdAccount {
  id: string; workspace_id?: string; company: string; one_liner?: string | null; hook?: string | null; stage?: string | null;
  stage_override?: boolean | null; meeting_status?: string | null; deleted_at?: string | null;
}
export interface ProdReply {
  id: number; workspace_id?: string; person_id: string; account_id?: string | null; received_at: string; snippet?: string | null;
  headline?: string | null; status: 'new' | 'answered' | 'meeting' | 'dismissed'; drafts?: { key?: string; label?: string; body?: string }[] | null;
  people?: { name?: string | null; company?: string | null; review?: string | null; deleted_at?: string | null } | null;
}
export interface ProdBrief { account_id: string; status: 'queued' | 'building' | 'ready'; thesis?: string | null; angle?: string | null;
  why_now?: { text?: string; label?: string }[] | null }
export interface ProdLog { id: number; ts: string; person_id?: string | null; event: string; source?: string | null }
export interface ProdFinding { id: string; check_key: HygieneFinding['check']; entity_type: 'person' | 'account'; entity_id: string;
  status: 'open' | 'dismissed' | 'fixed' | 'gone'; first_seen: string; detail?: Record<string, unknown> | null }

const PERSON_STAGE: Record<string, PersonStage> = {
  'connect queued': 'connect_queued', 'connect sent': 'connect_sent', accepted: 'accepted', 'dm1 sent': 'dm1_sent',
  'dm2 sent': 'dm2_sent', 'dm3 sent': 'dm3_sent', replied: 'replied', meeting: 'meeting_set', 'meeting set': 'meeting_set',
  'meeting held': 'meeting_held', withdrawn: 'withdrawn', hold: 'hold', founder: 'hold',
};
export const personStage = (s: string): PersonStage => PERSON_STAGE[s.trim().toLowerCase()] ?? 'hold';

const ACCOUNT_STAGE: Record<string, AccountStage> = {
  target: 'target', researching: 'researching', mapped: 'mapped', engaged: 'engaged', 'meeting set': 'meeting_set',
  'meeting held': 'meeting_held', 'opportunity created': 'opportunity', opportunity: 'opportunity', hold: 'hold',
  customer: 'customer', 'closed lost': 'closed_lost', closed: 'closed_lost', 'not a fit': 'not_a_fit',
};
export const accountStage = (s?: string | null): AccountStage => ACCOUNT_STAGE[(s ?? '').trim().toLowerCase()] ?? 'target';

const u = <T,>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

/** Owner's own leads: not deleted, not marked personal. */
export const isLead = (p: Pick<ProdPerson, 'deleted_at' | 'review'>): boolean => !p.deleted_at && (p.review ?? 'lead') !== 'personal';

export const prodPerson = (r: ProdPerson): Person => ({
  id: r.id, accountId: u(r.account_id), fullName: r.name, title: u(r.title), linkedinUrl: u(r.linkedin_url), stage: personStage(r.stage),
  connectSentAt: u(r.connect_sent), acceptedAt: u(r.accepted), dm1SentAt: u(r.dm1_sent), dm2Due: u(r.dm2_due), dm2SentAt: u(r.dm2_sent),
  dm3Due: u(r.dm3_due), dm3SentAt: u(r.dm3_sent), repliedAt: u(r.replied), withdrawnAt: u(r.withdrawn),
});

export const prodAccount = (r: ProdAccount): Account => ({
  id: r.id, name: r.company, stage: accountStage(r.stage), stagePinned: !!r.stage_override, oneLiner: u(r.one_liner), hook: u(r.hook),
});

export function prodReply(r: ProdReply): Reply {
  const who = r.people?.name ?? 'Someone';
  const at = r.people?.company ? ` at ${r.people.company}` : '';
  const snippet = r.snippet?.trim() || `${who}${at} replied. The message is in your LinkedIn inbox.`;
  return { id: String(r.id), personId: r.person_id, snippet, receivedAt: r.received_at, status: r.status === 'new' ? 'open' : r.status === 'dismissed' ? 'not_now' : r.status };
}

/** Ari's reply drafts are stored on the reply (exactly 3: book, answer, soft). The answer is the pick. */
export function replyDraftBody(r: Pick<ProdReply, 'drafts'>): string | null {
  const d = r.drafts ?? [];
  return (d.find((x) => x.key === 'answer') ?? d[0])?.body?.trim() || null;
}

const LABEL: Record<string, BriefClaim['label']> = { verified: 'verified', inference: 'inference', hypothesis: 'hypothesis' };
export const prodBrief = (r: ProdBrief): Brief => ({
  accountId: r.account_id, status: r.status, thesis: u(r.thesis), angle: u(r.angle),
  whyNow: (r.why_now ?? []).flatMap((c) => (c.text ? [{ text: c.text, label: LABEL[(c.label ?? '').toLowerCase()] ?? 'hypothesis' }] : [])),
});

export const prodActivity = (r: ProdLog): Activity => ({
  id: r.id, actorKind: r.source === 'hark' ? 'ari' : r.source === 'backfill' ? 'system' : 'sdr',
  verb: r.event.toLowerCase().replace(/\s+/g, '_'), subjectType: 'person', subjectId: u(r.person_id), createdAt: r.ts,
});

export function prodFinding(r: ProdFinding): HygieneFinding {
  const d = (r.detail ?? {}) as Record<string, unknown>;
  const str = (k: string) => (typeof d[k] === 'string' ? (d[k] as string) : undefined);
  const s = d.suggestion as { id?: unknown; name?: unknown } | undefined;
  const suggestion = s && typeof s.id === 'string' && typeof s.name === 'string' ? { id: s.id, name: s.name } : undefined;
  const row: HygieneRow = { workspace_id: '', id: r.id, check_key: r.check_key, entity_type: r.entity_type, entity_id: r.entity_id, status: r.status,
    first_seen: r.first_seen, detail: { label: str('label') ?? str('name') ?? str('company'), note: str('note'), suggestion } };
  return toFinding(row);
}

/** YYYY-MM-DD in the workspace clock. */
export function dayIn(at: Date, tz = WORKSPACE_TZ): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** Monday 00:00 of the workspace week containing `at`, as an ISO instant (the same week weekly_metrics uses). */
export function weekStart(at: Date, tz = WORKSPACE_TZ): string {
  const day = dayIn(at, tz);
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12));
  const back = (noonUtc.getUTCDay() + 6) % 7;
  const monday = new Date(Date.UTC(y, m - 1, d - back));
  // offset of tz at that Monday: format the UTC midnight in tz and measure the difference
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(monday).reduce<Record<string, string>>((a, p) => ({ ...a, [p.type]: p.value }), {});
  const asTz = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(monday.getTime() - (asTz - monday.getTime())).toISOString();
}

const addDays = (day: string, n: number): string => {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

/**
 * Today's queue, derived from people's dates (production has no task rows for the SDR yet): DM1 for every accept without
 * one, DM2 / DM3 when due, and an answer for every open reply. Ready now = due today or late; up next = due tomorrow.
 */
export function deriveQueue(people: ProdPerson[], replies: ProdReply[], now: Date): Task[] {
  const today = dayIn(now); const tomorrow = addDays(today, 1);
  const out: Task[] = [];
  const task = (p: ProdPerson, key: string, kind: Task['kind'], title: string, due: string | undefined, ready: boolean): Task => ({
    id: `${p.id}:${key}`, kind, title, status: ready ? 'ready' : 'todo', assigneeRole: 'sdr', accountId: u(p.account_id), personId: p.id,
    dueAt: due, version: 0, createdByKind: 'ari' });
  const answered = new Set(replies.map((r) => r.person_id));
  for (const p of people.filter(isLead)) {
    if (p.replied || p.withdrawn || answered.has(p.id)) continue;
    if (p.accepted && !p.dm1_sent) out.push(task(p, 'dm1', 'dm', `Send DM1 to ${p.name}`, p.accepted, true));
    else if (p.dm1_sent && !p.dm2_sent && p.dm2_due && p.dm2_due <= tomorrow) out.push(task(p, 'dm2', 'follow_up', `Send DM2 to ${p.name}`, p.dm2_due, p.dm2_due <= today));
    else if (p.dm2_sent && !p.dm3_sent && p.dm3_due && p.dm3_due <= tomorrow) out.push(task(p, 'dm3', 'follow_up', `Send DM3 to ${p.name}`, p.dm3_due, p.dm3_due <= today));
  }
  for (const r of replies) {
    if (r.status !== 'new' || !isLead(r.people ?? {})) continue;
    const name = r.people?.name ?? 'a reply';
    out.push({ id: `reply:${r.id}`, kind: 'reply', title: `Answer ${name}`, status: 'ready', assigneeRole: 'sdr', accountId: u(r.account_id),
      personId: r.person_id, dueAt: r.received_at, version: 0, createdByKind: 'ari' });
  }
  const rank = (t: Task) => (t.status === 'ready' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (a.dueAt ?? '').localeCompare(b.dueAt ?? '')).slice(0, 30);
}

/**
 * This week's Report, from people's own dates (one per person). log_entries is not used for counts: the Oct 15 backfill
 * wrote a "Connect sent" / "Accepted" row for every historical event at import time, so the log counts all time.
 * Window: [from, now] in the workspace clock (Asia/Kolkata, hard coded until the workspace timezone is readable).
 * Accept to DM1: median hours over this week's accepts that have a DM1, skipping people whose accepted or dm1_sent time
 * is a backfill placeholder (`ts_approx`: day known, time set to noon), since those hours are not real. Null when none.
 * Meetings: production has no Ari attribution for meetings, so this counts every meeting this week (people.meeting plus
 * "Meeting" / "Meeting set" log events, one per person) and says so (meetingsFromAri false, no goal stored).
 */
export function weekFromPeople(people: WeekPerson[], meetingLog: Pick<ProdLog, 'id' | 'ts' | 'person_id' | 'event'>[], from: string, now: Date): WeekReport {
  const lo = Date.parse(from); const hi = now.getTime();
  const inWeek = (v?: string | null) => { if (!v) return false; const t = Date.parse(v); return t >= lo && t <= hi; };
  const byId = new Map<string, WeekPerson>();
  for (const p of people) if (isLead(p)) byId.set(p.id, p);
  const leads = [...byId.values()];
  const count = (col: 'connect_sent' | 'accepted' | 'replied') => leads.filter((p) => inWeek(p[col])).length;
  const exact = leads.filter((p) => inWeek(p.accepted) && p.dm1_sent && !(p.ts_approx ?? []).some((c) => c === 'accepted' || c === 'dm1_sent'));
  const median = acceptToDm1Median(exact.map((p) => ({ id: p.id, fullName: '', stage: 'accepted', acceptedAt: u(p.accepted), dm1SentAt: u(p.dm1_sent) })));
  const met = new Set<string>(leads.filter((p) => inWeek(p.meeting)).map((p) => `p:${p.id}`));
  for (const l of meetingLog) {
    if (!inWeek(l.ts) || !['Meeting', 'Meeting set'].includes(l.event)) continue;
    if (l.person_id && !byId.has(l.person_id) && people.some((p) => p.id === l.person_id)) continue;   // personal or deleted
    met.add(l.person_id ? `p:${l.person_id}` : `l:${l.id}`);
  }
  return { meetings: met.size, meetingsFromAri: false, meetingsGoal: null, replies: count('replied'), accepts: count('accepted'),
    connects: count('connect_sent'), acceptToDm1MedianHours: median };
}

export type WeekPerson = Pick<ProdPerson, 'id' | 'connect_sent' | 'accepted' | 'dm1_sent' | 'replied' | 'meeting' | 'review' | 'deleted_at' | 'ts_approx'>;
