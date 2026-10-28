// ari-ai (PENDING). Event path: accept -> classify (Haiku) -> draft_dm1 (Sonnet) -> generic "DM1 ready" push.
// Fired by ari-gmail-push right after a Gmail push, by the app's manual "Accepted" tap (action draft_dm1), and by the
// 10-minute cron as the fallback. Idempotent: ai_triggers ('accept', gmail msg id) and ('dm1', person id) are claimed
// once in the database before any model call, so a redelivered Pub/Sub message or an overlapping cron run does nothing.
import { Deps } from '../_shared/ai/run.ts';
import { BudgetRefused } from '../_shared/ai/run.ts';
import { classifyAccept, draftDm1 } from './actions.ts';
import { Db } from './db.ts';

// deno-lint-ignore no-explicit-any
type Accept = { msg_id: string; name?: string | null; profile_url?: string | null; match?: string | null; candidates?: any[] };
export interface Pending { accepts: Accept[]; dm1_needed: string[] }

export async function dm1ForPerson(db: Db, deps: Deps, person: string, mode: 'dm1_auto' | 'manual'): Promise<string> {
  if (!(await db.rpc<boolean>('ari_ai_trigger_claim', { p_kind: 'dm1', p_ref: person }))) return 'duplicate';
  try {
    const r = await draftDm1(db, deps, person, mode);
    const status = r.saved ? (r.draft?.needs_review ? 'needs_review' : 'done') : 'skipped';
    await db.rpc('ari_ai_trigger_done', { p_kind: 'dm1', p_ref: person, p_status: status, p_detail: r.reason });
    if (r.saved) await db.rpc('ari_ai_notify_dm_ready', { p_person: person });
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
  for (const id of [...people].slice(0, limit)) {
    const s = await dm1ForPerson(db, deps, id, 'dm1_auto');
    bump(`dm1_${s}`);
    if (s === 'budget') break;
  }
  return out;
}

const errMsg = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 200);
