// Synthetic Gmail API JSON built from the synthetic RawEmail fixtures (fake names, ids, companies), plus a fake Gmail API.
import type { RawEmail } from './parse';
import { HistoryExpiredError, type GmailApi, type GmailHistoryPage, type GmailMessage } from './fetch';
import * as F from './fixtures';

const b64url = (s: string): string => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RawEmail -> Gmail users.messages.get (format=full) JSON, multipart/alternative with optional attachment. */
export function toGmailJson(e: RawEmail, opts: { historyId?: string; internalDate?: number; attachment?: boolean; extraAuth?: string } = {}): GmailMessage {
  const headers = [{ name: 'From', value: e.from }, { name: 'Subject', value: e.subject }, { name: 'Date', value: e.date }];
  if (opts.extraAuth) headers.push({ name: 'Authentication-Results', value: opts.extraAuth });
  if (e.authResults) headers.push({ name: 'Authentication-Results', value: e.authResults });
  const parts = [] as NonNullable<GmailMessage['payload']>['parts'] & object;
  if (e.text) parts.push({ partId: '0', mimeType: 'text/plain', body: { size: e.text.length, data: b64url(e.text) } });
  if (e.html) parts.push({ partId: '1', mimeType: 'text/html', body: { size: e.html.length, data: b64url(e.html) } });
  const alt = { partId: '', mimeType: 'multipart/alternative', parts };
  const payload = opts.attachment
    ? { mimeType: 'multipart/mixed', headers, parts: [alt, { partId: '2', mimeType: 'text/plain', filename: 'notes.txt',
        body: { size: 20, attachmentId: 'ATT-1' } }] }
    : { ...alt, headers };
  return { id: e.id, threadId: `t-${e.id}`, historyId: opts.historyId ?? '100', internalDate: String(opts.internalDate ?? Date.parse('2026-10-20T00:00:00Z')),
    labelIds: ['INBOX', 'CATEGORY_UPDATES'], payload };
}

export const all: RawEmail[] = [F.acceptText, F.acceptHtml, F.replyMsg, F.replyNewFrom, F.spoofed, F.notLinkedIn, F.jobAlert];

/** Fake Gmail: a mailbox of messages added at increasing history ids; history older than `expiredBefore` returns 404. */
export class FakeGmail implements GmailApi {
  calls = { profile: 0, history: 0, list: 0, get: 0 };
  lastQuery = '';
  constructor(public added: Array<{ hid: number; msg: GmailMessage; labels?: string[] }>, public head = 0, public expiredBefore = 0, public pageSize = 2) {
    if (!head) this.head = Math.max(0, ...added.map((a) => a.hid));
  }
  async profile() { this.calls.profile++; return { historyId: String(this.head) }; }
  async historyList(start: string, token?: string): Promise<GmailHistoryPage> {
    this.calls.history++;
    if (Number(start) < this.expiredBefore) throw new HistoryExpiredError();
    const items = this.added.filter((a) => a.hid > Number(start)).sort((a, b) => a.hid - b.hid);
    const off = Number(token ?? 0); const page = items.slice(off, off + this.pageSize);
    return { history: page.map((a) => ({ id: String(a.hid), messagesAdded: [{ message: { id: a.msg.id, labelIds: a.labels ?? a.msg.labelIds } }] })),
      historyId: String(this.head), nextPageToken: off + this.pageSize < items.length ? String(off + this.pageSize) : undefined };
  }
  async messagesList(q: string, token?: string) {
    this.calls.list++; this.lastQuery = q;
    const items = this.added.filter((a) => /linkedin\.com/i.test(a.msg.payload?.headers?.find((h) => h.name === 'From')?.value ?? ''));
    const off = Number(token ?? 0); const page = items.slice(off, off + this.pageSize);
    return { messages: page.map((a) => ({ id: a.msg.id })), nextPageToken: off + this.pageSize < items.length ? String(off + this.pageSize) : undefined };
  }
  async getMessage(id: string) {
    this.calls.get++;
    const a = this.added.find((x) => x.msg.id === id);
    if (!a) throw new Error(`404 ${id}`);
    return a.msg;
  }
}
