// kyte-ai (PENDING, Oct 28 2026). Pipeline worker for the 0047 job line: research -> brief -> dm1 -> copy_check -> fact_check.
// Teaching notes:
//  - The queue is pgmq. read() hides a message for VT seconds; if this invocation dies, the message comes back and another
//    run picks it up (at-least-once). A message is archived ONLY by ari_pipeline_finish, in the same transaction that marks
//    the job done and enqueues the next stage, so "done" and "next stage queued" can never disagree.
//  - At-least-once means a stage can be offered twice. Three guards make that harmless: the unique (contact, stage,
//    input_hash) job key, ari_pipeline_start refusing finished jobs, and each stage's own idempotent write (research rows are
//    deduped, the DM1 save only fills an empty slot or Ari's own text, the notification outbox has a unique draft key).
//  - Preconditions are re-checked in SQL (ari_pipeline_start): DM1 never runs before research is done AND a brief exists.
//  - Messages in one batch are for different stages / contacts and run in parallel; one contact's stages are sequential
//    because each stage is only enqueued by the previous one finishing.
//  - Model failures that would repeat (invalid output, max_tokens) fail the job: no blind retry. Transient errors
//    (network, budget) give the message back; after MAX_READS deliveries the job fails.
//  - Nothing fails silently (review #50): every failed job raises ONE deduped 'ops_alert' in the notification outbox
//    (ari_pipeline_finish / ari_pipeline_start in SQL), and a failed research job gets exactly ONE delayed retry (5 min),
//    so a contact never quietly misses DM1.
import { BudgetRefused, Deps, InvalidOutput } from '../_shared/ai/run.ts';
import { buildBrief, briefForDraft, checkBrief, BriefIn } from '../_shared/ai/brief.ts';
import { copyCheck } from '../_shared/ai/copycheck.ts';
import { factCheck, FactDeps } from '../_shared/ai/factcheck.ts';
import { draftDm1, quickResearch } from './actions.ts';
import { Db } from './db.ts';

export const VT = 150, BATCH = 5, MAX_READS = 3;
export type Stage = 'research' | 'brief' | 'dm1' | 'copy_check' | 'fact_check';
// deno-lint-ignore no-explicit-any
type Any = any;
interface Msg { msg_id: number; read_ct: number; job: Any }
interface Outcome { status: 'done' | 'failed' | 'skipped' | 'queued'; output?: Any; ref?: string; error?: string; next?: [Stage, string] }

async function sha(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}
const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/(sk|xai|key)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]').slice(0, 200);
const env = (k: string) => { try { return Deno.env.get(k) || undefined; } catch { return undefined; } };

const HOOK_DAYS = 190;     // copy_check.py _hook_ok: an account hook counts for ~6 months
/** Copy check options for this contact's DM1: AE style (B only when the account's AE is the style B AE named in ARI_STYLE_B_AE;
 *  the pipeline context carries no AE today, so this is style A, the copy_check.py rule for every other AE and no AE) and
 *  whether a real dated trigger is on file (a brief trigger with a date, or the account hook within 190 days). */
export function dm1CheckOpts(c: Any, brief?: Any, now = Date.now()): { style: 'A' | 'B'; hookOk: boolean } {
  const ae = String(c?.account?.ae ?? '').toLowerCase(), b = (env('ARI_STYLE_B_AE') ?? '').toLowerCase().trim();
  const style: 'A' | 'B' = b && ae.includes(b) ? 'B' : 'A';
  const trig = (brief?.why_now ?? []).some((w: Any) => w?.kind === 'trigger' && /^\d{4}-\d{2}-\d{2}/.test(String(w?.date ?? '')));
  const hd = Date.parse(String(c?.account?.hook_date ?? '').slice(0, 10));
  const hook = Number.isFinite(hd) && (now - hd) / 86_400_000 <= HOOK_DAYS;
  return { style, hookOk: trig || hook };
}

export interface PipelineOpts { factKey?: string; factPost?: FactDeps['post']; now?: () => number; budgetMs?: number }

