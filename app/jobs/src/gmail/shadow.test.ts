import { describe, expect, it } from 'vitest';
import { compareShadow, promotionReady, renderShadowReport, shadowDiffHandler, type ShadowReport } from './shadow';
import type { IngestRow } from './handler';

const WS = 'ws-a';
const W = { from: '2026-10-19T18:30:00.000Z', to: '2026-10-20T18:30:00.000Z' };   // night of Oct 20, IST
const row = (id: string, kind: IngestRow['kind'], at: string, pid?: string, name = 'Synthetic Person'): IngestRow => ({
  workspaceId: WS, sourceMsgId: id, kind, receivedAt: at, matchedPersonId: pid, matchMethod: pid ? 'vanity' : 'none', mode: 'shadow',
  parsed: { sourceMsgId: id, kind, at, name } });

describe('compareShadow', () => {
  it('all agree: exact accept, day-granular accept, reply joined by gmail id', () => {
    const r = compareShadow(WS, '2026-10-20', W,
      [row('g1', 'accept', '2026-10-20T04:00:00.000Z', 'p1'), row('g2', 'accept', '2026-10-20T10:00:00.000Z', 'p2'), row('g3', 'reply', '2026-10-20T11:00:00.000Z', 'p3')],
      [{ personId: 'p1', acceptedAt: '2026-10-20T04:05:00.000Z' }, { personId: 'p2', acceptedAt: '2026-10-19T18:30:00.000Z', acceptedApprox: true }],
      [{ id: 'r1', personId: 'p3', gmailId: 'g3', receivedAt: '2026-10-20T11:00:00.000Z', matchedBy: 'name' }]);
    expect(r.agree).toBe(true);
    expect(r.counts).toMatchObject({ match: 3, time_mismatch: 0, unmatched: 0 });
  });
  it('flags missing, extra, time and person mismatches; one unmatched is tolerated, two are not', () => {
    const rows = [
      row('g1', 'accept', '2026-10-20T04:00:00.000Z', 'p1'),                 // worker 3 h off, exact -> time_mismatch
      row('g2', 'accept', '2026-10-20T05:00:00.000Z', 'p9'),                 // worker never saw it -> extra
      row('g3', 'reply', '2026-10-20T06:00:00.000Z', 'p3'),                  // worker gave it to p4 -> person_mismatch
      row('g4', 'reply', '2026-10-20T07:00:00.000Z'),                        // parser could not match -> unmatched
      row('g5', 'invite_sent', '2026-10-20T07:00:00.000Z'),                  // ignored by the comparison
      row('g6', 'accept', '2026-10-21T07:00:00.000Z', 'p8'),                 // outside the window
    ];
    const r = compareShadow(WS, '2026-10-20', W, rows,
      [{ personId: 'p1', acceptedAt: '2026-10-20T07:00:00.000Z' }, { personId: 'p5', acceptedAt: '2026-10-20T08:00:00.000Z' }],
      [{ id: 'r3', personId: 'p4', gmailId: 'g3', receivedAt: '2026-10-20T06:00:00.000Z' }, { id: 'r7', personId: 'p7', receivedAt: '2026-10-20T09:00:00.000Z' }]);
    expect(r.counts).toEqual({ match: 0, time_mismatch: 1, missing_in_parser: 2, extra_in_parser: 1, person_mismatch: 1, unmatched: 1 });
    expect(r.agree).toBe(false);
    expect(r.items[0]!.status).toBe('person_mismatch');
    expect(r.items.find((i) => i.status === 'time_mismatch')!.deltaMinutes).toBe(-180);
    const two = compareShadow(WS, '2026-10-20', W, [row('a', 'reply', '2026-10-20T07:00:00.000Z'), row('b', 'accept', '2026-10-20T07:00:00.000Z')], [], []);
    expect(two).toMatchObject({ agree: false, counts: { unmatched: 2 } });
  });
  it('day-granular worker accept on another IST day is a mismatch; reply joined by person + time when worker had no gmail id', () => {
    const r = compareShadow(WS, '2026-10-20', W, [row('g1', 'accept', '2026-10-20T17:00:00.000Z', 'p1'), row('g2', 'reply', '2026-10-20T08:00:00.000Z', 'p2')],
      [{ personId: 'p1', acceptedAt: '2026-10-21T00:00:00.000Z', acceptedApprox: true }],
      [{ id: 'r2', personId: 'p2', receivedAt: '2026-10-20T08:04:00.000Z' }]);
    expect(r.counts).toMatchObject({ time_mismatch: 1, match: 1 });
  });
  it('first accept email wins when LinkedIn sends two', () => {
    const r = compareShadow(WS, 'n', W, [row('g1', 'accept', '2026-10-20T09:00:00.000Z', 'p1'), row('g0', 'accept', '2026-10-20T04:00:00.000Z', 'p1')],
      [{ personId: 'p1', acceptedAt: '2026-10-20T04:01:00.000Z' }], []);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ status: 'match', sourceMsgId: 'g0' });
  });
  it('report renders without names, shape is stable', () => {
    const r = compareShadow(WS, '2026-10-20', W, [row('g4', 'reply', '2026-10-20T07:00:00.000Z', undefined, 'Name Should Not Print')], [], [],
      { generatedAt: '2026-10-21T00:00:00.000Z' });
    const md = renderShadowReport(r);
    expect(md).toContain('# Shadow diff 2026-10-20 (AGREE)');
    expect(md).toContain('| reply | unmatched |');
    expect(md).not.toContain('Name Should Not Print');
    expect(Object.keys(r).sort()).toEqual(['agree', 'counts', 'generatedAt', 'items', 'night', 'rules', 'schema', 'window', 'workspaceId']);
  });
});

describe('promotion + handler', () => {
  it('needs 3 consecutive agreeing nights with unmatched <= 1', () => {
    const n = (night: string, agree = true, unmatched = 0) => ({ night, agree, unmatched });
    expect(promotionReady([n('2026-10-18'), n('2026-10-19'), n('2026-10-20', true, 1)])).toBe(true);
    expect(promotionReady([n('2026-10-18'), n('2026-10-20')])).toBe(false);
    expect(promotionReady([n('2026-10-17'), n('2026-10-19'), n('2026-10-20')])).toBe(false);
    expect(promotionReady([n('2026-10-18'), n('2026-10-19', false), n('2026-10-20')])).toBe(false);
    expect(promotionReady([n('2026-10-18'), n('2026-10-19', true, 2), n('2026-10-20')])).toBe(false);
  });
  it('handler loads, compares and stores the report', async () => {
    const put: ShadowReport[] = [];
    const h = shadowDiffHandler({ rows: async () => [row('g1', 'accept', '2026-10-20T04:00:00.000Z', 'p1')],
      worker: async () => ({ people: [{ personId: 'p1', acceptedAt: '2026-10-20T04:00:00.000Z' }], replies: [] }), put: async (_w, _n, r) => { put.push(r); } });
    await expect(h({ workspaceId: WS, payload: {} })).rejects.toThrow('required');
    expect(await h({ workspaceId: WS, payload: { night: '2026-10-20', ...W } })).toMatchObject({ agree: true });
    expect(put[0]!.schema).toBe('ari.shadow-diff/v1');
  });
});
