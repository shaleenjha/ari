# gmail-ingest fetch + shadow comparison (Phase 1, built on synthetic fixtures, NOT connected)

Written Oct 17 2026 (Forge, for Relay's capability). Nothing here reads a real mailbox; no Gmail client, token or OAuth app exists yet.

## 1. What is built
| Piece | Where | Tests |
|---|---|---|
| Gmail message JSON (`users.messages.get format=full`) → parser `RawEmail`: base64url text/html parts, multipart walk, attachments skipped, Gmail's own `Authentication-Results` (mx.google.com) preferred, `internalDate` fallback, 200 kB body cap | `jobs/src/gmail/fetch.ts` `gmailToRaw` | `fetch.test.ts` |
| Fetch pass: `history.list` from the stored `historyId`, SPAM/TRASH/DRAFT/SENT skipped, already-ingested ids skipped before `messages.get`, parser + matcher, idempotent write, compare-and-set cursor | `fetchAndIngest`, job kind `gmail-ingest` (`gmailIngestHandler`) | first run, incremental, replay, truncation, 404 resync, cursor race, API error |
| Storage: `app.ingest_cursors` (per workspace + mailbox), `app.ingest_cursor_get/advance` (CAS, forward-only unless resync), `app.ingest_record` (on conflict do nothing; foreign-workspace person ids dropped to null) | `db/migrations/0004_gmail_ingest.sql` | `db/tests/04_ingest.sql` |
| Nightly comparison vs the current worker, report `ari.shadow-diff/v1`, markdown render, promotion rule (TS + SQL mirror) | `jobs/src/gmail/shadow.ts`, `app.shadow_report_put`, `app.shadow_promotion_ready` | `shadow.test.ts`, `04_ingest.sql` |
| "Who is this?" confirm by a member (Ari cannot), op-id replay, conflict on second confirm, live mode then calls `person_mark` | `app.ingest_confirm_match` | `04_ingest.sql` |

### Fetch rules
- **First run** (no cursor) and **expired history** (Gmail 404 on `startHistoryId`): read `users.getProfile().historyId` first, then backfill with `messages.list q="from:linkedin.com newer_than:2d"` (first run) or `newer_than:7d` (resync). Taking the head first means mail arriving mid-pass is picked up next time, never lost.
- **Cursor** moves only when every listed message was handled. A truncated pass (`maxMessages`, default 200) leaves it; the next pass skips written ids. Concurrent workers: CAS loses cleanly (`conflict: true`), rows are still idempotent.
- `history.list` cannot filter by sender, so non-LinkedIn ids are fetched once and dropped (not stored). Later optimisation: `format=metadata` first, full body only for `@linkedin.com` senders.
- Errors other than 404 propagate; the job runtime retries (30 s × 2^(n−1), cap 1 h, dead after 5).

## 2. How it will authenticate (design only; do not connect)
- **Who grants:** each SDR connects their own Google account inside app2 (Supabase Auth with the Google provider, separate consent screen "Ari reads LinkedIn notification emails"). Scope **`https://www.googleapis.com/auth/gmail.readonly`** only, never send/modify. Restricted scope ⇒ Google OAuth verification + annual CASA security assessment before external users; until then the OAuth app stays in **Testing** with the SDR as a listed test user.
- **Storage:** the refresh token is stored encrypted in Supabase Vault (`vault.secrets`), referenced by `app.gmail_connections(workspace_id, user_id, mailbox_key, vault_secret_id, scopes, status, connected_at, revoked_at)` (to add in a later migration). `mailbox_key` = hash of the address, which is what `ingest_cursors.mailbox` stores; no address or token appears in jobs, logs or reports.
- **Use:** an Edge Function `gmail-token` (service role, not exposed to clients) exchanges the refresh token for a ~1 h access token per job run; the worker gets it in memory only and passes it to the real `GmailApi` adapter (`fetch` to `gmail.googleapis.com`). Access tokens are never persisted.
- **Revocation:** the user can disconnect in Settings → token revoked at Google (`oauth2.googleapis.com/revoke`), Vault secret deleted, status `revoked`, cursor kept for audit. `invalid_grant` from Google marks the connection `needs_reconnect` and shows a card; jobs for that mailbox stop enqueueing.
- **Workspace scoping:** handlers write tenant rows only through `app.ingest_record` (worker role, workspace id from the job) and, in live mode, `person_mark` under a short-lived workspace-scoped agent JWT (ADR-009). A job for workspace A cannot write B rows (tested: foreign person ids drop to null).
- **Later (push):** `users.watch` → Pub/Sub topic → push endpoint enqueues `gmail-ingest` with idempotency key = `historyId`; renew watch daily; the 2-minute poll stays as a fallback.
- **Not decided (needs Owner):** whether the Hark Google connector can be reused for app2 (it cannot today; app2 is its own OAuth client), and whether to start verification now.

## 3. Shadow diff report `ari.shadow-diff/v1`
```json
{ "schema": "ari.shadow-diff/v1", "workspaceId": "...", "night": "2026-10-20",
  "window": { "from": "2026-10-19T18:30:00.000Z", "to": "2026-10-20T18:30:00.000Z" }, "generatedAt": "...",
  "counts": { "match": 0, "time_mismatch": 0, "missing_in_parser": 0, "extra_in_parser": 0, "person_mismatch": 0, "unmatched": 0 },
  "agree": true,
  "items": [ { "kind": "accept|reply", "status": "...", "personId": "...", "parserPersonId": "...", "sourceMsgId": "...",
               "workerReplyId": "...", "parserAt": "...", "workerAt": "...", "deltaMinutes": 0, "note": "..." } ],
  "rules": { "exactToleranceMin": 10, "approxDayZone": "Asia/Kolkata", "maxUnmatched": 1 } }
```
- Worker side compared: `people.accepted_at` (+ `ts_approx` → day compare in IST) and `replies (gmail_id, person_id, received_at, matched_by)`.
- Replies join by Gmail id first, then same person within 10 min. First accept email per person wins (same as `person_mark`).
- `agree` = no missing / extra / person / time mismatches and unmatched ≤ 1. Stored with `app.shadow_report_put`; promotion = `app.shadow_promotion_ready` (3 consecutive nights, latest no older than yesterday).
- The markdown render prints ids only, never names or snippets, so reports can go in logs and CI artefacts.
