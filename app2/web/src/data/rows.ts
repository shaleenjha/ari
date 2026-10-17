// Row shapes as PostgREST returns them from the app2 schema (snake_case, schema `app`), and the mappers to the typed domain.
import type { Account, Activity, Brief, Draft, HygieneAction, HygieneFinding, Person, Reply, Task, WhoIsThis } from './types';

export interface AccountRow { workspace_id: string; id: string; name: string; domain?: string | null; stage: Account['stage']; stage_pinned: boolean;
  one_liner?: string | null; hook?: string | null; send_window?: Account['window'] | null; ae_user_id?: string | null }
export interface PersonRow { workspace_id: string; id: string; account_id?: string | null; full_name: string; title?: string | null; linkedin_url?: string | null;
  stage: Person['stage']; score?: number | null; connect_sent_at?: string | null; accepted_at?: string | null; dm1_sent_at?: string | null; dm2_due?: string | null;
  dm2_sent_at?: string | null; dm3_due?: string | null; dm3_sent_at?: string | null; replied_at?: string | null; withdrawn_at?: string | null }
export interface TaskRow { workspace_id: string; id: string; kind: Task['kind']; title: string; status: Task['status']; assignee_role: Task['assigneeRole'];
  assignee_user_id?: string | null; account_id?: string | null; person_id?: string | null; due_at?: string | null; version: number; created_by_kind: Task['createdByKind'] }
export interface ReplyRow { workspace_id: string; id: string; person_id?: string | null; snippet: string; received_at: string; status: Reply['status'] }
export interface BriefRow { workspace_id: string; account_id: string; status: Brief['status']; body: { thesis?: string; why_now?: Brief['whyNow']; angle?: string } }
export interface DraftRow { workspace_id: string; person_id: string; kind: Draft['kind']; body: string; author_kind: Draft['authorKind'] }
export interface ActivityRow { workspace_id: string; id: number; actor_kind: Activity['actorKind']; verb: string; subject_type: string; subject_id?: string | null; created_at: string }
export interface HygieneRow { workspace_id: string; id: string; check_key: HygieneFinding['check']; entity_type: 'person' | 'account'; entity_id: string;
  status: 'open' | 'dismissed' | 'fixed' | 'gone'; first_seen: string;
  detail: { label?: string; note?: string; suggestion?: { id: string; name: string } } }
export interface IngestRowDb { workspace_id: string; id: string; kind: 'accept' | 'reply' | 'invite_sent' | 'unknown'; match_method: string;
  matched_person_id?: string | null; mode: 'shadow' | 'live'; received_at: string;
  parsed: { name?: string; headline?: string; company?: string; candidates?: string[] } }

const u = <T,>(v: T | null | undefined): T | undefined => (v == null ? undefined : v);

export const toAccount = (r: AccountRow): Account => ({ id: r.id, name: r.name, domain: u(r.domain), stage: r.stage, stagePinned: r.stage_pinned,
  oneLiner: u(r.one_liner), hook: u(r.hook), window: u(r.send_window), aeUserId: u(r.ae_user_id) });
export const toPerson = (r: PersonRow): Person => ({ id: r.id, accountId: u(r.account_id), fullName: r.full_name, title: u(r.title), linkedinUrl: u(r.linkedin_url),
  stage: r.stage, score: u(r.score), connectSentAt: u(r.connect_sent_at), acceptedAt: u(r.accepted_at), dm1SentAt: u(r.dm1_sent_at), dm2Due: u(r.dm2_due),
  dm2SentAt: u(r.dm2_sent_at), dm3Due: u(r.dm3_due), dm3SentAt: u(r.dm3_sent_at), repliedAt: u(r.replied_at), withdrawnAt: u(r.withdrawn_at) });
export const toTask = (r: TaskRow): Task => ({ id: r.id, kind: r.kind, title: r.title, status: r.status, assigneeRole: r.assignee_role,
  assigneeUserId: u(r.assignee_user_id), accountId: u(r.account_id), personId: u(r.person_id), dueAt: u(r.due_at), version: r.version, createdByKind: r.created_by_kind });
export const toReply = (r: ReplyRow): Reply => ({ id: r.id, personId: u(r.person_id), snippet: r.snippet, receivedAt: r.received_at, status: r.status });
export const toBrief = (r: BriefRow): Brief => ({ accountId: r.account_id, status: r.status, thesis: r.body.thesis, whyNow: r.body.why_now ?? [], angle: r.body.angle });
export const toDraft = (r: DraftRow): Draft => ({ personId: r.person_id, kind: r.kind, body: r.body, authorKind: r.author_kind });
export const toActivity = (r: ActivityRow): Activity => ({ id: r.id, actorKind: r.actor_kind, verb: r.verb, subjectType: r.subject_type, subjectId: u(r.subject_id), createdAt: r.created_at });

const ACTIONS: Record<HygieneFinding['check'], HygieneAction[]> = {
  accept_no_connect: ['tick_connect', 'dismiss'], duplicate_account: ['merge', 'dismiss'], no_account_link: ['link', 'dismiss'],
  stale_stage: ['dismiss'], dm1_past_due: ['dismiss'],
};
const TITLES: Record<HygieneFinding['check'], string> = {
  accept_no_connect: 'Accepted, but the invite was never ticked', duplicate_account: 'Looks like the same company twice',
  no_account_link: 'Not linked to an account', stale_stage: 'Stage is behind the dates', dm1_past_due: 'DM1 is over 24 hours late',
};
export function toFinding(r: HygieneRow): HygieneFinding {
  const actions = ACTIONS[r.check_key].filter((a) => (a === 'link' || a === 'merge' ? !!r.detail.suggestion : true));
  return { id: r.id, check: r.check_key, entityType: r.entity_type, entityId: r.entity_id, title: TITLES[r.check_key],
    detail: [r.detail.label, r.detail.note].filter(Boolean).join(' · ') || undefined, actions, suggestion: r.detail.suggestion };
}
export function toWho(r: IngestRowDb, people: PersonRow[], accounts: AccountRow[]): WhoIsThis {
  const acc = new Map(accounts.map((a) => [a.id, a.name]));
  const cands = (r.parsed.candidates ?? []).map((id) => people.find((p) => p.id === id)).filter((p): p is PersonRow => !!p)
    .map((p) => ({ personId: p.id, fullName: p.full_name, title: u(p.title), accountName: p.account_id ? acc.get(p.account_id) : undefined }));
  return { eventId: r.id, kind: r.kind === 'reply' ? 'reply' : 'accept', name: r.parsed.name ?? 'Someone', headline: r.parsed.headline, at: r.received_at, candidates: cands };
}
