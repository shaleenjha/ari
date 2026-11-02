// Live AI layer (PENDING). One call = reserve budget -> provider call -> parse -> validate -> book the real cost.
// The ledger (ai_calls + the budget check, migration 0041) is injected so tests run with no database.
import { HttpError } from './http.ts';
import { PROVIDERS } from './providers.ts';
import { costUsd, reserveUsd, route } from './router.ts';
import { DraftOut, extractJson, Infer, Schema } from './schema.ts';
import { META, splitDraft } from './prompts.ts';
import { scoreDraft } from './style.ts';
import { AiMessage, AiResponse, ClientTool, Provider, Task, Tool } from './types.ts';

/** stop reasons that mean the answer is not complete or not an answer: never parsed, never saved, never retried blindly */
export const BAD_STOPS = ['max_tokens', 'refusal', 'model_context_window_exceeded'];

export interface Refs { personId?: string | null; accountId?: string | null; jobId?: string | null; requestKey?: string | null }
export interface Ledger {
  reserve(a: { task: Task; provider: string; model: string; estUsd: number } & Refs): Promise<{ ok: boolean; callId?: number; reason?: string }>;
  finish(callId: number, a: { status: 'ok' | 'error' | 'invalid'; tokensIn: number; tokensOut: number; costUsd: number; error?: string }): Promise<void>;
}
export interface Deps { ledger: Ledger; providers?: Record<string, Provider>; refs?: Refs; steps?: number; tools?: Tool[] }

export class BudgetRefused extends Error { constructor(public reason: string) { super(`budget: ${reason}`); } }
export class InvalidOutput extends Error {}

export interface Prompt { system: string; user: string }
export type Draft = Infer<typeof DraftOut> & { style_score?: number; style_flags?: string[] };

export function provider(deps: Deps, task: Task): Provider {
  const r = route(task);
  const p = (deps.providers ?? PROVIDERS)[r.provider];
  if (!p) throw new Error(`provider ${r.provider} missing`);
  return p;
}

export async function reserve(task: Task, promptChars: number, deps: Deps): Promise<number> {
  const r = route(task);
  const est = reserveUsd(task, promptChars, deps.steps ?? 1);
  const res = await deps.ledger.reserve({ task, provider: r.provider, model: r.model, estUsd: est, ...(deps.refs ?? {}) });
  if (!res.ok || res.callId === undefined) throw new BudgetRefused(res.reason ?? 'refused');
  return res.callId;
}

const REDACT = /(sk|xai|key|sb_secret|sb_publishable|Bearer)[-_ ][A-Za-z0-9_.-]{6,}/gi;
/** Ledger text (ai_calls.error, never sent to the app): the message plus, for a provider HTTP error, the provider's own text. */
export const errText = (e: unknown) => {
  const m = String((e as Error)?.message ?? e);
  return (e instanceof HttpError && e.detail ? `${m}: ${e.detail}` : m).replace(REDACT, '[redacted]').slice(0, 200);
};
/** Text for anything the app can read (fact-check verdicts, trigger detail): a provider HTTP error keeps only its status. */
export const safeErr = (e: unknown, max = 200) =>
  e instanceof HttpError ? `provider ${e.status}` : String((e as Error)?.message ?? e).replace(REDACT, '[redacted]').slice(0, max);

/** Non-streaming task with JSON output validated against `schema`. `parse` turns the raw text into the candidate object. */
export async function runTask<T>(task: Task, prompt: Prompt, schema: Schema<T>, deps: Deps,
  parse: (raw: string) => unknown = extractJson): Promise<{ value: T; resp: AiResponse; callId: number }> {
  const r = route(task);
  const callId = await reserve(task, prompt.system.length + prompt.user.length, deps);
  let resp: AiResponse;
  try {
    resp = await provider(deps, task).complete({ model: r.model, system: prompt.system, messages: [{ role: 'user', content: prompt.user }],
      maxTokens: r.maxTokens, temperature: r.temperature, tools: deps.tools ?? r.tools, maxToolUses: r.maxToolUses, timeoutMs: r.timeoutMs, thinking: r.thinking,
      effort: r.effort, cache: 'system' });
  } catch (e) {
    await deps.ledger.finish(callId, { status: 'error', tokensIn: 0, tokensOut: 0, costUsd: 0, error: errText(e) });
    throw e;
  }
  const cost = costUsd(r.model, resp.tokensIn, resp.tokensOut, resp.toolCalls, resp.cacheRead, resp.cacheWrite);
  // Oct 28 2026: a cut reply is reported as its stop reason ("stop_reason max_tokens"), never as a JSON parse error
  if (resp.stopReason && BAD_STOPS.includes(resp.stopReason)) {
    await deps.ledger.finish(callId, { status: 'invalid', tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, costUsd: cost, error: `stop_reason ${resp.stopReason}` });
    throw new InvalidOutput(`${task}: stop_reason ${resp.stopReason}`);
  }
  let parsed: unknown;
  try { parsed = parse(resp.text); } catch (e) {
    await deps.ledger.finish(callId, { status: 'invalid', tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, costUsd: cost, error: errText(e) });
    throw new InvalidOutput(`${task}: ${errText(e)}`);
  }
  const v = schema.parse(parsed);
  if (!v.ok) {
    await deps.ledger.finish(callId, { status: 'invalid', tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, costUsd: cost, error: v.error });
    throw new InvalidOutput(`${task}: ${v.error}`);
  }
  await deps.ledger.finish(callId, { status: 'ok', tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, costUsd: cost });
  return { value: v.value, resp, callId };
}

