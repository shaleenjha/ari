// Parity test for the Deno port in functions/ari-gmail-ingest (run: node native/supabase/tests/gmail_ingest_port.test.ts).
// Synthetic fixtures only (app2/jobs/src/gmail/sample-linkedin-emails.ts): Gmail JSON -> port gmailToRaw -> parser must equal parser(raw).
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const dir = mkdtempSync(join(tmpdir(), 'ariport-'));
writeFileSync(join(dir, 'parse.ts'), readFileSync(join(root, 'app2/jobs/src/gmail/parse.ts')));
writeFileSync(join(dir, 'fixtures.ts'), readFileSync(join(root, 'app2/jobs/src/gmail/sample-linkedin-emails.ts'), 'utf8').replace(/from '\.\/parse'/g, "from './parse.ts'"));
const port = await import(join(root, 'native/supabase/functions/ari-gmail-ingest/index.ts'));
const P = await import(join(dir, 'parse.ts'));
const F = await import(join(dir, 'fixtures.ts'));
const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function toGmail(e: any, attachment = false) {
  const headers = [{ name: 'From', value: e.from }, { name: 'Subject', value: e.subject }, { name: 'Date', value: e.date }];
  if (e.authResults) headers.push({ name: 'Authentication-Results', value: 'relay.example; dkim=fail' });  // Gmail's own (mx.google.com) must win
  if (e.authResults) headers.push({ name: 'Authentication-Results', value: e.authResults });
  const parts: any[] = [];
  if (e.text) parts.push({ mimeType: 'text/plain', body: { data: b64url(e.text) } });
  if (e.html) parts.push({ mimeType: 'text/html', body: { data: b64url(e.html) } });
  const alt = { mimeType: 'multipart/alternative', parts };
  return { id: e.id, internalDate: String(Date.parse(e.date) || 0), labelIds: ['INBOX'],
    payload: attachment ? { mimeType: 'multipart/mixed', headers, parts: [alt, { mimeType: 'text/plain', filename: 'x.txt', body: { attachmentId: 'A' } }] } : { ...alt, headers } };
}
let n = 0;
for (const [k, raw] of Object.entries(F) as [string, any][]) {
  if (!raw || typeof raw !== 'object' || !('subject' in raw)) continue;
  const viaPort = port.parseLinkedInEmail(port.gmailToRaw(toGmail(raw, n % 2 === 1)));
  const direct = P.parseLinkedInEmail(raw);
  assert.deepEqual(viaPort, direct, k);
  const row = port.toShadowRow(viaPort);
  if (row) assert.deepEqual(Object.keys(row).sort(), ['event_at', 'kind', 'msg_id', 'name', 'profile_url'], k + ' keys');
  if (row) assert.ok(!JSON.stringify(row).includes('happy to chat'), 'no snippet stored');
  n++;
}
assert.ok(n >= 6, 'fixtures exercised: ' + n);
assert.equal(port.safeEq('abc', 'abc'), true); assert.equal(port.safeEq('abc', 'abd'), false); assert.equal(port.safeEq('abc', 'abcd'), false);
assert.equal(port.safeEq(null, 'x'), false); assert.equal(port.safeEq('', ''), false);
const q0 = port.buildQuery(0, 1_000_000_000_000); assert.match(q0, /^from:linkedin\.com .* after:999827200$/);
assert.match(port.buildQuery(1_000_000_000_000, 0), /after:999996400$/);
assert.equal(port.b64urlDecode(b64url('héllo ✓')), 'héllo ✓');
console.log(`gmail ingest port: ${n} fixtures parity OK, shadow rows carry only 5 fields, safeEq + query OK`);
