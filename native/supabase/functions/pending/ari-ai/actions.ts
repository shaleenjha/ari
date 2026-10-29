// ari-ai (PENDING). The five app actions. Each one reads ONE person's (or one reply's) context, runs the routed model task,
// validates the output and writes ONLY to that person's draft / research fields or that reply's drafts. Nothing here sends a
// message anywhere: there is no LinkedIn client, and the host allowlist in _shared/ai/http.ts refuses linkedin.com.
import { HttpError } from '../_shared/ai/http.ts';
import { ClassifyOut, cleanFindings, Infer, ReplyDraftsOut, ResearchOut, TriageClassOut, triageKeysOk } from '../_shared/ai/schema.ts';
import { classifyAcceptPrompt, CHIPS, Ctx, draftDm1Prompt, quickResearchPrompt, replyDraftsPrompt, rewritePrompt, SAVE_RESEARCH, triagePrompt } from '../_shared/ai/prompts.ts';
import { Deps, Draft, InvalidOutput, runDraft, runDraftStream, runTask, runToolTask } from '../_shared/ai/run.ts';
import { CopyResult, dm1FixInstruction } from '../_shared/ai/copycheck.ts';
import { Db } from './db.ts';
import { BookPerson, ImportRow, resolveImport } from '../_shared/import/resolve.ts';
import { defaultLookup } from '../_shared/import/brave.ts';
import type { PeopleLookup } from '../_shared/import/lemlist.ts';

export class BadRequest extends Error {}
const PERSON_ID = /^[A-Za-z0-9_-]{1,40}$/;
const SLOT: Record<string, 'dm' | 'dm2_text' | 'dm3_text'> = { dm1: 'dm', dm2: 'dm2_text', dm3: 'dm3_text' };

export function personId(x: unknown): string {
  if (typeof x !== 'string' || !PERSON_ID.test(x)) throw new BadRequest('person_id');
  return x;
}

/** draft id: "<person_id>:dm1|dm2|dm3" or "reply:<reply_id>:book|answer|soft" */
export function parseDraftId(id: unknown):
  | { kind: 'person'; person: string; slot: 'dm' | 'dm2_text' | 'dm3_text' }
  | { kind: 'reply'; reply: number; key: 'book' | 'answer' | 'soft' } {
  if (typeof id !== 'string') throw new BadRequest('draft_id');
  const m = id.match(/^reply:(\d{1,12}):(book|answer|soft)$/);
  if (m) return { kind: 'reply', reply: Number(m[1]), key: m[2] as 'book' | 'answer' | 'soft' };
  const p = id.match(/^([A-Za-z0-9_-]{1,40}):(dm1|dm2|dm3)$/);
  if (p) return { kind: 'person', person: p[1], slot: SLOT[p[2]] };
  throw new BadRequest('draft_id');
}

const nameCtx = (c: Ctx) => ({ firstName: c?.person?.first_name ?? undefined, company: c?.person?.company ?? c?.account?.company ?? undefined });
const metaOf = (d: Draft, extra: Record<string, unknown> = {}) => ({ rationale: d.rationale, source_facts: d.source_facts,
  confidence: d.confidence, needs_review: d.needs_review, style_flags: d.style_flags ?? [], ...extra });

