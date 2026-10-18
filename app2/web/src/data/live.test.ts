import { describe, expect, it } from 'vitest';
import { LiveData } from './live';
import { ReadOnlyError } from './rest';
import { dayIn, personStage, weekStart } from './liveRows';
import { resolveMode, liveEnv } from './mode';
import { LIVE_JWT_A, LIVE_NOW, LWS_A, LWS_B, LivePostgrest } from './fixtures/livePg';

const setup = (workspaceId?: string) => {
  const m = new LivePostgrest();
  const d = new LiveData(m.fetch, { url: 'https://example.invalid', apikey: 'pk', token: async () => LIVE_JWT_A, workspaceId, now: () => LIVE_NOW });
  return { m, d };
};

describe('LiveData over production-shaped rows (synthetic)', () => {
  it('finds its workspace through RLS, then filters every read by it', async () => {
    const { m, d } = setup();
    expect(await d.workspace()).toBe(LWS_A);
    await d.queue(); await d.replies(); await d.week(); await d.today15(); await d.hygiene();
    const scoped = m.requests.slice(1);
    expect(scoped.length).toBeGreaterThan(5);
    expect(scoped.every((r) => r.params.get('workspace_id') === `eq.${LWS_A}`)).toBe(true);
  });

  it('every request is a bounded GET, and nothing ever writes', async () => {
    const { m, d } = setup();
    await Promise.all([d.queue(), d.replies(), d.week(), d.today15(), d.accounts(), d.hygiene(), d.person('P001'),
      d.draft('P001', 'dm1'), d.draft('P005', 'reply'), d.account('a0000000-0000-4000-8000-000000000001')]);
    expect(m.requests.length).toBeGreaterThan(10);
    for (const r of m.requests) {
      expect(r.method).toBe('GET');
      expect(Number(r.params.get('limit'))).toBeGreaterThan(0);
      expect(Number(r.params.get('limit'))).toBeLessThanOrEqual(2000);
    }
    const before = m.requests.length;
    await expect(d.mark('P001', 'dm1_sent', 'op')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(d.transition('x', 'done', 0, 'op')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(d.resolveHygiene('f', 'dismiss', 'op')).rejects.toBeInstanceOf(ReadOnlyError);
    await expect(d.confirmWho('e', null, 'op')).rejects.toBeInstanceOf(ReadOnlyError);
    expect(m.requests.length).toBe(before);
  });

  it('Today: DM1 for accepts, DM2 when due, answers for open replies (no DM2 for someone who replied); never personal, deleted or workspace B', async () => {
    const { d } = setup();
    const q = await d.queue();
    expect(q.map((t) => [t.title, t.status])).toEqual([
      ['Send DM2 to Sam Roe', 'ready'],      // due Monday: the most overdue comes first
      ['Send DM1 to Alex Doe', 'ready'],
      ['Answer Casey Loe', 'ready'],
      ['Answer Jamie Poe', 'ready'],
    ]);
    expect(JSON.stringify(q)).not.toMatch(/CANARY|Riley|Gone/);
  });

  it('Replies: open only, leads only, newest first; a missing snippet gets a plain line; the answer draft is the pick', async () => {
    const { d } = setup();
    const r = await d.replies();
    expect(r.map((x) => x.id)).toEqual(['12', '11']);
    expect(r[0]!.snippet).toBe('Jamie Poe replied. The message is in your LinkedIn inbox.');
    expect(r.every((x) => x.status === 'open')).toBe(true);
    expect((await d.draft('P005', 'reply'))!.body).toBe('Short version: the sensitive fields move to a vault.');
    expect(await d.draft('P003', 'reply')).toBeNull();
  });

  it('Report: this week from the log (Monday in the workspace clock), accept to DM1 median from people', async () => {
    const { d } = setup();
    expect(await d.week()).toEqual({ meetingsAri: 0, meetingsGoal: 3, replies: 1, accepts: 2, connects: 1, acceptToDm1MedianHours: 6 });
  });

  it("Today's 15: queued leads with a profile link, at most 3 per account; account room maps stages and the brief", async () => {
    const { d } = setup();
    const t = await d.today15();
    expect(t.map((p) => p.id)).toEqual(['P10', 'P11', 'P12', 'P15', 'P16', 'P17']);
    const a = await d.account('a0000000-0000-4000-8000-000000000001');
    expect(a!.account).toMatchObject({ name: 'Ostrevanthe Co', stage: 'engaged' });
    expect(a!.brief!.whyNow.map((c) => c.label)).toEqual(['verified', 'inference']);
    expect(a!.people.map((p) => p.fullName)).not.toContain('Riley Coe');
    expect(await d.account('b0000000-0000-4000-8000-000000000001')).toBeNull();
    expect((await d.hygiene()).map((f) => f.detail)).toEqual(['No Link · company written as "Brennuvia Labs Inc"']);
  });

  it('a token for workspace A asking for workspace B sees nothing', async () => {
    const { d } = setup(LWS_B);
    expect(await d.replies()).toEqual([]);
    expect(await d.queue()).toEqual([]);
  });
});

describe('live helpers', () => {
  it('stages, days and the workspace week', () => {
    expect(personStage('DM1 sent')).toBe('dm1_sent');
    expect(personStage('Meeting')).toBe('meeting_set');
    expect(personStage('something new')).toBe('hold');
    expect(dayIn(new Date('2026-10-18T19:00:00Z'))).toBe('2026-10-19');
    expect(weekStart(LIVE_NOW)).toBe('2026-10-18T18:30:00.000Z');
    expect(weekStart(new Date('2026-10-18T18:29:00Z'))).toBe('2026-10-11T18:30:00.000Z');
  });
  it('mode: mock by default, live only when built for it; ?data=mock and ?ro=1 for UI tests', () => {
    expect(resolveMode({}, '')).toEqual({ data: 'mock', readOnly: false });
    expect(resolveMode({}, '?ro=1')).toEqual({ data: 'mock', readOnly: true });
    expect(resolveMode({ VITE_ARI_DATA: 'live' }, '')).toEqual({ data: 'live', readOnly: true });
    expect(resolveMode({ VITE_ARI_DATA: 'live' }, '?data=mock')).toEqual({ data: 'mock', readOnly: false });
    expect(resolveMode({}, '?data=legacy').data).toBe('legacy');
    expect(liveEnv({ VITE_ARI_SUPABASE_URL: 'https://x/' })).toEqual(['VITE_ARI_SUPABASE_KEY', 'VITE_ARI_GOOGLE_CLIENT_ID']);
    expect(liveEnv({ VITE_ARI_SUPABASE_URL: 'https://x/', VITE_ARI_SUPABASE_KEY: 'k', VITE_ARI_GOOGLE_CLIENT_ID: 'g' }))
      .toEqual({ url: 'https://x', apikey: 'k', googleClientId: 'g', workspaceId: undefined });
  });
});
