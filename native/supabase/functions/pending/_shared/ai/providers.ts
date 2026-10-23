// Live AI layer (PENDING). Adapters: Anthropic (Messages API), xAI (Responses API with web_search + x_search), OpenAI (backup
// stub, not routed by default). Keys come ONLY from env ANTHROPIC_API_KEY / XAI_API_KEY / OPENAI_API_KEY at call time. A key is
// sent in its provider's auth header and nowhere else: never logged, never returned, never in an error message.
import { guardedFetch } from './http.ts';
import { AiRequest, AiResponse, Citation, NotConfigured, Provider, StreamEvent } from './types.ts';

const env = (k: string): string | undefined => { try { return Deno.env.get(k) || undefined; } catch { return undefined; } };
const ANTHROPIC_VERSION = '2023-06-01';

// ---------------- Anthropic ----------------
// Live check Oct 23 2026 (key ari-edge): the 5.5 models answer 400 to any `temperature`, so it is never sent here. Only Haiku
// accepts thinking {type: 'disabled'} (Sonnet wants 'between_tools', Opus 'adaptive' + effort), so only Haiku routes set thinking 'off'.
export function anthropicBody(req: AiRequest, stream: boolean) {
  const server = (req.tools ?? []).includes('web_search')
    ? [{ type: 'web_search_20250305', name: 'web_search', max_uses: req.maxToolUses ?? 5 }] : [];
  const tools = [...server, ...(req.clientTools ?? [])];
  // Breakpoint on the LAST block that never changes between calls (the system prompt). Never on the user turn: a breakpoint
  // on changing content writes a new entry every call and never reads one.
  const system = req.cache ? [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }] : req.system;
  const auto = req.cache === 'conversation' ? { cache_control: { type: 'ephemeral' } } : {};
  return JSON.stringify({ model: req.model, max_tokens: req.maxTokens, system, messages: req.messages, ...auto,
    ...(req.thinking === 'off' ? { thinking: { type: 'disabled' } } : {}), ...(tools.length ? { tools } : {}), ...(stream ? { stream: true } : {}) });
}
function anthropicHeaders(): Record<string, string> {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) throw new NotConfigured('anthropic');
  return { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' };
}
// deno-lint-ignore no-explicit-any
export function parseAnthropic(j: any, model: string): AiResponse {
  const blocks = Array.isArray(j?.content) ? j.content : [];
  const cites: Citation[] = [];
  const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
  let text = '';
  for (const b of blocks) {
    if (b?.type === 'tool_use' && typeof b.id === 'string') toolUses.push({ id: b.id, name: String(b.name), input: b.input ?? {} });
    if (b?.type !== 'text' || typeof b.text !== 'string') continue;
    text += b.text;
    for (const c of b.citations ?? []) if (typeof c?.url === 'string') cites.push({ url: c.url, title: c.title });
  }
  return { provider: 'anthropic', model: j?.model ?? model, text, tokensIn: Number(j?.usage?.input_tokens ?? 0),
    tokensOut: Number(j?.usage?.output_tokens ?? 0), toolCalls: Number(j?.usage?.server_tool_use?.web_search_requests ?? 0),
    cacheRead: Number(j?.usage?.cache_read_input_tokens ?? 0), cacheWrite: Number(j?.usage?.cache_creation_input_tokens ?? 0),
    citations: dedupeCites(cites), toolUses, content: blocks, stopReason: j?.stop_reason };
}
export const anthropic: Provider = {
  name: 'anthropic',
  async complete(req) {
    const r = await guardedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: anthropicHeaders(),
      body: anthropicBody(req, false) }, { timeoutMs: req.timeoutMs });
    return parseAnthropic(await r.json(), req.model);
  },
  async *stream(req) {
    const r = await guardedFetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: anthropicHeaders(),
      body: anthropicBody(req, true) }, { timeoutMs: req.timeoutMs });
    for await (const ev of readSse(r, req.timeoutMs)) {
      // deno-lint-ignore no-explicit-any
      let j: any; try { j = JSON.parse(ev.data); } catch { continue; }
      if (j.type === 'content_block_delta' && j.delta?.type === 'text_delta') yield { type: 'delta', text: String(j.delta.text ?? '') };
      else if (j.type === 'message_start') yield { type: 'usage', tokensIn: Number(j.message?.usage?.input_tokens ?? 0),
        cacheRead: Number(j.message?.usage?.cache_read_input_tokens ?? 0), cacheWrite: Number(j.message?.usage?.cache_creation_input_tokens ?? 0) };
      else if (j.type === 'message_delta') yield { type: 'usage', tokensOut: Number(j.usage?.output_tokens ?? 0) };
      else if (j.type === 'error') throw new Error('anthropic stream error');
    }
  },
};

