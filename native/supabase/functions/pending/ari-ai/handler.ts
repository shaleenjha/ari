// ari-ai request handler (wiring in index.ts). Edge function (PENDING, not deployed; needs S1 R7 live first: it reads its own named secret key ari_ai, apikey header
// only, no legacy fallback). Deploy with Verify JWT OFF: the function checks every caller itself.
//   App (owner only):  POST {action, ...} with the app's own session (Authorization: Bearer <user JWT>). The owner check runs
//                      in the database as that user (ari_ai_caller -> is_owner(), so the aal2 rule applies).
//     rewrite        {draft_id: "<person>:dm1|dm2|dm3" | "reply:<id>:book|answer|soft", chip?, instruction?, stream?}
//     draft_dm1      {person_id, source?: "accepted_tap" | "redraft", stream?}
//     quick_research {person_id, focus?}             inline, about 15 s (Sonnet + web search)
//     deep_research  {person_id, focus?}             returns {job_id}; the task card follows ai_jobs (Grok, multi-step)
//     triage_reply   {reply_id}                      Haiku classifies intent; Opus drafts book, answer, soft
//     import_resolve {rows: [{name, company, title?, location?, linkedin_url?}] (max 100)}  returns the prepared import plan, writes nothing
//     job_stream     {job_id, since?}                SSE live feed of a deep research job: `progress` per event
//                                                    (query / read / finding / status / error), then `done`; `reconnect` {since}
//   Internal (x-ari-hook = vault ari_ai_hook_secret): {internal: "process"} from the 10-min cron and ari-gmail-push;
//     {internal: "pipeline"} from the 0047 enqueue kick and the 1-min cron: drains the pgmq job line (pipeline.ts);
//     {internal: "run_job", job_id} to continue a deep research job.
// Writes go only to draft / research fields and the ai_* tables, through an RPC allowlist (db.ts). Nothing is ever sent to
// LinkedIn or anyone else; there is no endpoint that reads or changes app config, and errors never name infrastructure.
import { BudgetRefused, Deps, InvalidOutput } from '../_shared/ai/run.ts';
import { safeEq } from '../_shared/ai/http.ts';
export { safeEq };
import { BadRequest, draftDm1, importResolve, personId, quickResearch, rewrite, triageReply } from './actions.ts';
import type { PeopleLookup } from '../_shared/import/lemlist.ts';
import { Db, RpcError } from './db.ts';
import { processPending } from './events.ts';
import { enqueueDeep, runJob } from './jobs.ts';
import { enqueueResearch, runPipeline } from './pipeline.ts';

export const ACTIONS = ['rewrite', 'draft_dm1', 'quick_research', 'deep_research', 'triage_reply', 'import_resolve', 'job_stream'] as const;
const STREAMABLE = new Set(['rewrite', 'draft_dm1']);
const MAX_BODY = 8_192;
const MAX_IMPORT_BODY = 65_536;          // a 100-row CSV; only import_resolve may use it

export interface Env {
  db: Db;
  deps: Deps;
  kick: (body: Record<string, unknown>) => Promise<void>;
  background: (p: Promise<unknown>) => void;
  origins: string[];
  sleep?: (ms: number) => Promise<void>;
  streamMs?: number;
  lookup?: PeopleLookup;     // tests only; production uses defaultLookup (Brave, then lemlist)
  pipeline?: import('./pipeline.ts').PipelineOpts;   // tests only (fake Parallel transport, clock)
}

function cors(req: Request, origins: string[]): Record<string, string> {
  const o = req.headers.get('origin') ?? '';
  return origins.includes(o) ? { 'Access-Control-Allow-Origin': o, Vary: 'Origin', 'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS' } : {};
}
const json = (b: unknown, status: number, h: Record<string, string>) => Response.json(b, { status, headers: h });

/** Map an error to a short, infrastructure-free answer for the app. */
export function errorBody(e: unknown): { status: number; body: { error: string; reason?: string } } {
  if (e instanceof BadRequest) return { status: 400, body: { error: 'bad_request', reason: e.message } };
  if (e instanceof BudgetRefused) return { status: 429, body: { error: 'spend_limit', reason: e.reason } };
  if (e instanceof InvalidOutput) return { status: 502, body: { error: 'draft_failed' } };
  if (e instanceof RpcError && e.status === 404) return { status: 404, body: { error: 'not_found' } };
  if (e instanceof RpcError && e.status === 403) return { status: 403, body: { error: 'not_allowed' } };
  return { status: 500, body: { error: 'failed' } };
}

