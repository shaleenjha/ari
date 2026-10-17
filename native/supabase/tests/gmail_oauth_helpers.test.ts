// run: node native/supabase/tests/gmail_oauth_helpers.test.ts
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const m = await import(join(dirname(fileURLToPath(import.meta.url)), '../functions/ari-gmail-oauth/index.ts'));
assert.ok(m.scopeOk('https://www.googleapis.com/auth/gmail.readonly'));
assert.ok(!m.scopeOk('https://www.googleapis.com/auth/gmail.readonly https://mail.google.com/'));
assert.ok(!m.scopeOk('https://www.googleapis.com/auth/gmail.modify'));
assert.ok(!m.scopeOk(''));
assert.equal(await m.challenge('dBjftJeZ4CVP-mJ92K1QqoAjhCfdhyWeAqH7MJ7vY3M'), 'GWh4P0ZbcKWy_Kjz36DPj4LtSdIyY0SkHhptkU-6zKA'); // S256 cross-checked with Python hashlib
assert.ok(m.safeEq(m.ALLOW, 'owner@example.com'));
assert.ok(!m.safeEq(m.ALLOW.slice(0, -1), m.ALLOW));
assert.ok(m.rand(48).length >= 64 && /^[A-Za-z0-9_-]+$/.test(m.rand(48)));
console.log('oauth helpers OK (PKCE S256, exact scope, allowlist, random)');
