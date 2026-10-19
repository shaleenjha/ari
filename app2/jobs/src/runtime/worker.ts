// Job runtime skeleton. One small Node process claims one job at a time (SQL: app.job_claim, FOR UPDATE SKIP LOCKED, 5-min
// lease), runs the handler for the job's kind under a hard timeout below the lease, and finishes it with app.job_finish, fenced by
// (worker, attempt): done, retry with jittered backoff, dead (max attempts or non-retryable), or 'stale' when the lease was
// lost, which the runtime ignores. agent.* (LLM) handlers plug into the same registry later with cost recording.
export interface Job { id: string; workspaceId: string; kind: string; payload: unknown; attempts: number; maxAttempts: number }
export interface Finish { ok: boolean; result?: unknown; error?: string; retryable?: boolean }
export type FinishResult = 'done' | 'retry' | 'dead' | 'stale' | 'missing';
export interface JobStore {
  claim(worker: string, kinds: string[], n: number): Promise<Job[]>;
  /** app.job_finish(id, worker, attempt, ok, result, error, retryable). `attempt` is the job's attempts from claim. */
  finish(id: string, worker: string, attempt: number, f: Finish): Promise<FinishResult>;
}
/** Handlers get an AbortSignal; pass it to fetch / provider SDKs so a timed-out call is cancelled, not left running. */
export type Handler = (job: Job, signal: AbortSignal) => Promise<unknown>;

/** Must equal the lease in SQL: app.job_claim sets locked_until = now() + interval '5 minutes'
 *  (app2/db/migrations/0005_job_fencing.sql). Change both together. */
export const LEASE_SECONDS = 300;
export const HANDLER_TIMEOUT_MS = 240_000;   // hard stop 60 s before the lease expires, so a hung call cannot double-run

/** Throw from a handler when retrying cannot help (bad payload, permanent 4xx). The job goes straight to dead. */
export class NonRetryableError extends Error { override name = 'NonRetryableError'; }
export class JobTimeoutError extends Error { override name = 'JobTimeoutError'; }

/** Mirrors app.job_finish: 30 s * 2^(n-1) capped at 1 h, then +/-20% jitter. `rand` in [0, 1) is injectable for tests. */
export const backoffSeconds = (attempts: number, rand: () => number = Math.random): number =>
  Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1)) * (0.8 + 0.4 * rand());

/** Runs h with an AbortSignal; rejects with JobTimeoutError after ms even if h ignores the signal. */
export async function runWithTimeout(h: Handler, job: Job, ms: number): Promise<unknown> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new JobTimeoutError(`${job.kind} timed out after ${ms} ms`);
      ac.abort(err);
      reject(err);
    }, ms);
  });
  try {
    // h is called inside the try, so a synchronous throw rejects here and the timer is still cleared
    return await Promise.race([h(job, ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface RuntimeOptions { worker?: string; timeoutMs?: number }

export class Runtime {
  private handlers = new Map<string, Handler>();
  readonly worker: string;
  readonly timeoutMs: number;
  constructor(private store: JobStore, opts: RuntimeOptions = {}) {
    this.worker = opts.worker ?? `w-${process.pid}`;
    this.timeoutMs = opts.timeoutMs ?? HANDLER_TIMEOUT_MS;
    if (!(this.timeoutMs > 0 && this.timeoutMs < LEASE_SECONDS * 1000)) {
      throw new Error(`timeoutMs must be between 0 and the ${LEASE_SECONDS} s lease`);
    }
  }
  register(kind: string, h: Handler): this { this.handlers.set(kind, h); return this; }
  /**
   * Runs up to `max` jobs, one at a time: claim ONE job, run it, finish it, then claim the next. Claiming a batch and
   * running it sequentially would start every lease at the batch's claim time, so later jobs could outlive their lease
   * and be reclaimed by another worker while still running. Claiming per job starts each lease when its run starts,
   * and the handler timeout (below the lease) bounds it. Stops early when nothing is ready.
   */
  async tick(max = 5): Promise<{ ran: number; failed: number; stale: number }> {
    const kinds = [...this.handlers.keys()];
    let ran = 0, failed = 0, stale = 0;
    while (ran < max) {
      const [j] = await this.store.claim(this.worker, kinds, 1);
      if (!j) break;
      ran++;
      const f = await this.run(j);
      if (!f.ok) failed++;
      // 'stale': our lease expired and another worker owns the job (or it already finished); the DB kept its state.
      if ((await this.store.finish(j.id, this.worker, j.attempts, f)) === 'stale') stale++;
    }
    return { ran, failed, stale };
  }
  private async run(j: Job): Promise<Finish> {
    const h = this.handlers.get(j.kind);
    try {
      if (!h) throw new NonRetryableError(`no handler for ${j.kind}`);
      return { ok: true, result: await runWithTimeout(h, j, this.timeoutMs) };
    } catch (e) {   // also catches a handler that throws synchronously instead of rejecting
      return { ok: false, error: e instanceof Error ? e.message : String(e), retryable: !(e instanceof NonRetryableError) };
    }
  }
}