/** Structured task through a STRICT client tool (Oct 28 2026). The model may use its server tools (web search) first, then
 *  must answer by calling `tool` once; its input is the answer. Order of checks, so a bad reply costs one call and nothing else:
 *  1. stop_reason max_tokens / refusal / context window -> invalid (cost booked, nothing saved, no retry);
 *  2. no call to `tool` -> invalid; 3. the input fails `schema` -> invalid. Only a clean, validated input is returned. */
export async function runToolTask<T>(task: Task, prompt: Prompt, tool: ClientTool, schema: Schema<T>, deps: Deps,
  normalize: (x: unknown) => unknown = (x) => x):
  Promise<{ value: T; resp: AiResponse; callId: number }> {
  const r = route(task);
  const callId = await reserve(task, prompt.system.length + prompt.user.length + JSON.stringify(tool).length, deps);
  let resp: AiResponse;
  try {
    resp = await provider(deps, task).complete({ model: r.model, system: prompt.system, messages: [{ role: 'user', content: prompt.user }],
      maxTokens: r.maxTokens, tools: deps.tools ?? r.tools, maxToolUses: r.maxToolUses, clientTools: [{ ...tool, strict: true }],
      timeoutMs: r.timeoutMs, thinking: r.thinking, effort: r.effort, retries: r.retries, cache: 'system' });
  } catch (e) {
    await deps.ledger.finish(callId, { status: 'error', tokensIn: 0, tokensOut: 0, costUsd: 0, error: errText(e) });
    throw e;
  }
  const cost = costUsd(r.model, resp.tokensIn, resp.tokensOut, resp.toolCalls, resp.cacheRead, resp.cacheWrite);
  const bad = async (why: string): Promise<never> => {
    await deps.ledger.finish(callId, { status: 'invalid', tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, costUsd: cost, error: why });
    throw new InvalidOutput(`${task}: ${why}`);
  };
  if (resp.stopReason && BAD_STOPS.includes(resp.stopReason)) await bad(`stop_reason ${resp.stopReason}`);
  const use = (resp.toolUses ?? []).find((u) => u.name === tool.name);
  if (!use) await bad(`no ${tool.name} call (stop_reason ${resp.stopReason ?? 'unknown'})`);
  const v = schema.parse(normalize(use!.input));
  if (!v.ok) await bad(v.error);
  await deps.ledger.finish(callId, { status: 'ok', tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, costUsd: cost });
  return { value: (v as { ok: true; value: T }).value, resp, callId };
}

/** House-style gate: a draft that breaks a hard rule is never presented as ready. */
export function gateDraft(d: Infer<typeof DraftOut>, ctx: { firstName?: string; company?: string } = {}): Draft {
  const sc = scoreDraft(d.text, ctx);
  const hard = sc.violations.filter((v) => v.hard).map((v) => `${v.rule}: ${v.detail}`);
  return { ...d, needs_review: d.needs_review || !sc.pass || d.confidence < 0.6, style_score: sc.score, style_flags: hard };
}

export async function runDraft(task: 'draft' | 'rewrite', prompt: Prompt, deps: Deps, ctx: { firstName?: string; company?: string } = {}) {
  const out = await runTask(task, prompt, DraftOut, deps, splitDraft);
  return { ...out, value: gateDraft(out.value, ctx) };
}

/** Streaming draft/rewrite. onDelta gets ONLY message text (the meta block after @@META@@ is held back), then the validated
 *  draft is returned. A provider without stream() falls back to one complete() and emits the text once. */
