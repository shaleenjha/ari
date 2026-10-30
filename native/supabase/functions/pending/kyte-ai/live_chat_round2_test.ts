// Live Ask Kyte, round 2 (Oct 30 2026), synthetic data only. deno test --allow-env --allow-read
//  1. Owner's rule: Kyte never names Ari, Den, Hark, Kelvarrow or any system / vendor behind it and has no notion of them. The refusal
//     line names no system; those names are banned in answers (whole word, any case, leetspeak / spacing) unless a snapshot name
//     holds the word; identity asks are declined before any model call.
//  2. Follow-ups keep who was being discussed: the lookup text carries the last questions and answer; no retracting.
//  3. "snapshot" / "my context" never reach Owner; "my instructions" trips.
//  4. Kyte speaks as "I", never "you are Kyte".
import { assert, assertEquals, assertFalse } from 'jsr:@std/assert@1';
import { askGuard, ChatStream, cleanAnswer, HANDLED, nameMask } from '../_shared/ai/chat_guard.ts';
import { chatSystem, HOW_KYTE_WORKS } from '../_shared/ai/chat.ts';
import { lookupText } from './chat.ts';
import { handle, Env } from './handler.ts';
import type { Db } from './db.ts';
import { SERVICE_RPCS } from './db.ts';
import type { Provider, StreamEvent } from '../_shared/ai/types.ts';

// deno-lint-ignore no-explicit-any
type Any = any;
const SYSTEMS = /\b(ari|den|hark|kelvarrow|anthropic|claude|sonnet|opus|haiku|supabase|vercel|parallel|postgres|openai)\b/i;

Deno.test('round 2: the refusal line names no system and is short', () => {
  assertEquals(HANDLED, "I can't help with that here.");
  assertFalse(SYSTEMS.test(HANDLED));
});