// ---------------- rewrite ----------------
export async function rewrite(db: Db, deps: Deps, body: Record<string, unknown>, onDelta?: (t: string) => Promise<void>) {
  const target = parseDraftId(body.draft_id);
  const chip = typeof body.chip === 'string' && CHIPS[body.chip] ? body.chip : undefined;
  if (body.chip !== undefined && !chip) throw new BadRequest('chip');
  const instruction = typeof body.instruction === 'string' ? body.instruction.slice(0, 400) : undefined;
  if (target.kind === 'person') {
    const ctx = await db.rpc<Ctx>('ari_ai_context', { p_person: target.person, p_account: null });
    const current: string = ctx?.person?.[target.slot] ?? '';
    if (!current.trim()) throw new BadRequest('empty draft');
    const p = rewritePrompt(ctx, current, chip, instruction);
    const d = { ...deps, refs: { personId: target.person, accountId: ctx?.account?.id ?? null } };
    const out = onDelta ? await runDraftStream('rewrite', p, d, onDelta, nameCtx(ctx)) : await runDraft('rewrite', p, d, nameCtx(ctx));
    const saved = await db.rpc<{ saved: boolean; reason?: string }>('ari_ai_save_draft', { p_person: target.person, p_slot: target.slot,
      p_text: out.value.text, p_meta: metaOf(out.value, { chip: chip ?? null, call_id: out.callId }), p_expect: current, p_mode: 'rewrite' });
    return { draft: out.value, saved: !!saved?.saved, reason: saved?.reason ?? null };
  }
  const ctx = await db.rpc<Ctx>('ari_ai_reply_context', { p_reply: target.reply });
  const cur = (ctx?.reply?.drafts ?? []).find((x: { key: string }) => x.key === target.key);
  if (!cur?.body) throw new BadRequest('empty draft');
  const p = rewritePrompt(ctx, cur.body, chip, instruction);
  const d = { ...deps, refs: { personId: ctx?.person?.id ?? null, accountId: ctx?.account?.id ?? null } };
  const out = onDelta ? await runDraftStream('rewrite', p, d, onDelta, nameCtx(ctx)) : await runDraft('rewrite', p, d, nameCtx(ctx));
  const saved = await db.rpc<{ saved: boolean; reason?: string }>('ari_ai_save_reply_draft', { p_reply: target.reply, p_key: target.key,
    p_body: out.value.text, p_expect: cur.body });
  return { draft: out.value, saved: !!saved?.saved, reason: saved?.reason ?? null };
}

// ---------------- draft_dm1 (app tap, manual "Accepted" mark, or the event path) ----------------
/** Server copy check gate for auto DM1s (Oct 29 2026, staging finding 2). `check` is the full server copy check (v1 subset +
 *  AE style guide). A failing first draft is redrafted ONCE with the flagged rules; if the redraft still fails, the draft is
 *  saved marked needs_review with the flags, and the caller must not raise "DM1 ready" for it. */
export interface Dm1Gate { check: (text: string) => CopyResult; style?: 'A' | 'B' }
export interface GateResult { pass: boolean; flags: string[]; redrafted: boolean; first_flags: string[]; rules_version: string; redraft_error?: string }

export async function draftDm1(db: Db, deps: Deps, person: string, mode: 'dm1_auto' | 'manual', onDelta?: (t: string) => Promise<void>,
  brief?: Record<string, unknown>, gate?: Dm1Gate) {
  const base = await db.rpc<Ctx>('ari_ai_context', { p_person: person, p_account: null });
  const ctx: Ctx = brief ? { ...base, brief } : base;           // pipeline: the server brief rides along as data
  if (ctx?.person?.dm1_sent) return { draft: null, saved: false, reason: 'already_sent' };
  const p = draftDm1Prompt(ctx, gate?.style ?? 'A');
  const d = { ...deps, refs: { personId: person, accountId: ctx?.account?.id ?? null, requestKey: `dm1:${person}` } };
  const out = onDelta ? await runDraftStream('draft', p, d, onDelta, nameCtx(ctx)) : await runDraft('draft', p, d, nameCtx(ctx));
  let draft: Draft = out.value, callId = out.callId, g: GateResult | undefined;
  const callIds = [out.callId];
  if (gate && !onDelta) {
    const first = gate.check(draft.text);
    g = { pass: first.pass, flags: first.flags, redrafted: false, first_flags: first.flags, rules_version: first.rules_version };
    if (!first.pass) {
      try {
        const fix = { system: p.system, user: `${p.user}\n<fix>\n${dm1FixInstruction(first.flags, gate.style)}\n<draft>\n${draft.text.slice(0, 1200)}\n</draft>\n</fix>` };
        const again = await runDraft('draft', fix, { ...d, refs: { ...d.refs, requestKey: `dm1:${person}:redraft` } }, nameCtx(ctx));
        callIds.push(again.callId);
        const second = gate.check(again.value.text);
        draft = again.value; callId = again.callId;
        g = { ...g, pass: second.pass, flags: second.flags, redrafted: true, rules_version: second.rules_version };
      } catch (e) {
        // the redraft itself failed (cut reply, budget, network): keep the first draft, flagged, so DM1 is never lost
        // review #70: a provider error keeps only its status here (this meta reaches the app); its text stays in the ledger
        g = { ...g, redraft_error: e instanceof HttpError ? `provider ${e.status}` : String((e as Error)?.message ?? e).slice(0, 160) };
      }
    }
    if (!g.pass) draft = { ...draft, needs_review: true };
  }
  const saved = await db.rpc<{ saved: boolean; reason?: string }>('ari_ai_save_draft', { p_person: person, p_slot: 'dm',
    p_text: draft.text, p_meta: metaOf(draft, { call_id: callId, ...(g ? { copy_gate: g, call_ids: callIds } : {}) }), p_expect: ctx?.person?.dm ?? null, p_mode: mode });
  return { draft, saved: !!saved?.saved, reason: saved?.reason ?? null, call_id: callId, gate: g };
}