export async function runDraftStream(task: 'draft' | 'rewrite', prompt: Prompt, deps: Deps, onDelta: (t: string) => void | Promise<void>,
  ctx: { firstName?: string; company?: string } = {}): Promise<{ value: Draft; callId: number }> {
  const r = route(task);
  const p = provider(deps, task);
  if (!p.stream) {
    const out = await runDraft(task, prompt, deps, ctx);
    await onDelta(out.value.text);
    return { value: out.value, callId: out.callId };
  }
  const callId = await reserve(task, prompt.system.length + prompt.user.length, deps);
  let raw = '', sent = 0, tin = 0, tout = 0, cr = 0, cw = 0, metaSeen = false, stop: string | undefined;
  try {
    for await (const ev of p.stream({ model: r.model, system: prompt.system, messages: [{ role: 'user', content: prompt.user }],
      maxTokens: r.maxTokens, temperature: r.temperature, timeoutMs: r.timeoutMs, thinking: r.thinking, effort: r.effort, cache: 'system' })) {
      if (ev.type === 'usage') { tin = ev.tokensIn ?? tin; tout = ev.tokensOut ?? tout; cr = ev.cacheRead ?? cr; cw = ev.cacheWrite ?? cw; continue; }
      if (ev.type === 'stop') { stop = ev.reason; continue; }
      raw += ev.text;
      if (metaSeen) continue;
      const m = raw.indexOf(META);
      const safeEnd = m >= 0 ? m : Math.max(sent, raw.length - META.length);   // hold back a possible partial marker
      if (safeEnd > sent) { await onDelta(raw.slice(sent, safeEnd)); sent = safeEnd; }
      if (m >= 0) metaSeen = true;
    }
  } catch (e) {
    await deps.ledger.finish(callId, { status: 'error', tokensIn: tin, tokensOut: tout, costUsd: costUsd(r.model, tin, tout, 0, cr, cw), error: errText(e) });
    throw e;
  }
  const cost = costUsd(r.model, tin, tout, 0, cr, cw);
  // the streaming parser keeps message_delta.stop_reason: a cut stream fails as "stop_reason max_tokens" (nothing saved)
  if (stop && BAD_STOPS.includes(stop)) {
    await deps.ledger.finish(callId, { status: 'invalid', tokensIn: tin, tokensOut: tout, costUsd: cost, error: `stop_reason ${stop}` });
    throw new InvalidOutput(`${task}: stop_reason ${stop}`);
  }
  let cand: unknown;
  try { cand = splitDraft(raw); } catch (e) {
    await deps.ledger.finish(callId, { status: 'invalid', tokensIn: tin, tokensOut: tout, costUsd: cost, error: errText(e) });
    throw new InvalidOutput(`${task}: ${errText(e)}`);
  }
  const v = DraftOut.parse(cand);
  if (!v.ok) {
    await deps.ledger.finish(callId, { status: 'invalid', tokensIn: tin, tokensOut: tout, costUsd: cost, error: v.error });
    throw new InvalidOutput(`${task}: ${v.error}`);
  }
  await deps.ledger.finish(callId, { status: 'ok', tokensIn: tin, tokensOut: tout, costUsd: cost });
  return { value: gateDraft(v.value, ctx), callId };
}

/** One turn of a multi-turn tool loop (deep research orchestrator). Budget-guarded and booked like any call; the caller
 *  executes the returned toolUses and appends tool_result blocks for the next turn. Review #54 follow-up (Oct 29 2026): a
 *  turn cut at max_tokens / refused / out of context is NOT a finished turn (its tool_use may be lost, and the loop would wrap
 *  up early as if done). Like the other routes it is booked invalid "stop_reason <x>" and thrown, so jobs.ts fails the step. */
export async function runTurn(task: Task, system: string, messages: AiMessage[], clientTools: ClientTool[], deps: Deps): Promise<AiResponse> {
  const r = route(task);
  const chars = system.length + JSON.stringify(messages).length;
  const callId = await reserve(task, chars, deps);
  let resp: AiResponse;
  try {
    resp = await provider(deps, task).complete({ model: r.model, system, messages, maxTokens: r.maxTokens, temperature: r.temperature,
      clientTools, timeoutMs: r.timeoutMs, thinking: r.thinking, effort: r.effort, cache: 'conversation' });
  } catch (e) {
    await deps.ledger.finish(callId, { status: 'error', tokensIn: 0, tokensOut: 0, costUsd: 0, error: errText(e) });
    throw e;
  }
  const cost = costUsd(r.model, resp.tokensIn, resp.tokensOut, resp.toolCalls, resp.cacheRead, resp.cacheWrite);
  if (resp.stopReason && BAD_STOPS.includes(resp.stopReason)) {
    await deps.ledger.finish(callId, { status: 'invalid', tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, costUsd: cost, error: `stop_reason ${resp.stopReason}` });
    throw new InvalidOutput(`${task}: stop_reason ${resp.stopReason}`);
  }
  await deps.ledger.finish(callId, { status: 'ok', tokensIn: resp.tokensIn, tokensOut: resp.tokensOut, costUsd: cost });
  return resp;
}
