import { afterEach, describe, expect, it, vi } from 'vitest';
import { HANDLER_TIMEOUT_MS, LEASE_SECONDS, NonRetryableError, Runtime, backoffSeconds, runWithTimeout,
  type Finish, type FinishResult, type Handler, type Job, type JobStore } from './worker';

const job = (id: string, kind: string, attempts = 1): Job => ({ id, workspaceId: 'ws', kind, payload: {}, attempts, maxAttempts: 5 });

/** Queue-backed fake: claim hands out at most n jobs and records each job's claim time; finish records its time. */
function fakeStore(jobs: Job[], answer: (id: string) => FinishResult = () => 'done') {
  const queue = [...jobs];
  const calls: Array<{ id: string; worker: string; attempt: number; f: Finish; at: number }> = [];
  const claims: Array<{ n: number; ids: string[]; at: number }> = [];
  const store: JobStore = {
    claim: async (_w, _k, n) => { const got = queue.splice(0, n); claims.push({ n, ids: got.map((j) => j.id), at: Date.now() }); return got; },
    finish: async (id, worker, attempt, f) => { calls.push({ id, worker, attempt, f, at: Date.now() }); return answer(id); },
  };
  return { store, calls, claims };
}

afterEach(() => { vi.useRealTimers(); });

describe('backoff (mirrors app.job_finish)', () => {
  it('30 s * 2^(n-1), capped at 1 h, with no jitter at rand 0.5', () => {
    expect([1, 2, 3, 20].map((a) => backoffSeconds(a, () => 0.5))).toEqual([30, 60, 120, 3600]);
  });
  it('jitter stays within +/-20%', () => {
    expect(backoffSeconds(1, () => 0)).toBeCloseTo(24);
    expect(backoffSeconds(1, () => 0.999999)).toBeCloseTo(36, 3);
    expect(backoffSeconds(20, () => 0)).toBeCloseTo(2880);
    for (let i = 0; i < 200; i++) { const s = backoffSeconds(3); expect(s).toBeGreaterThanOrEqual(96); expect(s).toBeLessThan(144); }
  });
});

describe('timeout and abort', () => {
  it('default timeout is below the lease', () => { expect(HANDLER_TIMEOUT_MS).toBeLessThan(LEASE_SECONDS * 1000); });
  it('rejects a timeout at or above the lease', () => {
    const { store } = fakeStore([]);
    expect(() => new Runtime(store, { timeoutMs: LEASE_SECONDS * 1000 })).toThrow(/lease/);
    expect(() => new Runtime(store, { timeoutMs: 0 })).toThrow(/lease/);
  });
  it('aborts the signal passed to the handler and finishes as a retryable failure', async () => {
    let seen: AbortSignal | undefined;
    const hang = (_j: Job, signal: AbortSignal) => { seen = signal; return new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason))); };
    const { store, calls } = fakeStore([job('j1', 'slow')]);
    const r = await new Runtime(store, { worker: 'w1', timeoutMs: 20 }).register('slow', hang).tick();
    expect(seen?.aborted).toBe(true);
    expect(r).toEqual({ ran: 1, failed: 1, stale: 0 });
    expect(calls[0]).toMatchObject({ id: 'j1', worker: 'w1', attempt: 1, f: { ok: false, retryable: true } });
    expect(calls[0]?.f.error).toMatch(/timed out after 20 ms/);
  });
  it('still finishes when the handler ignores the signal', async () => {
    const t0 = Date.now();
    await expect(runWithTimeout(() => new Promise(() => {}), job('j', 'k'), 20)).rejects.toThrow(/timed out/);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
  it('a fast handler is not aborted', async () => {
    let seen: AbortSignal | undefined;
    await expect(runWithTimeout(async (_j, s) => { seen = s; return 7; }, job('j', 'k'), 50)).resolves.toBe(7);
    await new Promise((r) => setTimeout(r, 80));
    expect(seen?.aborted).toBe(false);
  });
});