// ---------------- quick_research (inline; Sonnet + web search, answer through the strict save_research tool) ----------------
export async function quickResearch(db: Db, deps: Deps, person: string, focus?: string) {
  const ctx = await db.rpc<Ctx>('ari_ai_context', { p_person: person, p_account: null });
  const d = { ...deps, refs: { personId: person, accountId: ctx?.account?.id ?? null } };
  const { value, resp, callId } = await runToolTask('quick_research', quickResearchPrompt(ctx, focus), SAVE_RESEARCH, ResearchOut, d, trimResearch);
  const r = groundFindings(value, [...resp.citations.map((c) => c.url), ...(resp.searchUrls ?? [])]);
  const saved = await db.rpc<{ inserted: number }>('ari_ai_save_research', { p_person: person, p_account: null, p_findings: r.findings,
    p_brief: { kind: 'quick', summary: r.summary, angles: r.angles, confidence: r.confidence, call_id: callId } });
  return { research: r, inserted: saved?.inserted ?? 0, call_id: callId };
}

/** Cut over-long strings and lists to the ResearchOut limits instead of failing a paid answer on length alone. Types are not
 *  coerced: a wrong type still fails validation. */
// deno-lint-ignore no-explicit-any
export function trimResearch(x: any): unknown {
  if (!x || typeof x !== 'object') return x;
  const cut = (v: unknown, n: number) => typeof v === 'string' ? v.trim().slice(0, n) : v;
  return { ...x, summary: cut(x.summary, 1500),
    findings: Array.isArray(x.findings) ? x.findings.slice(0, 12).map((f: Record<string, unknown>) => f && typeof f === 'object'
      ? { ...f, fact: cut(f.fact, 500), dated: typeof f.dated === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(f.dated.trim()) ? f.dated.trim() : undefined } : f)
      : x.findings,
    angles: Array.isArray(x.angles) ? x.angles.slice(0, 5).map((a: unknown) => cut(a, 300)) : x.angles };
}

/** Keep only findings whose URL the provider actually returned as a citation (when it returned any); otherwise cap confidence. */
export function groundFindings(v: Infer<typeof ResearchOut>, cited: string[]): Infer<typeof ResearchOut> {
  const clean = cleanFindings(v.findings);
  if (!cited.length) return { ...v, findings: clean, confidence: Math.min(v.confidence, 0.4) };
  const set = new Set(cited.map(normUrl));
  const kept = clean.filter((f) => set.has(normUrl(f.source_url)));
  return { ...v, findings: kept, confidence: kept.length < clean.length ? Math.min(v.confidence, 0.6) : v.confidence };
}
const normUrl = (u: string) => u.trim().replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();

