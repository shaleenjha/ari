import { describe, expect, it } from 'vitest';
import { extractProfile, parseLinkedInEmail } from './parse';
import { matchPerson } from './match';
import { ingest, shadowDiff } from './handler';
import * as F from './fixtures';
import { Runtime, backoffSeconds, type Job, type JobStore } from '../runtime/worker';

describe('parse', () => {
  it('accept (text, comm link with tracking) -> vanity + headline + company + exact time', () => {
    const e = parseLinkedInEmail(F.acceptText);
    expect(e).toMatchObject({ kind: 'accept', name: 'Alex Doe', vanity: 'alex-doe-4b2a19', company: 'Ostrevanthe Co',
      profileUrl: 'https://www.linkedin.com/in/alex-doe-4b2a19', at: '2026-10-20T09:14:05.000Z' });
  });
  it('accept (html, "now connected", @ headline)', () => {
    expect(parseLinkedInEmail(F.acceptHtml)).toMatchObject({ kind: 'accept', name: 'Sam Roe', vanity: 'sam-roe', company: 'Brennuvia Labs' });
  });
  it('reply with snippet + thread + profile', () => {
    const e = parseLinkedInEmail(F.replyMsg);
    expect(e.kind).toBe('reply');
    expect(e.name).toBe('Jamie Poe');
    expect(e.snippet).toContain('happy to chat');
    expect(e.threadUrl).toMatch(/messaging\/thread\//);
    expect(e.vanity).toBe('jamie-poe-77');
    expect(e.at).toBe('2026-10-21T10:00:00.000Z');
  });
  it('reply without profile link still parses name + company', () => {
    expect(parseLinkedInEmail(F.replyNewFrom)).toMatchObject({ kind: 'reply', name: 'Taylor Moe', company: 'Nowhere Inc', snippet: 'Sounds interesting, send details.' });
  });
  it('rejects spoofed (dkim fail) and non-LinkedIn senders; ignores other LinkedIn mail', () => {
    expect(parseLinkedInEmail(F.spoofed)).toMatchObject({ kind: 'unknown', reason: 'auth_fail' });
    expect(parseLinkedInEmail(F.notLinkedIn)).toMatchObject({ kind: 'unknown', reason: 'not_from_linkedin' });
    expect(parseLinkedInEmail(F.jobAlert)).toMatchObject({ kind: 'unknown', reason: 'unrecognised_subject' });
  });
  it('profile URL forms', () => {
    expect(extractProfile('https://in.linkedin.com/in/Some-One/')?.vanity).toBe('some-one');
    expect(extractProfile('https%3A%2F%2Fwww.linkedin.com%2Fin%2Fx-y-1%3Ftrk')?.vanity).toBe('x-y-1');
    expect(extractProfile('no link here')).toBeUndefined();
  });
});

const people = [
  { id: 'p1', fullName: 'Alex Doe', company: 'Ostrevanthe Co', linkedinUrl: 'https://www.linkedin.com/in/alex-doe-4b2a19/' },
  { id: 'p2', fullName: 'Sam Roe', company: 'Brennuvia Labs Inc' },
  { id: 'p3', fullName: 'Taylor Moe', company: 'Nowhere' }, { id: 'p4', fullName: 'Taylor Moe', company: 'Elsewhere' },
  { id: 'p5', fullName: 'Alex Doe', company: 'Other Co' },
];
describe('match', () => {
  it('vanity first, even when the name is ambiguous', () => {
    expect(matchPerson(parseLinkedInEmail(F.acceptText), people)).toMatchObject({ personId: 'p1', method: 'vanity' });
  });
  it('name + company when no vanity hit (company suffixes normalised)', () => {
    expect(matchPerson({ ...parseLinkedInEmail(F.acceptHtml), vanity: undefined }, people)).toMatchObject({ personId: 'p2', method: 'name_company' });
    expect(matchPerson(parseLinkedInEmail(F.replyNewFrom), people)).toMatchObject({ personId: 'p3', method: 'name_company' });
  });
  it('never guesses: name only with two candidates -> none with candidates', () => {
    const r = matchPerson({ sourceMsgId: 'x', kind: 'accept', at: '', name: 'Taylor Moe' }, people);
    expect(r).toEqual({ method: 'none', candidates: ['p3', 'p4'] });
  });
});

describe('ingest handler (shadow first)', () => {
  const msgs = [F.acceptText, F.acceptHtml, F.replyMsg, F.replyNewFrom, F.spoofed, F.notLinkedIn, F.jobAlert, F.acceptText];
  it('shadow: rows only, no side effects, idempotent per message id', () => {
    const { rows, effects } = ingest('ws', msgs, people);
    expect(effects).toEqual([]);
    expect(rows.map((r) => r.sourceMsgId)).toEqual(['msg-accept-1', 'msg-accept-2', 'msg-reply-1', 'msg-reply-2', 'msg-spoof-1', 'msg-jobs-1']);
    expect(rows.every((r) => r.mode === 'shadow')).toBe(true);
    expect(rows.find((r) => r.sourceMsgId === 'msg-reply-1')!.matchMethod).toBe('none'); // Jamie Poe not in workspace
  });
  it('live: accept -> person_mark, unmatched reply -> who_is_this', () => {
    const { effects } = ingest('ws', [F.acceptText, F.replyMsg], people, 'live');
    expect(effects).toEqual([
      { type: 'person_mark', personId: 'p1', field: 'accepted', at: '2026-10-20T09:14:05.000Z' },
      { type: 'who_is_this', at: '2026-10-21T10:00:00.000Z', candidates: [] },
    ]);
  });
  it('shadow diff against what the current worker recorded', () => {
    const { rows } = ingest('ws', [F.acceptText, F.acceptHtml], people);
    expect(shadowDiff(rows, new Map([['p1', { accepted: 'x' }], ['p2', { accepted: 'y' }]])).agree).toBe(true);
    const d = shadowDiff(rows, new Map([['p1', { accepted: 'x' }], ['p9', { accepted: 'z' }]]));
    expect(d).toMatchObject({ agree: false, missing: ['accept:p9'], extra: ['accept:p2'] });
  });
});

describe('runtime', () => {
  it('backoff caps at 1 h', () => { expect([1, 2, 3, 20].map(backoffSeconds)).toEqual([30, 60, 120, 3600]); });
  it('runs handlers and records failures', async () => {
    const done: Array<[string, boolean]> = [];
    const jobs: Job[] = [{ id: 'j1', workspaceId: 'ws', kind: 'ok', payload: {}, attempts: 1, maxAttempts: 5 },
      { id: 'j2', workspaceId: 'ws', kind: 'boom', payload: {}, attempts: 1, maxAttempts: 5 }];
    const store: JobStore = { claim: async () => jobs, finish: async (id, ok) => { done.push([id, ok]); } };
    const r = await new Runtime(store).register('ok', async () => 1).register('boom', async () => { throw new Error('x'); }).tick();
    expect(r).toEqual({ ran: 2, failed: 1 });
    expect(done).toEqual([['j1', true], ['j2', false]]);
  });
});