describe('lease: one claim per job', () => {
  it('claims one job at a time and stops when nothing is ready', async () => {
    const { store, claims } = fakeStore([job('j1', 'ok'), job('j2', 'ok')]);
    const r = await new Runtime(store).register('ok', async () => 1).tick();
    expect(r).toEqual({ ran: 2, failed: 0, stale: 0 });
    expect(claims.map((c) => [c.n, c.ids])).toEqual([[1, ['j1']], [1, ['j2']], [1, []]]);
  });
  it('respects max', async () => {
    const { store, claims } = fakeStore([job('j1', 'ok'), job('j2', 'ok'), job('j3', 'ok')]);
    expect(await new Runtime(store).register('ok', async () => 1).tick(2)).toEqual({ ran: 2, failed: 0, stale: 0 });
    expect(claims.length).toBe(2);
  });
  it('two slow handlers: neither runs past its own lease', async () => {
    vi.useFakeTimers();
    // both hang until the default 240 s timeout; a batch claim would leave j2 running 480 s after its claim
    const hang = (_j: Job, signal: AbortSignal) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(signal.reason)));
    const { store, calls, claims } = fakeStore([job('j1', 'slow'), job('j2', 'slow')]);
    const done = new Runtime(store, { worker: 'w1' }).register('slow', hang).tick();
    await vi.advanceTimersByTimeAsync(2 * HANDLER_TIMEOUT_MS + 1000);
    expect(await done).toEqual({ ran: 2, failed: 2, stale: 0 });
    for (const id of ['j1', 'j2']) {
      const claimedAt = claims.find((c) => c.ids.includes(id))!.at;
      const finishedAt = calls.find((c) => c.id === id)!.at;
      expect(finishedAt - claimedAt).toBeLessThan(LEASE_SECONDS * 1000);
      expect(finishedAt - claimedAt).toBeGreaterThanOrEqual(HANDLER_TIMEOUT_MS);
    }
  });
});

describe('finish: fencing, non-retryable, stale', () => {
  it('a handler that throws synchronously finishes as a retryable failure and the next job still runs', async () => {
    const { store, calls } = fakeStore([job('j1', 'sync'), job('j2', 'ok')]);
    const sync: Handler = () => { throw new Error('sync boom'); };
    const r = await new Runtime(store).register('sync', sync).register('ok', async () => 2).tick();
    expect(r).toEqual({ ran: 2, failed: 1, stale: 0 });
    expect(calls[0]?.f).toEqual({ ok: false, error: 'sync boom', retryable: true });
    expect(calls[1]?.f).toEqual({ ok: true, result: 2 });
  });
  it('a sync throw clears the timeout timer', async () => {
    vi.useFakeTimers();
    await expect(runWithTimeout(() => { throw new Error('now'); }, job('j', 'k'), 1000)).rejects.toThrow('now');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('passes worker and attempt, records ok and failures', async () => {
    const { store, calls } = fakeStore([job('j1', 'ok', 2), job('j2', 'boom', 3)]);
    const r = await new Runtime(store, { worker: 'w9' }).register('ok', async () => 1)
      .register('boom', async () => { throw new Error('x'); }).tick();
    expect(r).toEqual({ ran: 2, failed: 1, stale: 0 });
    expect(calls.map((c) => [c.id, c.worker, c.attempt, c.f.ok, c.f.retryable])).toEqual([
      ['j1', 'w9', 2, true, undefined], ['j2', 'w9', 3, false, true]]);
    expect(calls[0]?.f.result).toBe(1);
  });
  it('NonRetryableError finishes with retryable=false', async () => {
    const { store, calls } = fakeStore([job('j1', 'bad')]);
    await new Runtime(store).register('bad', async () => { throw new NonRetryableError('bad payload'); }).tick();
    expect(calls[0]?.f).toEqual({ ok: false, error: 'bad payload', retryable: false });
  });
  it("'stale' from the store is counted and ignored, and the next job still runs", async () => {
    const { store, calls } = fakeStore([job('j1', 'ok'), job('j2', 'ok')], (id) => (id === 'j1' ? 'stale' : 'done'));
    const r = await new Runtime(store).register('ok', async () => 1).tick();
    expect(r).toEqual({ ran: 2, failed: 0, stale: 1 });
    expect(calls.map((c) => c.id)).toEqual(['j1', 'j2']);
  });
});
