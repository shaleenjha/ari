// ari-ai (PENDING). Event path: accept -> classify (Haiku) -> pipeline research (0047; DM1 follows research + brief) -> "DM1 ready".
// Fired by ari-gmail-push right after a Gmail push, by the app's manual "Accepted" tap (action draft_dm1), and by the
// 10-minute cron as the fallback. Idempotent: ai_triggers ('accept', gmail msg id) and ('dm1', person id) are claimed
// once in the database before any model call, so a redelivered Pub/Sub message or an overlapping cron run does nothing.
import { Deps } from '../_shared/ai/run.ts';
import { BudgetRefused, safeErr } from '../_shared/ai/run.ts';
import { classifyAccept, draftDm1 } from './actions.ts';
import { copyCheck } from '../_shared/ai/copycheck.ts';
import { Db } from './db.ts';
import { enqueueResearch } from './pipeline.ts';

// deno-lint-ignore no-explicit-any
type Accept = { msg_id: string; name?: string | null; profile_url?: string | null; match?: string | null; candidates?: any[] };
export interface Pending { accepts: Accept[]; dm1_needed: string[] }

export async function dm1ForPerson(db: Db, deps: Deps, person: string, mode: 'dm1_auto' | 'manual'): Promise<string> {
  if (!(await db.rpc<boolean>('ari_ai_trigger_claim', { p_kind: 'dm1', p_ref: person }))) return 'duplicate';
  try {
    // same copy check gate as the pipeline DM1 (Oct 29 2026): one redraft on a failure; a draft that still fails is saved
    // needs_review and NOT announced as ready
    const r = await draftDm1(db, deps, person, mode, undefined, undefined, { check: (t) => copyCheck(t, 'dm1') });
    const status = r.saved ? (r.draft?.needs_review ? 'needs_review' : 'done') : 'skipped';
    await db.rpc('ari_ai_trigger_done', { p_kind: 'dm1', p_ref: person, p_status: status, p_detail: r.reason ?? (r.gate && !r.gate.pass ? 'copy check failed after redraft' : null) });
    if (r.saved && r.gate?.pass !== false) await db.rpc('ari_ai_notify_dm_ready', { p_person: person });
    return status;
  } catch (e) {
    await db.rpc('ari_ai_trigger_done', { p_kind: 'dm1', p_ref: person, p_status: 'error', p_detail: errMsg(e) }).catch(() => {});
    if (e instanceof BudgetRefused) return 'budget';
    return 'error';
  }
}

export async function processPending(db: Db, deps: Deps, limit = 10): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const bump = (k: string) => { out[k] = (out[k] ?? 0) + 1; };
  const p = await db.rpc<Pending>('ari_ai_pending_events', { p_limit: limit });
  const people = new Set<string>();
  for (const ev of p?.accepts ?? []) {
    if (!(await db.rpc<boolean>('ari_ai_trigger_claim', { p_kind: 'accept', p_ref: ev.msg_id }))) { bump('accept_duplicate'); continue; }
    try {
      const m = await classifyAccept(deps, ev);
      if (!m.personId) {
        await db.rpc('ari_ai_trigger_done', { p_kind: 'accept', p_ref: ev.msg_id, p_status: 'needs_review',
          p_detail: ev.match ? 'model disagreed with the match' : 'no confident match' });
        bump('accept_unmatched'); continue;
      }
      await db.rpc('ari_ai_trigger_done', { p_kind: 'accept', p_ref: ev.msg_id, p_status: 'done', p_detail: m.personId });
      people.add(m.personId); bump('accept_matched');
    } catch (e) {
      await db.rpc('ari_ai_trigger_done', { p_kind: 'accept', p_ref: ev.msg_id, p_status: 'error', p_detail: errMsg(e) }).catch(() => {});
      bump(e instanceof BudgetRefused ? 'budget' : 'accept_error');
      if (e instanceof BudgetRefused) return out;          // stop the batch: every further call would be refused too
    }
  }
  // A Gmail accept is drafted only when its person is already marked accepted (the worker's accept record, or Owner's tap)
  // or when the match was confirmed above. dm1_needed covers both the tap and the worker path.
  for (const id of p?.dm1_needed ?? []) people.add(id);
  // 0047: the event path no longer drafts DM1 itself. Each person goes into the pipeline (research -> brief -> dm1 ...), so
  // DM1 always waits for research and a brief. The job key makes a repeat (Gmail push, cron, the app tap) a no-op.
  for (const id of [...people].slice(0, limit)) {
    try { const r = await enqueueResearch(db, id); bump(r.existing ? 'pipeline_existing' : 'pipeline_queued'); }
    catch { bump('pipeline_error'); }
  }
  return out;
}

const errMsg = (e: unknown) => safeErr(e, 200);   // review #71: a provider error keeps only its status here
