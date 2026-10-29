// ari-ai: drafting in Ask Kyte (PENDING, Oct 30 2026; Owner option A, DECISIONS.md). Two halves:
//  1. chatDraftTurn(): inside action "chat", when Owner asks Kyte to write / draft / redo a message for a named person. The person
//     and the rules come from SQL (ari_ai_chat_draft_target, 0051: review pending, personal, Hold, exec track, customer / do-not-
//     contact, meeting set, withdrawn, already sent, DMs stop after a reply, not before they accept). Eligible: the draft is written
//     on the SAME path as Redraft and the DM1 drafter (prompts.ts, runDraft 'draft' / 'rewrite' through the spend ledger), checked
//     with the server copy check (ae-styles.md v3, G1 to G11) and redrafted ONCE with the flagged rules when it fails, then
//     recorded in ai_chat_drafts (ari_ai_chat_draft_put). The app gets an SSE `draft` event; NOTHING is written to the person.
//     Ineligible or unclear: one polite line, no model call, $0.
//  2. saveChatDraft(): action "chat_draft_save", called by the app ONLY on Owner's tap of "Save to <name>'s page" (or Undo). SQL
//     (ari_ai_chat_draft_save) re-checks eligibility, refuses Owner's own edit without confirm_overwrite, writes through
//     ari_ai_save_draft (Redraft's write) or ari_ai_save_reply_draft, keeps the replaced text for undo, and is idempotent per draft.
// Switch: app_config ask_draft = 'true'. Off: the target says "disabled" and the chat answers as it did before; save refuses.
import { askInstruction, chatDraftCheck, chatDraftPrompt, declineLine, draftLine, DraftKind, fixInstruction, namesSystem } from '../_shared/ai/chat_draft.ts';
import { Ctx } from '../_shared/ai/prompts.ts';
import { Deps, Draft, InvalidOutput, runDraft } from '../_shared/ai/run.ts';
import { HttpError } from '../_shared/ai/http.ts';
import { BadRequest } from './actions.ts';
import type { Db } from './db.ts';
import { dm1CheckOpts } from './pipeline.ts';

// deno-lint-ignore no-explicit-any
type Any = any;
export interface Target { ok: boolean; reason?: string; person_id?: string; name?: string; first_name?: string; kind?: DraftKind; slot?: string;
  reply_id?: number | null; current?: string; edited?: boolean; sent_before?: string[] }
export interface ChatDraftCard { draft_id: string; person_id: string; name: string; first_name: string; kind: DraftKind; text: string;
  needs_review: boolean; flags: string[]; edited: boolean; replaces: boolean }
