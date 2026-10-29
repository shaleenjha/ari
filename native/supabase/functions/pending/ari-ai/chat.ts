// ari-ai action "chat" (PENDING, Oct 30 2026): live Ask Kyte. Owner only (handler.ts checks the caller first).
//   POST {action: "chat", text, context?: {screen?, entity_type?: "person" | "account", entity_id?, label?}, stream?: true}
// SSE events: `delta` {t} while the answer is written; `replace` {t} when the final, cleaned answer differs from what was already
// shown (the app swaps the bubble text); then `done` {text, status: "ok" | "handled", entities: [{kind, id, name, start, end}],
// turn_id, first_ms, total_ms}; or `error` {error, retry_s?, fallback} where fallback true tells the app to file the question the
// old way (Chat row for the background run) instead.
// Order: input check -> rate limit (ari_ai_chat_begin, 20 a minute / 300 a day) -> askGuard (HANDLED, $0, no model) -> read-only
// snapshot (ari_ai_chat_context) -> spend reservation -> streamed Sonnet answer through the output guard -> book the cost ->
// record the turn. Nothing else is written; there is no path from here that changes Owner's data or sends anything.
import { askGuard, HANDLED, MAX_CHAT } from '../_shared/ai/chat_guard.ts';
import type { Entity } from '../_shared/ai/chat_guard.ts';
import { BudgetRefused, chatMessages, chatSystem, InvalidOutput, runChat, sanitizeSnapshot, Turn } from '../_shared/ai/chat.ts';
import type { Deps } from '../_shared/ai/run.ts';
import { BadRequest } from './actions.ts';
import type { Db } from './db.ts';

export class RateLimited extends Error { constructor(public reason: string, public retryS: number) { super(reason); } }

export interface ChatDone { text: string; status: 'ok' | 'handled'; entities: unknown[]; turn_id: number; first_ms: number | null; total_ms: number }
export interface ChatSink { delta: (t: string) => void | Promise<void>; replace: (t: string) => void | Promise<void> }

const PERSON_ID = /^P[A-Z0-9]{1,20}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function chatInput(body: Record<string, unknown>): { text: string; person: string | null; account: string | null } {
  if (typeof body.text !== 'string') throw new BadRequest('text');
  // deno-lint-ignore no-control-regex
  const text = body.text.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, MAX_CHAT);
  if (!text) throw new BadRequest('text');
  const c = (body.context && typeof body.context === 'object' && !Array.isArray(body.context)) ? body.context as Record<string, unknown> : {};
  const id = typeof c.entity_id === 'string' ? c.entity_id.trim() : '';
  return { text, person: c.entity_type === 'person' && PERSON_ID.test(id) ? id : null, account: c.entity_type === 'account' && UUID.test(id) ? id : null };
}

export async function chat(db: Db, deps: Deps, body: Record<string, unknown>, sink: ChatSink, now: () => number = () => Date.now()): Promise<ChatDone> {
  const t0 = now();
  const { text, person, account } = chatInput(body);
  const b = await db.rpc<{ ok: boolean; reason?: string; retry_s?: number; turn_id?: number; history?: Turn[] }>('ari_ai_chat_begin', { p_text: text });
  if (!b?.ok || !b.turn_id) {
    if (b?.reason === 'rate_minute' || b?.reason === 'rate_day') throw new RateLimited(b.reason, Number(b.retry_s ?? 60));
    throw new BadRequest('text');
  }
  const turn = b.turn_id;
  const finish = (answer: string, status: string, callId: number | null, first: number | null) =>
    db.rpc('ari_ai_chat_finish', { p_turn: turn, p_answer: answer, p_status: status, p_call: callId, p_first_ms: first, p_total_ms: now() - t0 })
      .catch(() => null);
  if (askGuard(text)) {
    await sink.delta(HANDLED);
    const ms = now() - t0;
    await finish(HANDLED, 'handled', null, ms);
    return { text: HANDLED, status: 'handled', entities: [], turn_id: turn, first_ms: ms, total_ms: ms };
  }
  try {
    // deno-lint-ignore no-explicit-any
    const ctx: any = await db.rpc('ari_ai_chat_context', { p_question: text, p_person: person, p_account: account });
    const deny: string[] = Array.isArray(ctx?.guard?.deny_names) ? ctx.guard.deny_names.filter((x: unknown) => typeof x === 'string') : [];
    const entities: Entity[] = Array.isArray(ctx?.guard?.entities) ? ctx.guard.entities : [];
    const system = chatSystem(sanitizeSnapshot(ctx?.snapshot ?? {}, deny));
    const res = await runChat(system, chatMessages(b.history ?? [], text), { ...deps, refs: { ...(deps.refs ?? {}), personId: person, accountId: account,
      requestKey: `chat:${turn}` } }, { deny, entities }, { onDelta: sink.delta, onReplace: sink.replace, now, t0 });
    const status = res.tripped === 'handled' ? 'handled' : 'ok';
    await finish(res.text, status, res.callId, res.firstMs);
    return { text: res.text, status, entities: res.entities, turn_id: turn, first_ms: res.firstMs, total_ms: now() - t0 };
  } catch (e) {
    await finish('', e instanceof BudgetRefused ? 'refused' : 'error', null, null);
    throw e;
  }
}

/** Error -> {status, body}: never names infrastructure; fallback tells the app whether to file the question the old way. */
export function chatError(e: unknown): { status: number; body: { error: string; retry_s?: number; fallback: boolean } } {
  if (e instanceof RateLimited) return { status: 429, body: { error: 'slow_down', retry_s: e.retryS, fallback: false } };
  if (e instanceof BadRequest) return { status: 400, body: { error: 'bad_request', fallback: false } };
  if (e instanceof BudgetRefused) return { status: 429, body: { error: 'spend_limit', fallback: true } };
  if (e instanceof InvalidOutput) return { status: 502, body: { error: 'answer_failed', fallback: true } };
  return { status: 500, body: { error: 'failed', fallback: true } };
}

/** SSE for chat: delta / replace / done / error. */
export function chatSse(db: Db, deps: Deps, body: Record<string, unknown>, h: Record<string, string>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      let open = true;
      const send = (ev: string, data: unknown) => { if (open) try { c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { open = false; } };
      try { const r = await chat(db, deps, body, { delta: (t) => send('delta', { t }), replace: (t) => send('replace', { t }) }); send('done', r); }
      catch (e) { send('error', chatError(e).body); }
      finally { try { c.close(); } catch { /* client gone */ } }
    },
  });
  return new Response(stream, { headers: { ...h, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}
