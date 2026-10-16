# Job system: design + skeleton (Phase 1)

Replaces the 10-minute polling LLM worker with a queue of typed jobs. Deterministic work runs as code; only judgment calls (research, briefs, drafts) go to an LLM, each as its own job with typed I/O and a cost record.

## Pieces
| Piece | Where | Status |
|---|---|---|
| Queue table `app.jobs` (workspace-scoped, idempotency key, attempts, backoff, dead letter) | `db/migrations/0001` + `0003` | built, SQL-tested |
| `app.job_enqueue / job_claim (FOR UPDATE SKIP LOCKED, 5-min lease) / job_finish / job_health` | `db/migrations/0003_jobs.sql` | built, SQL-tested (`db/tests/03_jobs.sql`) |
| Worker runtime (registry, tick, retry via `job_finish`) | `jobs/src/runtime/worker.ts` | skeleton + unit tests |
| `gmail-ingest` parser (LinkedIn accept / reply / invite-sent), profile-URL matching | `jobs/src/gmail/parse.ts`, `match.ts` | built, unit tests on synthetic emails |
| `gmail-ingest` handler with shadow / live modes + nightly shadow diff | `jobs/src/gmail/handler.ts` | built, unit tests |
| Gmail fetch (history.list poll every 2 min per user, later Pub/Sub watch) | — | design only (needs the user's Gmail connector in the app2 backend) |
| pgmq | — | optional later; the plain table + SKIP LOCKED covers one worker |

## gmail-ingest, deterministic, no LLM
1. **Fetch**: `users.history.list` since the stored `historyId`, query `from:linkedin.com`. One job per batch, idempotency key = `historyId`.
2. **Trust**: sender must be `@*.linkedin.com`; if `Authentication-Results` is present it must show `dkim=pass` for linkedin.com, else `unknown/auth_fail` (spoof guard).
3. **Classify by subject**: accept (`X accepted your invitation`, `You and X are now connected`), reply (`X sent you a new message`, `New message from X`, `X just messaged you`, `via LinkedIn` sender), invite-sent; anything else `unknown/unrecognised_subject` (job alerts, digests) and is ignored.
4. **Extract**: event time = the email's own Date header (exact, fixes the day-granular accept times); profile URL from any `/in/` or `/comm/in/` link (tracking params and url-encoding stripped) → vanity; headline line after the name → company (`at` / `@`); reply snippet and thread URL.
5. **Match**: vanity = `people.linkedin_vanity` (unique per workspace) → else exact normalised name + company → else **none**. Never guesses: two candidates = none, and the candidates go on a "Who is this?" card (one tap to confirm). This replaces today's silent skip of ambiguous names.
6. **Write**: one `app.ingest_events` row per message (unique on Gmail id, so replays are no-ops).

## Shadow mode, then live
- **Shadow** (default): rows written with `mode='shadow'`; nothing else changes. Nightly `shadowDiff` compares parser rows with what the current worker recorded (accepts, replies) and reports missing / extra / unmatched.
- **Promote** after 3 consecutive nights with `agree=true` and unmatched ≤ 1/day: flip the workspace setting to `live`. Live: accept/reply → `app.person_mark(..., 'accepted'|'replied', email time)` called as the workspace's **agent** member (the RPC only lets the agent record accepts and replies, never sends); unmatched → `app.task_create(kind='custom', title='Who is this?')`, which lands as `proposed`.
- Then step 0 (Gmail scan) is removed from the LLM worker prompt.

## Runtime rules
- Worker DB role `app_jobs` (no RLS bypass) can only call the job functions. Handlers that touch tenant data call command RPCs with a short-lived workspace-scoped agent JWT (platform ADR-009), so a bug cannot cross workspaces.
- Retries: 30 s × 2^(n−1), capped at 1 h; dead after `max_attempts` (5) → visible in `job_health()` and alerted.
- Every LLM job (later) records model, tokens, cost and a prompt hash on its job row; per-workspace monthly budget stops enqueueing at the cap.

## Next
1. Gmail fetch adapter + historyId store (needs the app2 backend; local tests use fixtures).
2. `follow-up-due` cron job that only enqueues (DM2 +4 d, DM3 +7 d, withdraw 14 d).
3. `fanout` / `deliver` for notifications (dedupe key, quiet hours in the recipient's zone).
4. Port `hygiene_scan` (prod 0029) to a workspace-scoped job.
