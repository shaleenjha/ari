// Test helpers (synthetic data only): an in-memory stand-in for the 0041 RPCs and scripted providers. Never used in production.
import type { Db, ServiceRpc } from './db.ts';
import { SERVICE_RPCS } from './db.ts';
import type { AiRequest, AiResponse, Provider, StreamEvent } from '../_shared/ai/types.ts';
import { META } from '../_shared/ai/prompts.ts';

export const HOOK = 'hook-secret-synthetic-0123456789abcdef';
export const OWNER_JWT = 'aaa.bbb.owner';

// deno-lint-ignore no-explicit-any
type Any = any;
export function fakeDb(opts: { capUsd?: number; enabled?: boolean } = {}) {
  const st = {
    people: new Map<string, Any>([['P1', { id: 'P1', name: 'Synthetic Person', first_name: 'Synthetic', company: 'Ostrevanthe Co', dm: null, dm1_sent: null }]]),
    replies: new Map<number, Any>([[7, { id: 7, status: 'new', snippet: 'What does it cost?', person_id: 'P1',
      drafts: [{ key: 'book', label: 'Book', body: 'b' }, { key: 'answer', label: 'Answer', body: 'a' }, { key: 'soft', label: 'Soft', body: 's' }] }]]),
    calls: [] as Any[], triggers: new Map<string, string>(), pushes: [] as string[], research: [] as Any[], jobs: new Map<string, Any>(),
    pending: { accepts: [] as Any[], dm1_needed: [] as string[] }, spent: 0, rpcLog: [] as string[],
    // 0047 pipeline stand-in: job rows, a pgmq-like queue (vt + read_ct), briefs, checks, fact cache, notification outbox
    pjobs: [] as Any[], queue: [] as Any[], briefs: new Map<string, Any>(), checks: [] as Any[], factCache: new Map<string, Any>(),
    outbox: new Map<string, Any>(), clock: 0,
  };
  const enqueue = (contact: string, stage: string, hash: string | null) => {
    const h = hash ?? `research:${contact}`;
    const ex = st.pjobs.find((j) => j.contact_id === contact && j.stage === stage && j.input_hash === h);
    if (ex) return { job_id: ex.id, existing: true };
    const id = st.pjobs.length + 1; st.pjobs.push({ id, contact_id: contact, account_id: 'acc-1', stage, input_hash: h, status: 'queued', attempt: 0 });
    st.queue.push({ msg_id: id, job_id: id, vt: 0, read_ct: 0, archived: false });
    return { job_id: id, existing: false };
  };
  const done = (c: string, stage: string) => st.pjobs.some((j) => j.contact_id === c && j.stage === stage && j.status === 'done');
  const cap = opts.capUsd ?? 30, enabled = opts.enabled ?? true;
  const handlers: Record<string, (a: Any) => Any> = {
    ari_ai_hook: () => HOOK,
    ari_ai_budget_reserve: (a) => {
      if (!enabled) return { ok: false, reason: 'disabled' };
      if (st.spent + a.p_est > cap) { st.calls.push({ status: 'refused' }); return { ok: false, reason: 'monthly_cap' }; }
      st.spent += a.p_est; st.calls.push({ id: st.calls.length + 1, task: a.p_task, model: a.p_model, status: 'reserved', est: a.p_est });
      return { ok: true, call_id: st.calls.length };
    },
    ari_ai_call_finish: (a) => { const c = st.calls[a.p_id - 1]; if (c?.status === 'reserved') { st.spent += a.p_cost - c.est; Object.assign(c, { status: a.p_status, cost: a.p_cost }); } },
    ari_ai_budget_headroom: () => ({ enabled, month_left: cap - st.spent, day_left: cap - st.spent }),
    ari_ai_context: (a) => { const p = st.people.get(a.p_person); if (!p) throw Object.assign(new Error('nf'), { status: 404 }); return { person: { ...p, title: 'VP Security', ai: { dm: p.ai_meta ?? null } }, account: { id: 'acc-1', company: 'Ostrevanthe Co' }, research: [], guidance: [] }; },
    ari_ai_reply_context: (a) => ({ person: { ...st.people.get('P1') }, account: null, reply: { ...st.replies.get(a.p_reply) } }),
    ari_ai_save_draft: (a) => {
      const p = st.people.get(a.p_person); const cur = p[a.p_slot] ?? null;
      if (p.dm1_sent) return { saved: false, reason: 'already_sent' };
      if (a.p_mode === 'dm1_auto' && cur && cur !== p.ai_text) return { saved: false, reason: 'kept_existing' };
      if (a.p_mode !== 'dm1_auto' && (cur ?? '') !== (a.p_expect ?? '')) return { saved: false, reason: 'changed' };
      p[a.p_slot] = a.p_text; p.ai_text = a.p_text; p.ai_meta = a.p_meta; return { saved: true };
    },
    ari_ai_save_triage: (a) => { st.replies.get(a.p_reply).drafts = a.p_drafts; st.replies.get(a.p_reply).ai_triage = a.p_triage; return {}; },
    ari_ai_save_reply_draft: (a) => {
      const r = st.replies.get(a.p_reply); const d = r.drafts.find((x: Any) => x.key === a.p_key);
      if (d.body !== a.p_expect) return { saved: false, reason: 'changed' }; d.body = a.p_body; return { saved: true };
    },
    ari_ai_save_research: (a) => { st.research.push(...a.p_findings); const p = st.people.get(a.p_person); if (p) p.research_brief = a.p_brief;
      return { inserted: a.p_findings.length }; },
    ari_ai_job_enqueue: (a) => {
      for (const j of st.jobs.values()) if (j.person_id === a.p_person && ['queued', 'running'].includes(j.status)) return { id: j.id, existing: true };
      const id = crypto.randomUUID(); st.jobs.set(id, { id, person_id: a.p_person, account_id: null, focus: a.p_focus, status: 'queued', steps: a.p_steps, history: [] });
      return { id, existing: false };
    },
    ari_ai_job_claim: (a) => {
      const j = [...st.jobs.values()].find((x) => (!a.p_id || x.id === a.p_id) && x.status === 'queued');
      if (!j) return null; j.status = 'running'; const c = structuredClone(j); return c;
    },
    ari_ai_job_update: (a) => { const j = st.jobs.get(a.p_id); j.status = a.p_status; if (a.p_steps) j.steps = structuredClone(a.p_steps);
      if (a.p_result) j.result = a.p_result; j.history.push(a.p_status); if (a.p_status === 'done') st.pushes.push('brief:' + j.id); },
    ari_ai_job_event: (a) => { const j = st.jobs.get(a.p_id); const base = Math.max(0, ...j.steps.map((e: Any) => e.seq ?? 0));
      a.p_events.forEach((e: Any, i: number) => j.steps.push({ ...e, seq: base + i + 1 })); return base + a.p_events.length; },
    ari_ai_job_events: (a) => { const j = st.jobs.get(a.p_id); if (!j) return null;
      return { status: j.status, result: ['done', 'failed'].includes(j.status) ? j.result : null, events: j.steps.filter((e: Any) => e.seq > a.p_since) }; },
    ari_ai_trigger_claim: (a) => { const k = a.p_kind + ':' + a.p_ref; const s = st.triggers.get(k); if (s && s !== 'error') return false; st.triggers.set(k, 'claimed'); return true; },
    ari_ai_trigger_done: (a) => { st.triggers.set(a.p_kind + ':' + a.p_ref, a.p_status); },
    ari_ai_pending_events: () => ({
      accepts: st.pending.accepts.filter((e) => !st.triggers.has('accept:' + e.msg_id) || st.triggers.get('accept:' + e.msg_id) === 'error'),
      dm1_needed: st.pending.dm1_needed.filter((id) => !st.triggers.has('dm1:' + id)) }),
    ari_ai_import_book: () => [...st.people.values()].map((p) => ({ id: p.id, name: p.name, company: p.company, linkedin_url: p.linkedin_url ?? null })),
    ari_ai_notify_dm_ready: (a) => { if (!st.pushes.includes('dm1:' + a.p_person)) st.pushes.push('dm1:' + a.p_person);
      const k = `${a.p_person}|draft_due|${a.p_person}:dm1`; if (!st.outbox.has(k)) st.outbox.set(k, { sent_at: null }); },
    ari_pipeline_enqueue: (a) => enqueue(a.p_contact, a.p_stage, a.p_input_hash),
    ari_pipeline_read: (a) => {
      const vis = st.queue.filter((m) => !m.archived && m.vt <= st.clock).slice(0, a.p_qty);
      vis.forEach((m) => { m.vt = st.clock + a.p_vt; m.read_ct++; });
      return vis.map((m) => ({ msg_id: m.msg_id, read_ct: m.read_ct, job: structuredClone(st.pjobs[m.job_id - 1]) }));
    },
    ari_pipeline_start: (a) => {
      const j = st.pjobs[a.p_job - 1]; const m = st.queue.find((x) => x.msg_id === a.p_msg);
      if (['done', 'failed', 'skipped'].includes(j.status)) { m.archived = true; return { ok: false, reason: 'already_' + j.status, final: true }; }
      const why = (j.stage === 'brief' || j.stage === 'dm1') && !done(j.contact_id, 'research') ? 'wait_research'
        : j.stage === 'dm1' && !done(j.contact_id, 'brief') ? 'wait_brief'
        : ['copy_check', 'fact_check'].includes(j.stage) && !done(j.contact_id, 'dm1') ? 'wait_dm1' : null;
      if (why) return { ok: false, reason: why, final: false };
      j.status = 'running'; j.attempt++; return { ok: true, job: structuredClone(j) };
    },
    ari_pipeline_finish: (a) => {
      const j = st.pjobs[a.p_job - 1]; if (j.status !== 'running') return { ok: false, reason: 'not_running' };
      Object.assign(j, { status: a.p_status, output: a.p_output, error: a.p_error });
      const next = a.p_status === 'done' && a.p_next_stage ? enqueue(j.contact_id, a.p_next_stage, a.p_next_hash) : null;
      if (a.p_status !== 'queued') st.queue.find((x) => x.msg_id === a.p_msg).archived = true;
      return { ok: true, next };
    },
    ari_pipeline_brief_context: (a) => ({ person: { id: a.p_contact, name: 'Synthetic Person', title: 'VP Security', company: 'Ostrevanthe Co',
        research_brief: st.people.get(a.p_contact)?.research_brief ?? null },
      account: { id: 'acc-1', company: 'Ostrevanthe Co', domain: 'example.com' },
      research: st.research.map((r) => ({ source_url: r.source_url, dated: r.dated ?? null, fact: r.fact })),
      people: [{ person_id: a.p_contact, name: 'Synthetic Person', title: 'VP Security' }] }),
    ari_pipeline_brief_write: (a) => { st.briefs.set(a.p_account, a.p_brief); return { written: true }; },
    ari_pipeline_save_checks: (a) => { st.checks.push({ kind: a.p_kind, result: a.p_result, needs_review: a.p_needs_review }); },
    ari_pipeline_fact_get: (a) => Object.fromEntries(a.p_hashes.filter((h: string) => st.factCache.has(a.p_domain + h)).map((h: string) => [h, st.factCache.get(a.p_domain + h)])),
    ari_pipeline_fact_put: (a) => { st.factCache.set(a.p_domain + a.p_hash, a.p_verdict); },
  };
  const db: Db = {
    async rpc<T>(fn: ServiceRpc, args: Record<string, unknown> = {}): Promise<T> {
      if (!(SERVICE_RPCS as readonly string[]).includes(fn)) throw new Error('rpc not allowed: ' + fn);
      st.rpcLog.push(fn);
      const h = handlers[fn]; if (!h) throw new Error('fake missing ' + fn);
      return await Promise.resolve(h(args)) as T;
    },
    isOwner: (jwt) => Promise.resolve(jwt === OWNER_JWT),
  };
  return { db, st };
}