export interface DraftTurn { text: string; card: ChatDraftCard | null; callId: number | null; reason: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Who the ask is for: the names in this message first, then the person on screen, then the conversation so far. */
export async function findTarget(db: Db, text: string, kind: DraftKind | null, screenPerson: string | null, earlier: string): Promise<Target> {
  const ask = (q: string | null, p: string | null) => db.rpc<Target>('ari_ai_chat_draft_target', { p_question: q, p_person: p, p_kind: kind });
  let t = await ask(text, null);
  // only a pronoun ("write him one", "redo it") leans on the screen or the conversation; an unknown name stays unknown
  const pron = /\b(him|her|them|their|his|it|this|that|this person|that person|this one|that one|the same person)\b/i.test(text);
  if (t?.reason === 'who' && pron && screenPerson) t = await ask(null, screenPerson);
  if (t?.reason === 'who' && pron && earlier.trim()) t = await ask(earlier, null);
  return t ?? { ok: false, reason: 'who' };
}

/** Write one draft (no save). Returns the draft, the copy check result and the ledger call ids. */
export async function writeChatDraft(db: Db, deps: Deps, t: Target, ask: string, turn: number):
  Promise<{ draft: Draft; pass: boolean; flags: string[]; firstFlags: string[]; redrafted: boolean; callIds: number[]; rules: string; ctx: Ctx }> {
  const kind = t.kind as DraftKind;
  const ctx: Ctx = kind === 'reply' ? await db.rpc<Ctx>('ari_ai_reply_context', { p_reply: t.reply_id })
    : await db.rpc<Ctx>('ari_ai_context', { p_person: t.person_id, p_account: null });
  const co = dm1CheckOpts(ctx);
  const current = String(t.current ?? ''), sentBefore = (t.sent_before ?? []).filter((x) => typeof x === 'string' && x.trim());
  const p = chatDraftPrompt({ ctx, kind, style: co.style, current, sentBefore, ask });
  const task = current.trim() && kind !== 'reply' ? 'rewrite' : 'draft';
  const nameCtx = { firstName: ctx?.person?.first_name ?? undefined, company: ctx?.person?.company ?? ctx?.account?.company ?? undefined };
  const d = { ...deps, refs: { personId: t.person_id ?? null, accountId: ctx?.account?.id ?? null, requestKey: `chatdraft:${turn}` } };
  const allowed = [ctx?.person?.name, ctx?.person?.company, ctx?.account?.company].filter((x): x is string => typeof x === 'string');
  const opts = { ...co, sentBefore };
  const out = await runDraft(task, p, d, nameCtx);
  const callIds = [out.callId];
  let draft = out.value, chk = chatDraftCheck(kind, draft.text, opts);
  if (namesSystem(draft.text, allowed)) chk = { ...chk, pass: false, flags: [...chk.flags, 'K1 names the app'] };
  const firstFlags = chk.flags;
  let redrafted = false;
  if (!chk.pass) {
    try {
      const fix = { system: p.system, user: `${p.user}\n<fix>\n${fixInstruction(kind, chk.flags, co.style)}\n<draft>\n${draft.text.slice(0, 1200)}\n</draft>\n</fix>` };
      const again = await runDraft(task, fix, { ...d, refs: { ...d.refs, requestKey: `chatdraft:${turn}:redraft` } }, nameCtx);
      callIds.push(again.callId); redrafted = true;
      draft = again.value; chk = chatDraftCheck(kind, draft.text, opts);
      if (namesSystem(draft.text, allowed)) chk = { ...chk, pass: false, flags: [...chk.flags, 'K1 names the app'] };
    } catch (e) {
      if (!(e instanceof InvalidOutput) && !(e instanceof HttpError)) throw e;      // budget refusals surface as before
    }
  }
  // a draft that names the app is never offered, even marked for review
  if (chk.flags.includes('K1 names the app')) throw new InvalidOutput('chat draft named the app');
  if (!chk.pass) draft = { ...draft, needs_review: true };
  return { draft, pass: chk.pass, flags: chk.flags, firstFlags, redrafted, callIds, rules: chk.rules_version, ctx };
}

/** One chat turn that is a draft ask. Never writes to the person; at most one ai_chat_drafts row. */
export async function chatDraftTurn(db: Db, deps: Deps, t: Target, ask: string, turn: number): Promise<DraftTurn> {
  if (!t.ok) return { text: declineLine(t.reason ?? '', t), card: null, callId: null, reason: t.reason ?? 'not_allowed' };
  let w;
  try { w = await writeChatDraft(db, deps, t, askInstruction(ask), turn); }
  catch (e) {
    if (e instanceof InvalidOutput || e instanceof HttpError) return { text: declineLine('failed', t), card: null, callId: null, reason: 'failed' };
    throw e;
  }
  const meta = { rationale: w.draft.rationale, source_facts: w.draft.source_facts, confidence: w.draft.confidence, needs_review: w.draft.needs_review,
    style_flags: w.draft.style_flags ?? [], call_ids: w.callIds,
    copy_gate: { pass: w.pass, flags: w.flags, first_flags: w.firstFlags, redrafted: w.redrafted, rules_version: w.rules } };
  const put = await db.rpc<{ ok: boolean; draft_id?: string; reason?: string }>('ari_ai_chat_draft_put', { p_turn: turn, p_person: t.person_id,
    p_kind: t.kind, p_reply: t.kind === 'reply' ? t.reply_id : null, p_text: w.draft.text, p_meta: meta, p_base: t.current ?? '' });
  if (!put?.ok || !put.draft_id) return { text: declineLine('failed', t), card: null, callId: w.callIds[w.callIds.length - 1], reason: put?.reason ?? 'failed' };
  const replaces = !!String(t.current ?? '').trim();
  const card: ChatDraftCard = { draft_id: put.draft_id, person_id: t.person_id!, name: t.name ?? '', first_name: t.first_name ?? '', kind: t.kind!,
    text: w.draft.text, needs_review: !!w.draft.needs_review, flags: w.flags, edited: !!t.edited, replaces };
  return { text: draftLine(t.kind!, card.name, card.first_name, { edited: card.edited, replaces, needsReview: card.needs_review }), card,
    callId: w.callIds[w.callIds.length - 1], reason: null };
}

/** action chat_draft_save {draft_id, confirm_overwrite?: true, undo?: true}: only on Owner's tap in the app. */
export async function saveChatDraft(db: Db, body: Record<string, unknown>): Promise<Any> {
  const id = typeof body.draft_id === 'string' && UUID.test(body.draft_id) ? body.draft_id : null;
  if (!id) throw new BadRequest('draft_id');
  if (body.confirm_overwrite !== undefined && typeof body.confirm_overwrite !== 'boolean') throw new BadRequest('confirm_overwrite');
  if (body.undo !== undefined && typeof body.undo !== 'boolean') throw new BadRequest('undo');
  return await db.rpc('ari_ai_chat_draft_save', { p_draft: id, p_confirm_overwrite: body.confirm_overwrite === true, p_undo: body.undo === true });
}
