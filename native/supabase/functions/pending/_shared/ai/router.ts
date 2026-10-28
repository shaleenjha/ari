// Live AI layer (PENDING). Per-task routing table and cost estimates.
// Model ids are the ones Owner named on Oct 23 2026. Anthropic prices CHECKED Oct 23 2026 against
// platform.claude.com/docs/en/build-with-claude/prompt-caching (USD per million tokens; tool = USD per 1k web searches).
// grok-4.7 is still a PLACEHOLDER: confirm on x.ai before deploy. The spend guard reserves the
// worst case (max_tokens out) before a call and books the real usage after, so a wrong price skews the cap, never skips it.
import { Effort, ProviderName, Task, Thinking, Tool } from './types.ts';

export interface Route {
  provider: ProviderName;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  tools?: Tool[];
  maxToolUses?: number;
  temperature?: number;      // xAI only. Anthropic 5.5 models refuse it (400 "temperature is deprecated", live check Oct 23 2026)
  stream?: boolean;          // the endpoint may stream this task over SSE
  thinking?: Thinking;       // 'off' (Haiku): no thinking; 'between_tools' (Sonnet 5.5): no up-front thinking
  effort?: Effort;
  retries?: number;          // provider retries (default 1); 0 where a timed-out call may already be billed
}

export const ROUTES: Record<Task, Route> = {
  // Haiku: classification only
  classify: { provider: 'anthropic', model: 'claude-haiku-5-5', maxTokens: 300, timeoutMs: 12_000, thinking: 'off' },
  triage: { provider: 'anthropic', model: 'claude-haiku-5-5', maxTokens: 300, timeoutMs: 12_000, thinking: 'off' },
  // import fix options: pick which people-database candidate is the CSV row's person (judgment, so a cheap model)
  match_profile: { provider: 'anthropic', model: 'claude-haiku-5-5', maxTokens: 250, timeoutMs: 12_000, thinking: 'off' },
  // Opus: every draft (DM1/2/3, rewrites, reply drafts; motion drafts and connect notes must route through 'draft')
  draft: { provider: 'anthropic', model: 'claude-opus-5-5', maxTokens: 900, timeoutMs: 45_000, stream: true },
  rewrite: { provider: 'anthropic', model: 'claude-opus-5-5', maxTokens: 900, timeoutMs: 45_000, stream: true },
  reply_draft: { provider: 'anthropic', model: 'claude-opus-5-5', maxTokens: 1000, timeoutMs: 45_000 },
  // Sonnet + Anthropic web search: inline quick research
  // Oct 28 2026 fix (staging e2e: 1,675 out tokens > 1500 cap, reply cut before the JSON, $0.11 lost): no up-front thinking,
  // low effort, 4000 tokens of headroom (billed on use, not on the cap), answer through the strict save_research tool, no retry.
  quick_research: { provider: 'anthropic', model: 'claude-sonnet-5-5', maxTokens: 4000, timeoutMs: 90_000, tools: ['web_search'],
    maxToolUses: 3, thinking: 'between_tools', effort: 'low', retries: 0 },
  // Opus orchestrates deep research (one turn per call, client tool grok_search); Grok runs each search with X / web tools
  deep_research: { provider: 'anthropic', model: 'claude-opus-5-5', maxTokens: 2000, timeoutMs: 60_000 },
  signal_search: { provider: 'xai', model: 'grok-4.7', maxTokens: 1500, timeoutMs: 45_000, tools: ['x_search', 'web_search'],
    temperature: 0 },
};

export function route(task: Task): Route {
  const r = ROUTES[task];
  if (!r) throw new Error(`no route for task ${task}`);
  return r;
}

// in/out per 1M tokens; read = cache hit per 1M; write = 5-minute cache write per 1M (1.25x in); tool per 1k calls.
interface Price { in: number; out: number; read: number; write: number; tool: number }
export const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { in: 4, out: 20, read: 0.20, write: 5, tool: 10 },
  'claude-sonnet-5-5': { in: 2, out: 10, read: 0.10, write: 2.5, tool: 10 },
  // Haiku 5.5 rate for prompts up to 100k tokens (ours are far smaller; over 100k it is $0.50 / $2.50)
  'claude-haiku-5-5': { in: 0.10, out: 0.50, read: 0.01, write: 0.125, tool: 10 },
  'grok-4.7': { in: 3, out: 15, read: 3, write: 3, tool: 10 },      // placeholder, no cache discount assumed
};
const FALLBACK: Price = { in: 15, out: 75, read: 15, write: 18.75, tool: 25 };   // unknown model: price high so the cap bites early

/** tokensIn = uncached input only (Anthropic's input_tokens); cached reads and writes are billed at their own rates. */
export function costUsd(model: string, tokensIn: number, tokensOut: number, toolCalls = 0, cacheRead = 0, cacheWrite = 0): number {
  const p = PRICES[model] ?? FALLBACK;
  return round5((tokensIn * p.in + tokensOut * p.out + cacheRead * p.read + cacheWrite * p.write) / 1e6 + (toolCalls * p.tool) / 1e3);
}

/** Worst-case reservation: estimated prompt tokens (chars / 3.5, generous) + max output + every allowed tool call. Web
 *  search results are billed as input tokens too, so each tool use adds a 6k-token allowance. */
export function reserveUsd(task: Task, promptChars: number, steps = 1): number {
  const r = route(task);
  const toolUses = (r.tools?.length ? (r.maxToolUses ?? 6) : 0) * steps;
  const inTok = Math.ceil(promptChars / 3.5) * steps + toolUses * 6000;
  // Worst case assumes every input token is a cache WRITE (1.25x): reservations never under-cover a cold cache.
  return costUsd(r.model, 0, r.maxTokens * steps, toolUses, 0, inTok);
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