/** A provider that answers from a script, records every request, and can stream in fixed-size chunks. */
export function scripted(name: 'anthropic' | 'xai', replies: Array<string | Error | ((r: AiRequest) => string)>, cites: string[] = []) {
  const seen: AiRequest[] = [];
  const next = (req: AiRequest): string => {
    seen.push(req);
    const r = replies.length > 1 ? replies.shift()! : replies[0];
    if (r instanceof Error) throw r;
    return typeof r === 'function' ? r(req) : r;
  };
  const p: Provider = {
    name,
    complete(req): Promise<AiResponse> {
      const text = next(req);
      return Promise.resolve({ provider: name, model: req.model, text, tokensIn: 1000, tokensOut: 200, toolCalls: req.tools?.length ? 1 : 0,
        citations: cites.map((url) => ({ url })) });
    },
    async *stream(req): AsyncGenerator<StreamEvent> {
      const text = next(req);
      yield { type: 'usage', tokensIn: 900 };
      for (let i = 0; i < text.length; i += 5) yield { type: 'delta', text: text.slice(i, i + 5) };
      yield { type: 'usage', tokensOut: 150 };
    },
  };
  return { p, seen };
}

export const draftReply = (text: string, extra: Record<string, unknown> = {}) => `${text}\n${META}\n${JSON.stringify({
  rationale: 'Grounded in the vault launch.', source_facts: [{ fact: 'Ostrevanthe Co launched a vault', source: 'research' }],
  confidence: 0.85, needs_review: false, ...extra })}`;
