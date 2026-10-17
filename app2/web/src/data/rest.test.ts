import { describe, expect, it } from 'vitest';
import { RestData } from './rest';
import { JWT_A, MockPostgrest, WS_A, WS_B } from './pgmock';

const setup = () => { const m = new MockPostgrest(); return { m, d: new RestData(m.fetch, '', WS_A, JWT_A) }; };

describe('RestData over MockPostgrest (synthetic workspace)', () => {
  it('Today, Today\'s 15, Replies read through PostgREST with the app schema and never show workspace B', async () => {
    const { m, d } = setup();
    expect((await d.queue()).map((t) => t.id)).toEqual(['t-2', 't-1', 't-3']);
    const t15 = await d.today15();
    expect(t15).toHaveLength(9);
    expect(t15.some((p) => p.fullName.startsWith('CANARY'))).toBe(false);
    const r = await d.replies();
    expect(r.map((x) => x.snippet)).toEqual([expect.stringContaining('Thanks for reaching out')]);
    expect(m.requests.every((q) => q.includes(`workspace_id=eq.${WS_A}`) || q.startsWith('POST'))).toBe(true);
  });
  it('mark goes through the person_mark RPC with op-id replay', async () => {
    const { m, d } = setup();
    const [first] = await d.today15();
    expect(await d.mark(first!.id, 'connect_sent', 'op-1')).toEqual({ ok: true });
    expect(await d.mark(first!.id, 'connect_sent', 'op-1')).toEqual({ ok: true });
    expect(m.requests.filter((q) => q === 'POST /rest/v1/rpc/person_mark')).toHaveLength(2);
    expect((await d.today15()).some((p) => p.id === first!.id)).toBe(false);
  });
  it('a token for workspace A cannot call commands for workspace B', async () => {
    const { m } = setup();
    const evil = new RestData(m.fetch, '', WS_B, JWT_A);
    await expect(evil.mark('p-b', 'connect_sent', 'op-x')).rejects.toThrow('403');
    expect(await evil.hygiene()).toEqual([]);   // RLS: A's token sees no B rows even when asking for B
  });
  it('Tidy up: findings map to one-tap fixes; link, tick, merge(keep) and dismiss change the data', async () => {
    const { m, d } = setup();
    const f = await d.hygiene();
    expect(f.map((x) => [x.id, x.actions])).toEqual([['f-1', ['tick_connect', 'dismiss']], ['f-2', ['merge', 'dismiss']], ['f-3', ['link', 'dismiss']]]);
    await d.resolveHygiene('f-3', 'link', 'op-l');
    expect(m.db.people.find((p) => p.id === 'p-5')!.account_id).toBe('acc-2');
    await d.resolveHygiene('f-1', 'tick_connect', 'op-t');
    expect(m.db.people.find((p) => p.id === 'p-4')!.connect_sent_at).toBeTruthy();
    await expect(d.resolveHygiene('f-2', 'merge', 'op-m0')).rejects.toThrow('400');   // merge without a keep choice is refused
    await d.resolveHygiene('f-2', 'merge', 'op-m', 'acc-1');
    expect(m.db.people.find((p) => p.id === 'p-8')!.account_id).toBe('acc-1');
    expect(m.db.accounts.some((a) => a.id === 'acc-4')).toBe(false);
    expect(await d.hygiene()).toEqual([]);
    expect(await d.resolveHygiene('f-2', 'dismiss', 'op-z')).toMatchObject({ conflict: true });
  });
  it('Who is this?: candidates resolve to names + accounts; confirm once, second answer conflicts; agent cannot confirm', async () => {
    const { m, d } = setup();
    const [w] = await d.whoIsThis();
    expect(w).toMatchObject({ eventId: 'ev-1', kind: 'accept', name: 'Jordan Leesynth' });
    expect(w!.candidates.map((c) => c.accountName)).toEqual(['Ostrevanthe Co', 'Dravequin Systems']);
    const agent = new RestData(m.fetch, '', WS_A, `synthetic:${WS_A}:agent`);
    await expect(agent.confirmWho('ev-1', 'p-6', 'op-a')).rejects.toThrow('403');
    expect(await d.confirmWho('ev-1', 'p-6', 'op-c')).toEqual({ ok: true });
    expect(await d.confirmWho('ev-1', null, 'op-c2')).toMatchObject({ ok: false, conflict: true });
    expect(await d.whoIsThis()).toEqual([]);
  });
  it('account room and report still work over REST', async () => {
    const { d } = setup();
    const a = await d.account('acc-1');
    expect(a!.brief!.whyNow[0]!.label).toBe('verified');
    expect(a!.tasks.some((t) => t.assigneeRole === 'ae')).toBe(true);
    expect((await d.week()).replies).toBe(1);
    expect(await d.account('acc-b')).toBeNull();
  });
});
