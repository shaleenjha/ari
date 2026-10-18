// Typed mirror of the app2 schema (app2/db/migrations). Hand-written until `supabase gen types` runs against an app2 project.
export type Uuid = string;
export type Role = 'admin' | 'manager' | 'ae' | 'sdr' | 'agent';
export type ActorKind = 'ari' | 'sdr' | 'ae' | 'manager' | 'admin' | 'system';
export type AccountStage = 'target' | 'researching' | 'mapped' | 'engaged' | 'meeting_set' | 'meeting_held'
  | 'opportunity' | 'hold' | 'customer' | 'closed_lost' | 'not_a_fit';
export type PersonStage = 'connect_queued' | 'connect_sent' | 'accepted' | 'dm1_sent' | 'dm2_sent' | 'dm3_sent'
  | 'replied' | 'meeting_set' | 'meeting_held' | 'withdrawn' | 'hold';
export type TaskStatus = 'proposed' | 'todo' | 'ready' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type TaskKind = 'connect' | 'dm' | 'follow_up' | 'reply' | 'research' | 'brief' | 'meeting_prep'
  | 'map_account' | 'ask' | 'handoff' | 'review_draft' | 'hygiene' | 'custom';
export type MarkField = 'connect_sent' | 'accepted' | 'dm1_sent' | 'dm2_sent' | 'dm3_sent' | 'replied' | 'withdrawn';
export type SendWindow = 'ET' | 'CT' | 'PT';

export interface Workspace { id: Uuid; name: string; timezone: string }
export interface Member { workspaceId: Uuid; userId: Uuid; role: Role; displayName: string }
export interface Account {
  id: Uuid; name: string; domain?: string; stage: AccountStage; stagePinned: boolean;
  aeUserId?: Uuid; oneLiner?: string; hook?: string; window?: SendWindow;
}
export interface Person {
  id: Uuid; accountId?: Uuid; fullName: string; title?: string; linkedinUrl?: string; stage: PersonStage;
  connectSentAt?: string; acceptedAt?: string; dm1SentAt?: string; dm2Due?: string; dm2SentAt?: string;
  dm3Due?: string; dm3SentAt?: string; repliedAt?: string; withdrawnAt?: string; score?: number;
}
export interface Draft { personId: Uuid; kind: 'dm1' | 'dm2' | 'dm3' | 'reply'; body: string; authorKind: ActorKind }
export interface Reply { id: Uuid; personId?: Uuid; snippet: string; receivedAt: string; status: 'open' | 'answered' | 'meeting' | 'not_now' }
export interface BriefClaim { text: string; label: 'verified' | 'inference' | 'hypothesis' }
export interface Brief { accountId: Uuid; status: 'queued' | 'building' | 'ready' | 'reviewed'; thesis?: string; whyNow: BriefClaim[]; angle?: string }
export interface Task {
  id: Uuid; kind: TaskKind; title: string; status: TaskStatus; assigneeRole: Role; assigneeUserId?: Uuid;
  accountId?: Uuid; personId?: Uuid; dueAt?: string; version: number; createdByKind: ActorKind;
}
export interface Activity { id: number; actorKind: ActorKind; verb: string; subjectType: string; subjectId?: Uuid; createdAt: string }
/**
 * This week's numbers (Monday 00:00 in the workspace clock to now). `meetingsFromAri` says whether `meetings` counts only
 * meetings Ari's outreach produced; when the data cannot tell, it is false and the tile says "Meetings this week".
 * `meetingsGoal` is null when no goal is stored.
 */
export interface WeekReport { meetings: number; meetingsFromAri: boolean; meetingsGoal: number | null; replies: number; accepts: number; connects: number;
  acceptToDm1MedianHours: number | null }

export interface CommandResult { ok: boolean; conflict?: boolean; version?: number; status?: TaskStatus }

// Data hygiene (Ari's "Tidy up" checks; mirrors prod 0029 / app.hygiene_findings) and gmail-ingest "Who is this?".
export type HygieneCheck = 'accept_no_connect' | 'duplicate_account' | 'no_account_link' | 'stale_stage' | 'dm1_past_due';
export type HygieneAction = 'tick_connect' | 'link' | 'merge' | 'dismiss';
export interface HygieneFinding {
  id: Uuid; check: HygieneCheck; entityType: 'person' | 'account'; entityId: Uuid; title: string; detail?: string;
  actions: HygieneAction[]; suggestion?: { id: Uuid; name: string };          // link target, or the duplicate to merge with
}
export interface WhoCandidate { personId: Uuid; fullName: string; title?: string; accountName?: string }
export interface WhoIsThis { eventId: Uuid; kind: 'accept' | 'reply'; name: string; headline?: string; at: string; candidates: WhoCandidate[] }
