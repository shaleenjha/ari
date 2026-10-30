// kyte-ai (PENDING). Deep research as an async job: claude-opus-5-5 ORCHESTRATES in a tool loop; each grok_search tool call
// runs Grok 4.7 with x_search or web_search for fresh signals (Owner, Oct 23 2026 15:11 IST).
// LIVE FEED: every search query, every url/post read (title + domain) and every finding as it lands is appended to
// ai_jobs.steps as an event ({seq, at, type, ...}) the moment it happens. The app follows it two ways: realtime on ai_jobs, or
// the SSE action job_stream (handler.ts), which relays new events by seq. No fixed step labels.
// One invocation runs orchestrator turns while less than startWindowMs has passed (a turn plus its searches stays inside the
// 150 s wall clock), then saves the loop state in result.state, re-queues and kicks the next invocation; the 10-minute cron
// also picks up an expired lease. Budget: headroom for the whole job is checked at enqueue; every Opus turn and every Grok
// search reserves its own worst case and is booked in ai_calls.
import { SearchOut, Infer } from '../_shared/ai/schema.ts';
import { Ctx, DEEP_TOOLS, deepSystemPrompt, grokSearchPrompt, packContext } from '../_shared/ai/prompts.ts';
import { BudgetRefused, Deps, runTask, runTurn } from '../_shared/ai/run.ts';
import { reserveUsd } from '../_shared/ai/router.ts';
import type { AiMessage, Block } from '../_shared/ai/types.ts';
import { personId } from './actions.ts';
import { Db, ledgerFor } from './db.ts';

export const MAX_TURNS = 10, MAX_SEARCHES = 6, MAX_FINDINGS = 12;
export type JobEvent =
  | { type: 'status'; text: string }
  | { type: 'query'; source: 'x' | 'web'; query: string }
  | { type: 'read'; source: 'x' | 'web'; url: string; title: string; domain: string; published?: string }
  | { type: 'finding'; fact: string; source_url: string; domain: string; dated?: string }
  | { type: 'error'; text: string };
interface Finding { fact: string; source_url: string; dated?: string }
interface State { messages: AiMessage[]; findings: Finding[]; seen: string[]; searches: number; turns: number }

export const domainOf = (u: string) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const normUrl = (u: string) => u.trim().replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();

export async function enqueueDeep(db: Db, person: unknown, focus?: unknown): Promise<{ id: string; existing: boolean }> {
  const pid = personId(person);
  const h = await ledgerFor(db).headroom();
  const need = reserveUsd('deep_research', 20_000, 4) + reserveUsd('signal_search', 1_000, MAX_SEARCHES);
  if (!h.enabled) throw new BudgetRefused('disabled');
  if (h.month_left < need || h.day_left < need) throw new BudgetRefused('not_enough_left');
  return await db.rpc('ari_ai_job_enqueue', { p_person: pid, p_account: null,
    p_focus: typeof focus === 'string' ? focus.slice(0, 400) : null, p_steps: [{ seq: 1, type: 'status', text: 'Queued' }] });
}