/** One stage. Pure orchestration over the RPC allowlist; returns what ari_pipeline_finish should record. */
export async function runStage(db: Db, deps: Deps, job: Any, o: PipelineOpts = {}): Promise<Outcome> {
  const contact: string = job.contact_id;
  const t0 = (o.now ?? Date.now)();
  const ms = () => (o.now ?? Date.now)() - t0;
  switch (job.stage as Stage) {
    case 'research': {
      const r = await quickResearch(db, deps, contact);
      return { status: 'done', ref: 'research', output: { ms: ms(), call_id: r.call_id, inserted: r.inserted, findings: r.research.findings.length,
        confidence: r.research.confidence }, next: ['brief', await sha(`brief:${job.id}`)] };
    }
    case 'brief': {
      const c = await db.rpc<BriefIn | null>('ari_pipeline_brief_context', { p_contact: contact });
      if (!c?.account?.id) return { status: 'done', output: { ms: ms(), skipped: 'no_account' }, next: ['dm1', await sha(`dm1:${job.id}`)] };
      const b = buildBrief(c);
      const errs = checkBrief(b);
      if (errs.length) return { status: 'failed', error: 'NOT WRITTEN: ' + errs.join('; '), output: { ms: ms() } };
      await db.rpc('ari_pipeline_brief_write', { p_account: c.account.id, p_brief: b });
      return { status: 'done', ref: `account_briefs:${c.account.id}`, output: { ms: ms(), brief: b }, next: ['dm1', await sha(`dm1:${job.id}`)] };
    }
    case 'dm1': {
      const c = await db.rpc<BriefIn | null>('ari_pipeline_brief_context', { p_contact: contact });
      let brief: Record<string, unknown> | undefined, full: Any;
      try { full = c?.account?.id ? buildBrief(c) : undefined; brief = full ? briefForDraft(full) : undefined; } catch { brief = undefined; full = undefined; }
      // Oct 29 2026 (staging finding 2): the full server copy check (v1 subset + AE guide) gates DM1 BEFORE "DM1 ready"
      const co = dm1CheckOpts(c, full);
      const r = await draftDm1(db, deps, contact, 'dm1_auto', undefined, brief, { check: (t) => copyCheck(t, 'dm1', co), style: co.style });
      if (!r.saved) return { status: 'skipped', error: r.reason ?? 'not saved', output: { ms: ms(), call_id: r.call_id ?? null, copy_gate: r.gate ?? null } };
      // a draft that still fails the copy check after its one redraft is NOT announced as ready: it stays on the contact,
      // marked needs_review with its flags, and the pipeline goes on (copy_check, fact_check) so the review queue shows why
      const ready = r.gate?.pass !== false;
      if (ready) await db.rpc('ari_ai_notify_dm_ready', { p_person: contact });   // outbox: one row per (person, kind, draft) in 0047
      return { status: 'done', ref: `${contact}:dm1`, output: { ms: ms(), call_id: r.call_id, text: r.draft!.text, source_facts: r.draft!.source_facts,
        confidence: r.draft!.confidence, needs_review: r.draft!.needs_review, style_score: r.draft!.style_score, copy_gate: r.gate ?? null,
        notified: ready }, next: ['copy_check', await sha(`cc:${r.draft!.text}`)] };
    }
    case 'copy_check': {
      const ctx = await db.rpc<Any>('ari_ai_context', { p_person: contact, p_account: null });
      const text: string = ctx?.person?.dm ?? '';
      const bc = await db.rpc<BriefIn | null>('ari_pipeline_brief_context', { p_contact: contact });
      let full: Any; try { full = bc?.account?.id ? buildBrief(bc) : undefined; } catch { full = undefined; }
      const res = copyCheck(text, 'dm1', dm1CheckOpts(bc, full));
      await db.rpc('ari_pipeline_save_checks', { p_contact: contact, p_kind: 'copy_check', p_result: res, p_needs_review: !res.pass });
      return { status: 'done', ref: `${contact}:dm1`, output: { ms: ms(), ...res }, next: ['fact_check', await sha(`fc:${text}`)] };
    }
    case 'fact_check': {
      const ctx = await db.rpc<Any>('ari_ai_context', { p_person: contact, p_account: null });
      const c = await db.rpc<Any>('ari_pipeline_brief_context', { p_contact: contact });
      const meta = ctx?.person?.ai?.dm ?? {};
      const r = await factCheck({ dm_text: ctx?.person?.dm ?? '', source_facts: meta.source_facts ?? [], company: c?.account?.company ?? ctx?.person?.company ?? '',
        domain: c?.account?.domain ?? '', contact: { name: ctx?.person?.name, title: ctx?.person?.title },
        // every other person Ari knows at the account: claims naming any of them are dropped too (Oct 28 2026)
        people: (c?.people ?? []).map((x: Any) => String(x?.name ?? '')).filter(Boolean),
        // the account's own public research: the only source of the brand allowlist (Oct 29 2026, staging finding 1)
        research: [...(c?.research ?? []).map((x: Any) => ({ fact: String(x?.fact ?? ''), source_url: String(x?.source_url ?? '') })),
          ...[c?.person?.research_brief?.summary, ...(c?.person?.research_brief?.angles ?? [])].filter((t: unknown) => typeof t === 'string')
            .map((t: string) => ({ fact: t, source_url: '' }))] }, {
        key: o.factKey ?? env('PARALLEL_API_KEY'), post: o.factPost,
        cacheGet: (d, h) => db.rpc('ari_pipeline_fact_get', { p_domain: d, p_hashes: h }).then((x) => (x ?? {}) as Record<string, unknown>),
        cachePut: (d, h, claim, v) => db.rpc('ari_pipeline_fact_put', { p_domain: d, p_hash: h, p_claim: claim, p_verdict: v }).then(() => {}),
      });
      if (r.status === 'blocked') return { status: 'failed', error: r.reason, output: { ms: ms(), ...r } };
      // an error or refusal is recorded as UNCHECKED (needs_review), never as clean (review #50)
      await db.rpc('ari_pipeline_save_checks', { p_contact: contact, p_kind: 'fact_check',
        p_result: { status: r.status, unchecked: (r as Any).unchecked ?? 0, verdicts: r.verdicts, decisions: r.decisions }, p_needs_review: !!(r as Any).flagged });
      // a transport error means the check did not happen: fail the job so ari_pipeline_finish raises the ops alert
      if ((r as Any).errors > 0) return { status: 'failed', ref: `${contact}:dm1`, error: `fact check unchecked: ${(r as Any).errors} Parallel error(s)`, output: { ms: ms(), ...r } };
      return { status: r.status === 'skipped' ? 'skipped' : 'done', ref: `${contact}:dm1`, output: { ms: ms(), ...r } };
    }
  }
  return { status: 'failed', error: 'unknown stage' };
}

