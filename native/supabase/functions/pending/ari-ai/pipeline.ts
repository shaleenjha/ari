// ari-ai (PENDING, Oct 28 2026). Pipeline worker for the 0047 job line: research -> brief -> dm1 -> copy_check -> fact_check.
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
      let brief: Record<string, unknown> | undefined;
      try { brief = c?.account?.id ? briefForDraft(buildBrief(c)) : undefined; } catch { brief = undefined; }
      const r = await draftDm1(db, deps, contact, 'dm1_auto', undefined, brief);
      if (!r.saved) return { status: 'skipped', error: r.reason ?? 'not saved', output: { ms: ms(), call_id: r.call_id ?? null } };
      await db.rpc('ari_ai_notify_dm_ready', { p_person: contact });       // outbox: one row per (person, kind, draft) in 0047
      return { status: 'done', ref: `${contact}:dm1`, output: { ms: ms(), call_id: r.call_id, text: r.draft!.text, source_facts: r.draft!.source_facts,
        confidence: r.draft!.confidence, needs_review: r.draft!.needs_review, style_score: r.draft!.style_score }, next: ['copy_check', await sha(`cc:${r.draft!.text}`)] };
    }
    case 'copy_check': {
      const ctx = await db.rpc<Any>('ari_ai_context', { p_person: contact, p_account: null });
      const text: string = ctx?.person?.dm ?? '';
      const res = copyCheck(text, 'dm1');
      await db.rpc('ari_pipeline_save_checks', { p_contact: contact, p_kind: 'copy_check', p_result: res, p_needs_review: !res.pass });
      return { status: 'done', ref: `${contact}:dm1`, output: { ms: ms(), ...res }, next: ['fact_check', await sha(`fc:${text}`)] };
    }
    case 'fact_check': {
      const ctx = await db.rpc<Any>('ari_ai_context', { p_person: contact, p_account: null });
      const c = await db.rpc<Any>('ari_pipeline_brief_context', { p_contact: contact });
      const meta = ctx?.person?.ai?.dm ?? {};
      const r = await factCheck({ dm_text: ctx?.person?.dm ?? '', source_facts: meta.source_facts ?? [], company: c?.account?.company ?? ctx?.person?.company ?? '',
        domain: c?.account?.domain ?? '', contact: { name: ctx?.person?.name, title: ctx?.person?.title } }, {
        key: o.factKey ?? env('PARALLEL_API_KEY'), post: o.factPost,
        cacheGet: (d, h) => db.rpc('ari_pipeline_fact_get', { p_domain: d, p_hashes: h }).then((x) => (x ?? {}) as Record<string, unknown>),
        cachePut: (d, h, claim, v) => db.rpc('ari_pipeline_fact_put', { p_domain: d, p_hash: h, p_claim: claim, p_verdict: v }).then(() => {}),
      });
      if (r.status === 'blocked') return { status: 'failed', error: r.reason, output: { ms: ms(), ...r } };
      await db.rpc('ari_pipeline_save_checks', { p_contact: contact, p_kind: 'fact_check',
        p_result: { status: r.status, verdicts: r.verdicts, decisions: r.decisions }, p_needs_review: !!(r as Any).flagged });
      return { status: r.status === 'skipped' ? 'skipped' : 'done', ref: `${contact}:dm1`, output: { ms: ms(), ...r } };
    }
  }
  return { status: 'failed', error: 'unknown stage' };
}

/** Handle one queue message end to end: start (precondition), run, finish (archive + enqueue next). */
export async function handleMessage(db: Db, deps: Deps, m: Msg, o: PipelineOpts = {}): Promise<string> {
  if (!m.job) return 'orphan';
  const st = await db.rpc<Any>('ari_pipeline_start', { p_job: m.job.id, p_msg: m.msg_id });
  if (!st?.ok) return `${st?.final ? 'stop' : 'wait'}:${st?.reason ?? 'unknown'}`;   // SQL fails a job that waited 8 deliveries
  let out: Outcome;
  try { out = await runStage(db, deps, st.job, o); }
  catch (e) {
    if (e instanceof InvalidOutput) out = { status: 'failed', error: errText(e) };                       // would repeat: no retry
    else if (e instanceof BudgetRefused) out = { status: m.read_ct >= MAX_READS ? 'failed' : 'queued', error: `budget: ${e.reason}` };
    else out = { status: m.read_ct >= MAX_READS ? 'failed' : 'queued', error: errText(e) };              // transient: message comes back
  }
  await db.rpc('ari_pipeline_finish', { p_job: m.job.id, p_msg: m.msg_id, p_status: out.status, p_output: out.output ?? null,
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
