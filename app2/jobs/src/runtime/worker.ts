// Job runtime skeleton. One small Node process claims jobs (SQL: app.job_claim, FOR UPDATE SKIP LOCKED), runs the
// handler for the job's kind, and finishes it (app.job_finish: done, or retry with backoff, or dead after max attempts).
// Deterministic handlers only here; agent.* (LLM) handlers plug into the same registry later with cost recording.
export interface Job { id: string; workspaceId: string; kind: string; payload: unknown; attempts: number; maxAttempts: number }
export interface JobStore {
  claim(worker: string, kinds: string[], n: number): Promise<Job[]>;
  finish(id: string, ok: boolean, result: unknown, error?: string): Promise<void>;
}
export type Handler = (job: Job) => Promise<unknown>;

/** Exponential backoff with a cap, mirrored by app.job_finish: 30 s, 60 s, 120 s ... max 1 h. */
export const backoffSeconds = (attempts: number): number => Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));

export class Runtime {
  private handlers = new Map<string, Handler>();
  constructor(private store: JobStore, private worker = `w-${process.pid}`) {}
  register(kind: string, h: Handler): this { this.handlers.set(kind, h); return this; }
  async tick(n = 5): Promise<{ ran: number; failed: number }> {
    const jobs = await this.store.claim(this.worker, [...this.handlers.keys()], n);
    let failed = 0;
    for (const j of jobs) {
      const h = this.handlers.get(j.kind);
      try {
        if (!h) throw new Error(`no handler for ${j.kind}`);
        await this.store.finish(j.id, true, await h(j));
      } catch (e) {
        failed++;
        await this.store.finish(j.id, false, null, e instanceof Error ? e.message : String(e));
      }
    }
    return { ran: jobs.length, failed };
  }
}