export async function handle(req: Request, env: Env): Promise<Response> {
  const h = cors(req, env.origins);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
  if (req.method !== 'POST') return json({ error: 'method' }, 405, h);
  const raw = await req.text();
  if (raw.length > MAX_IMPORT_BODY) return json({ error: 'too_large' }, 413, h);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw || '{}'); if (!body || typeof body !== 'object' || Array.isArray(body)) throw 0; }
  catch { return json({ error: 'bad_request' }, 400, h); }
  if (raw.length > MAX_BODY && body.action !== 'import_resolve') return json({ error: 'too_large' }, 413, h);

  // ---------- internal (cron, ari-gmail-push, self-continuation) ----------
  const hook = req.headers.get('x-ari-hook');
  if (hook !== null) {
    if (!safeEq(hook, await env.db.rpc<string>('ari_ai_hook'))) return json({ error: 'unauthorized' }, 401, {});
    // answer at once (pg_net / Pub/Sub / the self-kick do not wait); the work runs in the background of this invocation
    if (body.internal === 'process') {
      env.background((async () => {
        await processPending(env.db, env.deps);
        if ((await runJob(env.db, env.deps, null)) === 'yield') await env.kick({ internal: 'run_job', job_id: null });
      })());
      return json({ ok: true, accepted: 'process' }, 202, {});
    }
    if (body.internal === 'pipeline') {
      env.background((async () => {
        const r = await runPipeline(env.db, env.deps, env.pipeline);
        if (r.more) await env.kick({ internal: 'pipeline' });
      })());
      return json({ ok: true, accepted: 'pipeline' }, 202, {});
    }
    if (body.internal === 'run_job') {
      const id = typeof body.job_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.job_id) ? body.job_id : null;
      env.background((async () => {
        if ((await runJob(env.db, env.deps, id)) === 'yield') await env.kick({ internal: 'run_job', job_id: id });
      })());
      return json({ ok: true, accepted: 'run_job' }, 202, {});
    }
    return json({ error: 'bad_request' }, 400, {});
  }

  // ---------- app (owner only) ----------
  const auth = req.headers.get('authorization') ?? '';
  const jwt = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!jwt || !(await env.db.isOwner(jwt))) return json({ error: 'unauthorized' }, 401, h);
  const action = body.action;
  if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) return json({ error: 'bad_request' }, 400, h);
  const run = (onDelta?: (t: string) => Promise<void>): Promise<unknown> => {
    switch (action) {
      case 'rewrite': return rewrite(env.db, env.deps, body, onDelta);
      case 'draft_dm1': {
        const pid = personId(body.person_id);
        // 0047: an "Accepted" tap starts the pipeline (research -> brief -> dm1); it never drafts before research
        if (body.source === 'accepted_tap' && !onDelta) return enqueueResearch(env.db, pid).then((j) => ({ status: 'queued', job_id: j.job_id, existing: j.existing }));
        return draftDm1(env.db, env.deps, pid, 'manual', onDelta);
      }
      case 'quick_research': return quickResearch(env.db, env.deps, personId(body.person_id),
        typeof body.focus === 'string' ? body.focus : undefined);
      case 'deep_research': return enqueueDeep(env.db, body.person_id, body.focus).then((j) => {
        if (!j.existing) env.background(env.kick({ internal: 'run_job', job_id: j.id }));
        return { job_id: j.id, existing: j.existing };
      });
      case 'triage_reply': return triageReply(env.db, env.deps, body.reply_id);
      case 'import_resolve': return importResolve(env.db, env.deps, body, env.lookup);
    }
    throw new BadRequest('action');
  };

  if (action === 'job_stream') return jobStream(env, body, h);
  if (body.stream === true && STREAMABLE.has(action)) return sse(run, h);
  try { return json(await run(), 200, h); }
  catch (e) { const r = errorBody(e); return json(r.body, r.status, h); }
}

/** Server-sent events: `delta` {t} while the model writes, then `done` {result} or `error` {error}. */
function sse(run: (onDelta: (t: string) => Promise<void>) => Promise<unknown>, h: Record<string, string>): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const send = (ev: string, data: unknown) => c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
      try { const result = await run((t) => { send('delta', { t }); return Promise.resolve(); }); send('done', result); }
      catch (e) { send('error', errorBody(e).body); }
      finally { c.close(); }
    },
  });
  return new Response(stream, { headers: { ...h, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}

/** SSE relay of ai_jobs.steps for one job: polls the job's events by seq (1 s), sends each new one as `progress`, then `done`
 *  {status, result} when the job ends. After streamMs it sends `reconnect` {since} so the app reopens from where it was. */
function jobStream(env: Env, body: Record<string, unknown>, h: Record<string, string>): Response {
  const id = typeof body.job_id === 'string' && /^[0-9a-f-]{36}$/i.test(body.job_id) ? body.job_id : null;
  if (!id) return json({ error: 'bad_request' }, 400, h);
  let since = Number.isInteger(body.since) ? Number(body.since) : 0;
  const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const limit = env.streamMs ?? 120_000, t0 = Date.now();
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      const send = (ev: string, data: unknown) => c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`));
      try {
        while (true) {
          // deno-lint-ignore no-explicit-any
          const r: any = await env.db.rpc('ari_ai_job_events', { p_id: id, p_since: since });
          if (!r) { send('error', { error: 'not_found' }); break; }
          for (const e of r.events ?? []) { send('progress', e); since = Math.max(since, Number(e.seq) || since); }
          if (r.status === 'done' || r.status === 'failed') { send('done', { status: r.status, result: r.result ?? null }); break; }
          if (Date.now() - t0 > limit) { send('reconnect', { since }); break; }
          await sleep(1000);
        }
      } catch (e) { send('error', errorBody(e).body); }
      finally { c.close(); }
    },
  });
  return new Response(stream, { headers: { ...h, 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' } });
}