/** Run one claimed job until done or out of time. Returns 'done' | 'failed' | 'yield' | 'none'. */
export async function runJob(db: Db, deps: Deps, jobId: string | null, startWindowMs = 45_000, now = () => Date.now()): Promise<string> {
  const t0 = now();
  // deno-lint-ignore no-explicit-any
  const job: any = await db.rpc('ari_ai_job_claim', { p_id: jobId });
  if (!job) return 'none';
  const emit = (evs: JobEvent[]) => db.rpc('ari_ai_job_event', { p_id: job.id, p_events: evs }).catch(() => null);
  const fail = async (why: string) => {
    await emit([{ type: 'error', text: why }]);
    await db.rpc('ari_ai_job_update', { p_id: job.id, p_steps: null, p_status: 'failed', p_result: null, p_error: why });
    return 'failed';
  };
  let ctx: Ctx;
  try { ctx = await db.rpc<Ctx>('ari_ai_context', { p_person: job.person_id, p_account: job.account_id }); }
  catch { return await fail('context unavailable'); }
  const st: State = job.result?.state ?? { messages: [{ role: 'user', content: `${packContext(ctx)}\nResearch the person and account in the context.` }],
    findings: [], seen: [], searches: 0, turns: 0 };
  if (!job.result?.state) await emit([{ type: 'status', text: 'Started' }]);
  const refs = { personId: job.person_id, accountId: job.account_id, jobId: job.id };
  const system = deepSystemPrompt(job.focus ?? undefined);
  let finish: { summary: string; angles: string[]; confidence: number } | null = null;

  while (!finish && st.turns < MAX_TURNS) {
    if (now() - t0 > startWindowMs) {
      await db.rpc('ari_ai_job_update', { p_id: job.id, p_steps: null, p_status: 'queued', p_result: { state: st }, p_error: null });
      return 'yield';
    }
    st.turns++;
    let resp;
    try { resp = await runTurn('deep_research', system, st.messages, DEEP_TOOLS, { ...deps, refs }); }
    catch (e) { return await fail(e instanceof BudgetRefused ? 'spend limit' : 'research step failed'); }
    st.messages.push({ role: 'assistant', content: resp.content ?? [{ type: 'text', text: resp.text }] });
    const uses = resp.toolUses ?? [];
    if (!uses.length) break;                                       // model stopped without finish: wrap up below
    const results: Block[] = [];
    for (const u of uses) {
      const input = u.input as Record<string, unknown>;
      if (u.name === 'grok_search') {
        const source = input.source === 'x' ? 'x' : 'web';
        const query = String(input.query ?? '').slice(0, 300);
        if (st.searches >= MAX_SEARCHES || !query) { results.push(toolResult(u.id, 'Search limit reached. Call finish.')); continue; }
        st.searches++;
        await emit([{ type: 'query', source, query }]);
        try {
          const found = await grokSearch(deps, refs, query, source);
          const fresh = found.filter((r) => !st.seen.includes(normUrl(r.url)));
          st.seen.push(...fresh.map((r) => normUrl(r.url)));
          if (fresh.length) await emit(fresh.map((r) => ({ type: 'read' as const, source, url: r.url, title: r.title ?? domainOf(r.url),
            domain: domainOf(r.url), ...(r.published ? { published: r.published } : {}) })));
          results.push(toolResult(u.id, JSON.stringify({ results: found }).slice(0, 6000)));
        } catch (e) {
          if (e instanceof BudgetRefused) return await fail('spend limit');
          await emit([{ type: 'error', text: 'A search did not answer; continuing.' }]);
          results.push(toolResult(u.id, 'Search failed. Try a different query or finish.'));
        }
      } else if (u.name === 'record_finding') {
        const f = { fact: String(input.fact ?? '').trim().slice(0, 500), source_url: String(input.source_url ?? '').trim(),
          dated: /^\d{4}-\d{2}-\d{2}$/.test(String(input.dated ?? '')) ? String(input.dated) : undefined };
        const ok = f.fact && /^https?:\/\//i.test(f.source_url) && st.seen.includes(normUrl(f.source_url)) && st.findings.length < MAX_FINDINGS;
        if (ok) { st.findings.push(f); await emit([{ type: 'finding', fact: f.fact, source_url: f.source_url, domain: domainOf(f.source_url), ...(f.dated ? { dated: f.dated } : {}) }]); }
        results.push(toolResult(u.id, ok ? 'Recorded.' : 'Rejected: the url must be one grok_search returned, and the fact must be concrete.'));
      } else if (u.name === 'finish') {
        finish = { summary: String(input.summary ?? '').slice(0, 1500), angles: (Array.isArray(input.angles) ? input.angles : []).map(String).slice(0, 5),
          confidence: Math.max(0, Math.min(1, Number(input.confidence ?? 0.5))) };
        results.push(toolResult(u.id, 'Done.'));
      } else results.push(toolResult(u.id, 'Unknown tool.'));
    }
    st.messages.push({ role: 'user', content: results });
  }
  if (!st.findings.length) return await fail('nothing citable found');
  const out = { summary: finish?.summary || 'Research finished without a summary.', angles: finish?.angles ?? [],
    confidence: finish ? (st.findings.length < 2 ? Math.min(finish.confidence, 0.5) : finish.confidence) : 0.4, findings: st.findings,
    searches: st.searches };
  await db.rpc('ari_ai_save_research', { p_person: job.person_id, p_account: job.account_id, p_findings: st.findings,
    p_brief: { kind: 'deep', summary: out.summary, angles: out.angles, confidence: out.confidence, job_id: job.id } });
  await emit([{ type: 'status', text: `Done: ${st.findings.length} findings from ${st.searches} searches` }]);
  await db.rpc('ari_ai_job_update', { p_id: job.id, p_steps: null, p_status: 'done', p_result: out, p_error: null });
  return 'done';
}

const toolResult = (id: string, content: string): Block => ({ type: 'tool_result', tool_use_id: id, content });

/** One Grok search (x_search or web_search only, per the orchestrator's choice). Results must be real http(s) urls; urls the
 *  provider cited are preferred when it returned citations. */
export async function grokSearch(deps: Deps, refs: Deps['refs'], query: string, source: 'x' | 'web'): Promise<Infer<typeof SearchOut>['results']> {
  const { value, resp } = await runTask('signal_search', grokSearchPrompt(query, source), SearchOut,
    { ...deps, refs, tools: [source === 'x' ? 'x_search' : 'web_search'] });
  const cited = new Set(resp.citations.map((c) => normUrl(c.url)));
  const clean = value.results.filter((r) => /^https?:\/\/\S+$/i.test(r.url));
  return cited.size ? clean.filter((r) => cited.has(normUrl(r.url))) : clean;
}
