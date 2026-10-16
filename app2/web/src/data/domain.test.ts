import { describe, expect, it } from 'vitest';
import { acceptToDm1Median, applyMark, canTransition, stageFromFacts, today15 } from './domain';
import { MockData } from './mock';
import type { Person } from './types';

const base: Person = { id: 'x', fullName: 'Test', stage: 'connect_queued' };

describe('domain', () => {
  it('stage follows the furthest fact', () => {
    expect(stageFromFacts({ ...base, connectSentAt: 'a', acceptedAt: 'b' })).toBe('accepted');
    expect(stageFromFacts({ ...base, dm1SentAt: 'a', repliedAt: 'b' })).toBe('replied');
  });
  it('first tap wins and schedules DM2 +4 days', () => {
    const a = applyMark(base, 'dm1_sent', '2026-10-20T04:30:00Z');
    const b = applyMark(a, 'dm1_sent', '2026-10-21T04:30:00Z');
    expect(b.dm1SentAt).toBe('2026-10-20T04:30:00Z');
    expect(b.dm2Due).toBe('2026-10-24');
    expect(b.stage).toBe('dm1_sent');
  });
  it("Today's 15 caps per account", () => {
    const ppl = Array.from({ length: 30 }, (_, i): Person => ({ ...base, id: `p${i}`, accountId: `a${i % 2}`, score: 100 - i }));
    const t = today15(ppl, 3, 15);
    expect(t).toHaveLength(6);
    expect(t.filter((p) => p.accountId === 'a0')).toHaveLength(3);
  });
  it('state machine matches the SQL', () => {
    expect(canTransition('done', 'in_progress')).toBe(false);
    expect(canTransition('done', 'todo')).toBe(true);
    expect(canTransition('proposed', 'todo')).toBe(true);
  });
  it('accept to DM1 median in hours', () => {
    expect(acceptToDm1Median([{ ...base, acceptedAt: '2026-10-20T00:00:00Z', dm1SentAt: '2026-10-20T02:00:00Z' },
      { ...base, acceptedAt: '2026-10-20T00:00:00Z', dm1SentAt: '2026-10-20T06:00:00Z' }])).toBe(4);
    expect(acceptToDm1Median([base])).toBeNull();
  });
});

describe('mock data layer', () => {
  it('optimistic concurrency + idempotent ops', async () => {
    const d = new MockData();
    const r1 = await d.transition('t-1', 'in_progress', 1, 'op1');
    expect(r1.ok).toBe(true);
    expect((await d.transition('t-1', 'done', 1, 'op2')).conflict).toBe(true);
    expect(await d.transition('t-1', 'in_progress', 1, 'op1')).toEqual(r1);
  });
  it("Today's 15 has 15 synthetic rows, max 3 per account", async () => {
    const t = await new MockData().today15();
    expect(t.length).toBeLessThanOrEqual(15);
    const c = new Map<string, number>();
    t.forEach((p) => c.set(p.accountId!, (c.get(p.accountId!) ?? 0) + 1));
    expect(Math.max(...c.values())).toBeLessThanOrEqual(3);
  });
});
