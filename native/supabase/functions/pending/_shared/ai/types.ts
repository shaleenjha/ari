// Live AI layer (PENDING). Provider-neutral request/response types.

// Owner, Oct 23 2026 15:11 IST: ALL drafting on claude-opus-5-5 (draft, rewrite, reply_draft; future motion drafts and connect
// notes use the 'draft' route too). Haiku only classifies (classify = accept match, triage = reply intent). quick_research on
// Sonnet + web search. deep_research = Opus orchestrating, with Grok 4.7 (x_search / web_search) as its tool (signal_search).
export type Task = 'classify' | 'triage' | 'match_profile' | 'draft' | 'rewrite' | 'reply_draft' | 'quick_research' | 'deep_research' | 'signal_search';
export type ProviderName = 'anthropic' | 'xai' | 'openai';
export type Tool = 'web_search' | 'x_search';

// deno-lint-ignore no-explicit-any
export type Block = Record<string, any>;                  // Anthropic content block (text, tool_use, tool_result)
export interface AiMessage { role: 'user' | 'assistant'; content: string | Block[] }
/** A client-side tool the model may call (Anthropic custom tool). The caller executes it and replies with tool_result. */
export interface ClientTool { name: string; description: string; input_schema: Record<string, unknown> }
export interface ToolUse { id: string; name: string; input: Record<string, unknown> }
export interface AiRequest {
  model: string;
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  temperature?: number;
  tools?: Tool[];
  maxToolUses?: number;
  clientTools?: ClientTool[];
  timeoutMs: number;
  /** Prompt caching (Anthropic). 'system': cache the fixed system prompt only (one-shot tasks; the user turn changes every
   *  call, so it must stay after the breakpoint). 'conversation': also let the cache follow a growing tool loop. Prefixes
   *  under the model's minimum (512 tokens on the 5.5 models) are simply not cached: no error, no extra charge. */
  cache?: 'system' | 'conversation';
  /** 'off' sends thinking {type: 'disabled'} (Anthropic). Live check Oct 23 2026: Haiku 5.5 can spend a small max_tokens budget on
   *  thinking and return no text, so short JSON tasks turn it off. */
  thinking?: 'off';
}
export interface Citation { url: string; title?: string }
export interface AiResponse {
  provider: ProviderName;
  model: string;
  text: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  cacheRead?: number;            // input tokens served from the prompt cache (billed at the read rate)
  cacheWrite?: number;           // input tokens written to the cache (billed at the 5-minute write rate)
  citations: Citation[];
  toolUses?: ToolUse[];          // client tool calls the model asked for (stop_reason tool_use)
  content?: Block[];             // raw assistant content, replayed on the next turn of a tool loop
  stopReason?: string;
}
export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; tokensIn?: number; tokensOut?: number; toolCalls?: number; cacheRead?: number; cacheWrite?: number };

export interface Provider {
  name: ProviderName;
  complete(req: AiRequest): Promise<AiResponse>;
  stream?(req: AiRequest): AsyncGenerator<StreamEvent>;
}

/** Raised when the provider has no key configured. Message never carries a key. */
export class NotConfigured extends Error { constructor(p: string) { super(`${p} not configured`); } }