// ---------------- xAI (Grok, Responses API, server-side agentic tools) ----------------
// deno-lint-ignore no-explicit-any
export function parseResponsesApi(j: any, model: string, provider: 'xai' | 'openai'): AiResponse {
  let text = typeof j?.output_text === 'string' ? j.output_text : '';
  const cites: Citation[] = [];
  let tools = 0;
  for (const item of Array.isArray(j?.output) ? j.output : []) {
    if (item?.type === 'message') {
      for (const c of item.content ?? []) {
        if (c?.type === 'output_text' && typeof c.text === 'string' && !j?.output_text) text += c.text;
        for (const a of c?.annotations ?? []) if (typeof a?.url === 'string') cites.push({ url: a.url, title: a.title });
      }
    } else if (typeof item?.type === 'string' && /_call$/.test(item.type)) tools++;
  }
  for (const u of Array.isArray(j?.citations) ? j.citations : []) if (typeof u === 'string') cites.push({ url: u });
  const u = j?.usage ?? {};
  const toolCalls = Number(u.num_server_side_tools_used ?? 0) || tools;
  return { provider, model: j?.model ?? model, text, tokensIn: Number(u.input_tokens ?? 0), tokensOut: Number(u.output_tokens ?? 0),
    toolCalls, citations: dedupeCites(cites) };
}
function responsesBody(req: AiRequest, toolsOk: boolean) {
  const tools = toolsOk ? (req.tools ?? []).map((t) => ({ type: t })) : [];
  return JSON.stringify({ model: req.model, max_output_tokens: req.maxTokens,
    input: [{ role: 'system', content: req.system }, ...req.messages], ...(tools.length ? { tools } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}) });
}
export const xai: Provider = {
  name: 'xai',
  async complete(req) {
    const key = env('XAI_API_KEY');
    if (!key) throw new NotConfigured('xai');
    const r = await guardedFetch('https://api.x.ai/v1/responses', { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: responsesBody(req, true) },
      { timeoutMs: req.timeoutMs });
    return parseResponsesApi(await r.json(), req.model, 'xai');
  },
};

// ---------------- OpenAI (backup stub: not in the routing table; enable per task only after its own review) ----------------
export const openai: Provider = {
  name: 'openai',
  async complete(req) {
    const key = env('OPENAI_API_KEY');
    if (!key) throw new NotConfigured('openai');
    const r = await guardedFetch('https://api.openai.com/v1/responses', { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: responsesBody(req, false) },
      { timeoutMs: req.timeoutMs });
    return parseResponsesApi(await r.json(), req.model, 'openai');
  },
};

export const PROVIDERS: Record<string, Provider> = { anthropic, xai, openai };

// ---------------- helpers ----------------
function dedupeCites(c: Citation[]): Citation[] {
  const seen = new Set<string>(); const out: Citation[] = [];
  for (const x of c) if (/^https?:\/\//i.test(x.url) && !seen.has(x.url)) { seen.add(x.url); out.push(x); }
  return out.slice(0, 20);
}

/** Minimal SSE reader with an idle timeout (a stalled stream is aborted, never left hanging). */
export async function* readSse(r: Response, idleMs: number): AsyncGenerator<{ event?: string; data: string }> {
  if (!r.body) return;
  const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
  try {
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error('stream idle timeout')), idleMs); });
      const { value, done } = await Promise.race([reader.read(), idle]).finally(() => clearTimeout(timer));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        let event: string | undefined; const data: string[] = [];
        for (const line of chunk.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).trim());
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
  } finally { reader.cancel().catch(() => {}); }
}

export type { StreamEvent };