/** Handle one queue message end to end: start (precondition), run, finish (archive + enqueue next). */
export async function handleMessage(db: Db, deps: Deps, m: Msg, o: PipelineOpts = {}): Promise<string> {
  if (!m.job) return 'orphan';
  // start = claim + lease (review #50): a job already 'running' under a live lease is refused here, BEFORE any model call,
  // so a pgmq redelivery during an active run never runs (or pays for) the stage twice. The lease is VT seconds.
  const st = await db.rpc<Any>('ari_pipeline_start', { p_job: m.job.id, p_msg: m.msg_id, p_lease: VT });
  if (!st?.ok) return `${st?.final ? 'stop' : 'wait'}:${st?.reason ?? 'unknown'}`;   // SQL fails a job that waited 8 deliveries
  let out: Outcome;
  try { out = await runStage(db, deps, st.job, o); }
  catch (e) {
    if (e instanceof InvalidOutput) out = { status: 'failed', error: errText(e) };                       // would repeat: no retry
    else if (e instanceof BudgetRefused) out = { status: m.read_ct >= MAX_READS ? 'failed' : 'queued', error: `budget: ${e.reason}` };
    else out = { status: m.read_ct >= MAX_READS ? 'failed' : 'queued', error: errText(e) };              // transient: message comes back
  }
  // p_attempt fences the finish to THIS claim: a run whose lease expired and was re-claimed cannot overwrite the newer run
  await db.rpc('ari_pipeline_finish', { p_job: m.job.id, p_msg: m.msg_id, p_attempt: st.job.attempt, p_status: out.status, p_output: out.output ?? null,
    p_output_ref: out.ref ?? null, p_error: out.error ?? null, p_next_stage: out.next?.[0] ?? null, p_next_hash: out.next?.[1] ?? null });
  return `${m.job.stage}:${out.status}`;
}

/** Drain the queue until it is empty or the time budget is used. Returns per-outcome counts and whether work remains. */
export async function runPipeline(db: Db, deps: Deps, o: PipelineOpts = {}): Promise<{ counts: Record<string, number>; more: boolean }> {
  const now = o.now ?? Date.now, t0 = now(), budget = o.budgetMs ?? 100_000;
  const counts: Record<string, number> = {};
  let more = false;
  while (now() - t0 < budget) {
    const msgs = (await db.rpc<Msg[]>('ari_pipeline_read', { p_qty: BATCH, p_vt: VT })) ?? [];
    if (!msgs.length) { more = false; break; }
    const res = await Promise.all(msgs.map((m) => handleMessage(db, deps, m, o).catch((e) => `error:${errText(e)}`)));
    for (const r of res) counts[r] = (counts[r] ?? 0) + 1;
    more = true;
    if (res.every((r) => r.startsWith('wait:'))) break;               // only blocked work left: let vt / cron bring it back
  }
  return { counts, more };
}

/** Put one contact into the pipeline (research first). Same job key as the Accepted trigger, so a repeat is a no-op. */
export async function enqueueResearch(db: Db, person: string): Promise<{ job_id: number; existing: boolean }> {
  return await db.rpc('ari_pipeline_enqueue', { p_contact: person, p_stage: 'research', p_input_hash: null, p_kick: true });
}