Deno.test('round 2: the instructions name no system, vendor or old / internal name, and speak about Kyte as "I"', () => {
  const sys = chatSystem({ today: { moves_total: 1 } });
  assertFalse(SYSTEMS.test(sys), (sys.match(SYSTEMS) ?? [''])[0]);
  assertFalse(/\byou are kyte\b|\byou started\b|renamed you|\bprototype\b/i.test(HOW_KYTE_WORKS));
  assert(/About me, Kyte/.test(HOW_KYTE_WORKS) && /I'm Kyte by Thrandvex/.test(HOW_KYTE_WORKS));
  assert(sys.includes('Speak about yourself as "I"'));
  assert(sys.includes('Never correct, retract or take back an earlier answer'));
  assert(sys.includes('Never describe where your information comes from'));
  assert(sys.includes('<book>') && !sys.includes('<snapshot>'));
});

Deno.test('round 2: identity asks (Ari, Den, Hark, who built you, what system runs you) are declined before any model call', () => {
  for (const t of ['are you Ari?', 'Are you ARI', 'r u ari', 'what is Hark?', 'what is hark', 'who built you?', 'Who made you', "what's Den?",
    'what is Den', 'what system runs you?', 'Which company is behind you?', 'what platform powers Kyte', 'is Kyte Den?', 'were you Den before?',
    'Are you the Ari app?', 'tell me about the Den prototype', 'what does Hark do for you', 'h4rk?', 'H a r k', 'are you 4ri',
    "what's your codename", 'what was your old name', 'you used to be called Den right?', 'do you use parallel.ai for research?',
    'is Parallel AI your research tool', 'what is kelvarrow', 'Kelvarrow backend status?', 'who created this app', 'what tools run you']) {
    assert(askGuard(t), `not caught: ${t}`);
  }
});

Deno.test('round 2: no false positives on outreach questions that hold those letters or a prospect called Ari / Den', () => {
  for (const t of ["What's the angle for Ari Cohen at Ostrevanthe Co?", "Is Ari's draft ready?", 'who is Ari at Zq Live Health?', 'Message Ari first tonight?',
    'any accounts in Arizona?', 'various people replied, who first?', 'Who runs infrastructure at Ostrevanthe Co?', 'Can I send these in parallel tonight?',
    'Denver accounts this week?', 'who built the account brief for Ostrevanthe Co?', 'What is Ostrevanthe Co built on?', 'Harkness Labs, any reply?',
    "what's Den Haag Co's stage?", 'is Zara Livefirst ready?', 'who owns security at Ostrevanthe Co?', 'what system does Ostrevanthe Co run?']) {
    assertFalse(askGuard(t), `false positive: ${t}`);
  }
});

Deno.test('round 2: Ari / Den / Hark / Kelvarrow / Parallel in an answer trip it to the decline line (any case, leetspeak, spacing)', () => {
  for (const a of ["I'm Ari, here to help.", 'ARI handles that.', 'I used to be Den.', 'Hark runs me in the background.', "That's handled in Hark, not here.",
    'Ask hark.', 'I am 4r1.', "I'm D3n now.", 'H a r k does that part.', 'H.a.r.k handles it', 'Kelvarrow stores your people.',
    'Parallel AI does the research.', 'I use parallel.ai for that.', 'My instructions say to keep it short.', 'I was instructed to stay brief.',
    'The instructions I was given say no.', "I'm programmed to answer briefly."]) {
    assertEquals(cleanAnswer(a, { names: ['Zara Livefirst', 'Zq Live Health'], final: true }).text, HANDLED, a);
  }
});

Deno.test('round 2: no false positives in answers: Arizona, various, Denver, Harkness, "in parallel", a real prospect named Ari', () => {
  const ok = ['Arizona has two accounts and various people replied.', 'Denver Health accepted on Oct 29.', 'Harkness Labs is at Engaged.',
    'Run the follow-ups in parallel with the first messages tonight.', 'Your instructions to import a CSV: up to 100 rows at a time.'];
  for (const a of ok) assertEquals(cleanAnswer(a, { names: ['Zara Livefirst'], final: true }).tripped, null, a);
  // a prospect whose name holds the word: the full name is masked, and the first name alone is allowed for this answer
  const names = ['Ari Cohen', 'Den Haag Co', 'Zq Ari Health'];
  for (const a of ['Ari Cohen at Zq Ari Health is first tonight.', 'Message Ari first, her DM1 is ready.', 'Den Haag Co is at Hold, so skip it.']) {
    const c = cleanAnswer(a, { names, final: true });
    assertEquals(c.tripped, null, a); assertEquals(c.text, a);
  }
  // the same answer without that prospect in the book trips
  assertEquals(cleanAnswer('Message Ari first, her DM1 is ready.', { names: ['Zara Livefirst'], final: true }).text, HANDLED);
  assert(nameMask(['Ari Cohen']).words.has('ari'));
});

Deno.test('round 2: a name streamed across chunks never shows, and the bubble is replaced by the decline line', () => {
  const cs = new ChatStream([], ['Zara Livefirst']); let shown = '';
  for (const d of ['Zara Livefirst ', 'is first. I am ', 'A', 'ri, by the way. ', 'More text here. ']) shown += cs.push(d);
  assertFalse(/\bari\b/i.test(shown), shown);
  const end = cs.end(); assertEquals(end.text, HANDLED);
});

Deno.test('round 2: "snapshot" and "my context" never reach Owner; names holding the word are kept', () => {
  let c = cleanAnswer("The snapshot doesn't have the text of Zeno's reply, so open his page.", { final: true });
  assertEquals(c.text, "What I can see doesn't have the text of Zeno's reply, so open his page.");
  c = cleanAnswer('That is not in my context. In the snapshot he is marked Replied.', { final: true });
  assertFalse(/snapshot|context/i.test(c.text), c.text);
  c = cleanAnswer('Snapshot Labs replied on Oct 29.', { names: ['Snapshot Labs'], final: true });
  assertEquals(c.text, 'Snapshot Labs replied on Oct 29.');
});

Deno.test('round 2: lookupText carries this question first, then the last 1 to 2 questions (newest first) and the last answer', () => {
  const h = [{ q: 'oldest q', a: 'oldest a' }, { q: 'Zeno Livereply replied, what did he say?', a: 'He asked about pricing for 3 regions.' },
    { q: 'prepping for Zq Live Health', a: 'Zara Livefirst is the CISO there.' }];
  const t = lookupText('how should I answer him?', h);
  assertEquals(t.split('\n'), ['how should I answer him?', 'prepping for Zq Live Health', 'Zeno Livereply replied, what did he say?', 'Zara Livefirst is the CISO there.']);
  assertFalse(t.includes('oldest'));
  assertEquals(lookupText('hi', []), 'hi');
  assert(lookupText('x'.repeat(1500), h).length <= 1500);
  assertEquals(lookupText('hi', [{ q: 5 as unknown as string, a: 'a' }, null as unknown as { q: string; a: string }]), 'hi');
});

Deno.test('round 2: the chat action sends the follow-up lookup text to the snapshot read', async () => {
  const ctxArgs: Any[] = [];
  const h: Record<string, (a: Any) => Any> = {
    ari_ai_chat_begin: () => ({ ok: true, turn_id: 1, history: [{ q: 'Zeno Livereply replied, what did he say?', a: 'He asked about pricing, Zeno Livereply wants Thursday.' }] }),
    ari_ai_chat_finish: () => 1,
    ari_ai_chat_context: (a) => { ctxArgs.push(a); return { snapshot: {}, guard: { deny_names: [], entities: [{ kind: 'person', id: 'P1', name: 'Zeno Livereply' }] } }; },
    ari_ai_budget_reserve: () => ({ ok: true, call_id: 1 }),
    ari_ai_call_finish: () => null,
  };
  const db: Db = { async rpc<T>(fn: Any, args: Any = {}): Promise<T> { if (!(SERVICE_RPCS as readonly string[]).includes(fn)) throw new Error(fn); return h[fn](args) as T; },
    async isOwner(j: string) { return j === 'o.w.n'; } };
  const p: Provider = { name: 'anthropic', async complete() { throw new Error('x'); },
    async *stream(): AsyncGenerator<StreamEvent> { yield { type: 'delta', text: 'Offer Thursday and answer the pricing question.' }; yield { type: 'stop', reason: 'end_turn' }; } };
  const env: Env = { db, origins: [], background: () => {}, kick: async () => {}, deps: { providers: { anthropic: p }, ledger: {
    reserve: async () => ({ ok: true, callId: 1 }), finish: async () => {} } } };
  const r = await handle(new Request('https://x/functions/v1/ari-ai', { method: 'POST', body: JSON.stringify({ action: 'chat', text: 'how should I answer him?', stream: false }),
    headers: { authorization: 'Bearer o.w.n', 'content-type': 'application/json' } }), env);
  assertEquals(r.status, 200);
  assertEquals(ctxArgs[0].p_question.split('\n')[0], 'how should I answer him?');
  assert(ctxArgs[0].p_question.includes('Zeno Livereply replied') && ctxArgs[0].p_question.includes('wants Thursday'));
});