// ---------------- triage_reply (Haiku classifies, Opus drafts the 3 replies) ----------------
export async function triageReply(db: Db, deps: Deps, replyId: unknown) {
  if (typeof replyId !== 'number' || !Number.isInteger(replyId) || replyId <= 0) throw new BadRequest('reply_id');
  const ctx = await db.rpc<Ctx>('ari_ai_reply_context', { p_reply: replyId });
  if (ctx?.reply?.status !== 'new') return { triage: null, saved: false, reason: 'not_open' };
  const d = { ...deps, refs: { personId: ctx?.person?.id ?? null, accountId: ctx?.account?.id ?? null, requestKey: `triage:${replyId}` } };
  const { value: cls } = await runTask('triage', triagePrompt(ctx), TriageClassOut, d);
  const { value: rd } = await runTask('reply_draft', replyDraftsPrompt(ctx, cls), ReplyDraftsOut, d);
  if (!triageKeysOk(rd.drafts)) throw new InvalidOutput('reply_draft: keys must be book, answer, soft');
  const triage = { ...cls, drafts: rd.drafts, needs_review: cls.needs_review || rd.needs_review };
  await db.rpc('ari_ai_save_triage', { p_reply: replyId, p_drafts: rd.drafts,
    p_triage: { intent: cls.intent, urgency: cls.urgency, summary: cls.summary, needs_review: triage.needs_review } });
  return { triage, saved: true, reason: null };
}

// ---------------- classify (event path: confirm an accept email and match it to one person) ----------------
export async function classifyAccept(deps: Deps, ev: { msg_id: string; name?: string | null; profile_url?: string | null; match?: string | null;
  candidates?: Ctx[] }): Promise<{ personId: string | null; confidence: number; agree: boolean }> {
  const cands = (ev.candidates ?? []).slice(0, 5);
  if (!cands.length) return { personId: null, confidence: 0, agree: false };
  const { value } = await runTask('classify', classifyAcceptPrompt({ name: ev.name, profile_url: ev.profile_url }, cands), ClassifyOut,
    { ...deps, refs: { requestKey: `accept:${ev.msg_id}` } });
  const inCands = !!value.person_id && cands.some((c) => c.id === value.person_id);
  const pick = value.is_accept && inCands && value.confidence >= 0.7 ? value.person_id! : null;
  // the deterministic match (unique vanity, else unique full name) must agree when it exists
  if (ev.match) return { personId: pick === ev.match ? pick : null, confidence: value.confidence, agree: pick === ev.match };
  return { personId: pick, confidence: value.confidence, agree: !!pick };
}

// ---------------- import_resolve (CSV import card; spec docs/specs/08) ----------------
// Returns the prepared PLAN only: duplicates and missing URLs each come with their fix chosen. Nothing is written here; the
// app applies the plan after the Owner's one tap (Diamond writes). Lookups: CSV URL, then Brave, then lemlist, then park.
export const MAX_IMPORT_ROWS = 100;
const str = (x: unknown, max: number): string | undefined => typeof x === 'string' && x.trim() ? x.trim().slice(0, max) : undefined;
export function importRows(x: unknown): ImportRow[] {
  if (!Array.isArray(x) || x.length === 0 || x.length > MAX_IMPORT_ROWS) throw new BadRequest('rows');
  return x.map((r, i) => {
    if (!r || typeof r !== 'object') throw new BadRequest('rows');
    const o = r as Record<string, unknown>;
    const name = str(o.name, 120), company = str(o.company, 120);
    if (!name || !company) throw new BadRequest(`row ${i + 1}: name and company`);
    const url = str(o.linkedin_url, 300);
    return { row: Number.isInteger(o.row) ? Number(o.row) : i + 1, name, company, title: str(o.title, 200), location: str(o.location, 120),
      linkedin_url: url && /^https:\/\/([a-z]{2,3}\.)?(www\.)?linkedin\.com\/in\/[^/?#\s]+/i.test(url) ? url : undefined };
  });
}
export async function importResolve(db: Db, deps: Deps, body: Record<string, unknown>, lookup: PeopleLookup = defaultLookup) {
  const rows = importRows(body.rows);
  const book = (await db.rpc<BookPerson[]>('ari_ai_import_book')) ?? [];
  return { plan: await resolveImport(rows, book, { lookup, ai: deps }) };
}
