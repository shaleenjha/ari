import { describe, expect, it } from 'vitest';
import { fetchAndIngest, gmailIngestHandler, gmailToRaw, MemoryCursor, MemorySink, toRecordJson, type GmailApi } from './fetch';
import { parseLinkedInEmail } from './parse';
import { FakeGmail, all, toGmailJson } from './gmail-fixtures';
import * as F from './fixtures';
import type { Candidate } from './match';

const WS = 'ws-a';
const people: Candidate[] = [
  { id: 'p-alex', fullName: 'Alex Doe', company: 'Ostrevanthe Co', linkedinUrl: 'https://www.linkedin.com/in/alex-doe-4b2a19' },
  { id: 'p-sam', fullName: 'Sam Roe', company: 'Brennuvia Labs', linkedinUrl: 'https://www.linkedin.com/in/sam-roe/' },
  { id: 'p-jamie', fullName: 'Jamie Poe', company: 'Dravequin Systems', linkedinUrl: 'https://www.linkedin.com/in/jamie-poe-77' },
];
const mailbox = (expiredBefore = 0) => new FakeGmail(all.map((e, i) => ({ hid: 100 + i * 10, msg: toGmailJson(e, { historyId: String(100 + i * 10) }) })), 0, expiredBefore);

describe('gmailToRaw', () => {
  it('decodes base64url text + html parts and parses the same as the raw fixture', () => {
    for (const e of [F.acceptText, F.acceptHtml, F.replyMsg]) {
      const raw = gmailToRaw(toGmailJson(e));
      expect(raw).toMatchObject({ id: e.id, from: e.from, subject: e.subject });
      expect(parseLinkedInEmail(raw)).toEqual(parseLinkedInEmail(e));
    }
  });
  it('skips attachments, prefers mx.google.com auth results, falls back to internalDate', () => {
    const m = toGmailJson({ ...F.acceptText, date: 'not a date' }, { attachment: true, internalDate: Date.parse('2026-10-20T09:14:05Z'),
      extraAuth: 'relay.example.com; dkim=fail' });
    const raw = gmailToRaw(m);
    expect(raw.text).toContain('Alex Doe');
    expect(raw.text).not.toContain('notes.txt');
    expect(raw.authResults).toMatch(/^mx\.google\.com/);
    expect(raw.date).toBe(new Date(Date.parse('2026-10-20T09:14:05Z')).toISOString());
  });
  it('a message with no body still yields a RawEmail (subject-only classification)', () => {
    const raw = gmailToRaw({ id: 'x1', payload: { mimeType: 'text/plain', headers: [{ name: 'From', value: 'LinkedIn <a@linkedin.com>' }, { name: 'Subject', value: 'Hi' }] } });
    expect(raw).toMatchObject({ id: 'x1', subject: 'Hi', text: undefined, html: undefined });
  });
});

describe('fetchAndIngest', () => {
  it('first run: profile historyId taken before backfill search, rows written, cursor set', async () => {
    const api = mailbox(); const cursor = new MemoryCursor(); const sink = new MemorySink();
    const r = await fetchAndIngest({ workspaceId: WS, mailbox: 'mb1', api, cursor, sink, people });
    expect(r).toMatchObject({ bootstrap: true, advanced: true, cursorTo: '160', truncated: false });
    expect(api.lastQuery).toBe('from:linkedin.com newer_than:2d');
    // 6 LinkedIn-sender messages listed (the example.com one is filtered by the query); all 6 classified, unknowns kept as rows
    expect(r.listed).toBe(6);
    expect(r.written).toBe(6);
    const byId = (id: string) => sink.rows.get(`${WS}|${id}`);
    expect(byId('msg-accept-1')).toMatchObject({ kind: 'accept', matchedPersonId: 'p-alex', matchMethod: 'vanity', mode: 'shadow' });
    expect(byId('msg-reply-1')).toMatchObject({ kind: 'reply', matchedPersonId: 'p-jamie' });
    expect(byId('msg-spoof-1')).toMatchObject({ kind: 'unknown' });
    expect(byId('msg-reply-2')).toMatchObject({ kind: 'reply', matchMethod: 'none' });
  });

  it('incremental: only new history, idempotent replay, cursor never moves back', async () => {
    const api = mailbox(); const cursor = new MemoryCursor(); const sink = new MemorySink();
    await cursor.advance(WS, 'mb1', null, '115');
    const r1 = await fetchAndIngest({ workspaceId: WS, mailbox: 'mb1', api, cursor, sink, people });
    // history.list cannot filter by sender: 5 new ids, the non-LinkedIn one is fetched but never written
    expect(r1).toMatchObject({ bootstrap: false, resync: false, listed: 5, fetched: 5, written: 4, ignored: 1, cursorTo: '160' });
    const gets = api.calls.get;
    const r2 = await fetchAndIngest({ workspaceId: WS, mailbox: 'mb1', api, cursor, sink, people });
    expect(r2).toMatchObject({ listed: 0, written: 0, advanced: true, cursorTo: '160' });
    expect(api.calls.get).toBe(gets);
    // replay from an older cursor: messages already written are skipped without a messages.get call
    await cursor.advance(WS, 'mb1', '160', '115', true);
    const r3 = await fetchAndIngest({ workspaceId: WS, mailbox: 'mb1', api, cursor, sink, people });
    expect(r3).toMatchObject({ listed: 5, skippedSeen: 4, fetched: 1, written: 0, cursorTo: '160' });
    expect(api.calls.get).toBe(gets + 1);
  });

  it('spam / trash / sent history entries are not fetched', async () => {
    const api = new FakeGmail([{ hid: 10, msg: toGmailJson(F.acceptText), labels: ['SPAM'] }, { hid: 11, msg: toGmailJson(F.replyMsg) }]);
    const cursor = new MemoryCursor(); await cursor.advance(WS, 'mb', null, '5');
    const r = await fetchAndIngest({ workspaceId: WS, mailbox: 'mb', api, cursor, sink: new MemorySink(), people });
    expect(r.listed).toBe(1);
  });

  it('expired history (404) -> resync by search over 7 days, cursor reset to the profile head', async () => {
    const api = mailbox(150); const cursor = new MemoryCursor(); const sink = new MemorySink();
    await cursor.advance(WS, 'mb1', null, '120');
    const r = await fetchAndIngest({ workspaceId: WS, mailbox: 'mb1', api, cursor, sink, people });
    expect(r).toMatchObject({ resync: true, advanced: true, cursorTo: '160', written: 6 });
    expect(api.lastQuery).toBe('from:linkedin.com newer_than:7d');
  });

  it('truncated pass leaves the cursor; the next pass finishes and advances', async () => {
    const api = mailbox(); const cursor = new MemoryCursor(); const sink = new MemorySink();
    await cursor.advance(WS, 'mb1', null, '90');
    const r1 = await fetchAndIngest({ workspaceId: WS, mailbox: 'mb1', api, cursor, sink, people, maxMessages: 4 });
    expect(r1).toMatchObject({ truncated: true, advanced: false, cursorTo: '90', fetched: 4 });
    const r2 = await fetchAndIngest({ workspaceId: WS, mailbox: 'mb1', api, cursor, sink, people, maxMessages: 4 });
    expect(r2).toMatchObject({ truncated: false, advanced: true, cursorTo: '160', skippedSeen: 4 });
    expect(sink.rows.size).toBe(6);
  });

  it('a concurrent worker moving the cursor is reported as a conflict, rows stay idempotent', async () => {
    const api = mailbox(); const sink = new MemorySink();
    const cursor = new MemoryCursor(); await cursor.advance(WS, 'mb1', null, '90');
    const racing = { get: (w: string, m: string) => cursor.get(w, m), advance: async (w: string, m: string, f: string | null, t: string) => {
      await cursor.advance(w, m, f, '170'); return cursor.advance(w, m, f, t); } };
    const r = await fetchAndIngest({ workspaceId: WS, mailbox: 'mb1', api, cursor: racing, sink, people });
    expect(r).toMatchObject({ advanced: false, conflict: true });
    expect(await cursor.get(WS, 'mb1')).toBe('170');
  });

  it('other API errors propagate (the job runtime retries with backoff)', async () => {
    const api: GmailApi = { ...mailbox(), historyList: async () => { throw new Error('503'); } } as unknown as GmailApi;
    const cursor = new MemoryCursor(); await cursor.advance(WS, 'mb', null, '1');
    await expect(fetchAndIngest({ workspaceId: WS, mailbox: 'mb', api, cursor, sink: new MemorySink(), people })).rejects.toThrow('503');
  });

  it('job handler wires deps and requires a mailbox; record json matches app.ingest_record', async () => {
    const sink = new MemorySink();
    const h = gmailIngestHandler({ api: async () => mailbox(), cursor: new MemoryCursor(), sink, people: async () => people, mode: async () => 'shadow' });
    await expect(h({ workspaceId: WS, payload: {} })).rejects.toThrow('mailbox');
    const r = await h({ workspaceId: WS, payload: { mailbox: 'mb9' } });
    expect(r.written).toBe(6);
    const j = toRecordJson([...sink.rows.values()][0]!);
    expect(Object.keys(j).sort()).toEqual(['kind', 'match_method', 'matched_person_id', 'mode', 'parsed', 'received_at', 'source', 'source_msg_id']);
  });
});
