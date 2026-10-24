# Job system: design + skeleton (Phase 1)

Replaces the 10-minute polling LLM worker with a queue of typed jobs. Deterministic work runs as code; only judgment calls (research, briefs, drafts) go to an LLM, each as its own job with typed I/O and a cost record.

## Pieces
| Piece | Where | Status |
|---|---|---|
| Queue table `app.jobs` (workspace-scoped, idempotency key, attempts, backoff, dead letter) | `db/migrations/0001` + `0003` | built, SQL-tested |
| `app.job_enqueue / job_claim (FOR UPDATE SKIP LOCKED, 5-min lease) / job_finish / job_health` | `db/migrations/0003_jobs.sql` | built, SQL-tested (`db/tests/03_jobs.sql`) |
| Reliability: fenced finish, crash-loop cap, non-retryable, jitter, `agents_paused` kill switch | `db/migrations/0005_job_fencing.sql` (rollback `db/rollbacks/`) | built, SQL-tested (`db/tests/05_job_fencing.sql`) |
| Worker runtime (registry, tick, 240 s handler timeout with AbortSignal, fenced `job_finish`) | `jobs/src/runtime/worker.ts` | skeleton + unit tests (`worker.test.ts`) |
| `gmail-ingest` parser (LinkedIn accept / reply / invite-sent), profile-URL matching | `jobs/src/gmail/parse.ts`, `match.ts` | built, unit tests on synthetic emails |
| `gmail-ingest` handler with shadow / live modes + nightly shadow diff | `jobs/src/gmail/handler.ts` | built, unit tests |
| Gmail fetch (history.list poll every 2 min per user, later Pub/Sub watch) | `jobs/src/gmail/fetch.ts`, `db/migrations/0004` | built on synthetic Gmail JSON (cursor CAS, idempotent, 404 resync); auth designed, not connected: `docs/gmail-fetch.md` |
| Shadow comparison job `gmail-shadow-diff` (report `ari.shadow-diff/v1`) | `jobs/src/gmail/shadow.ts`, `app.shadow_report_put/shadow_promotion_ready` | built, unit + SQL tests |
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
- Retries: 30 s × 2^(n−1), capped at 1 h, then ±20% jitter (`job_finish`, mirrored by `backoffSeconds`); dead after `max_attempts` (5) → visible in `job_health()`.
- Timeout: every handler gets an `AbortSignal` and a hard 240 s limit (below the 5-min lease); pass the signal to provider calls. A timeout is a retryable failure.
- One claim per job: `tick()` claims one job (`p_n = 1`), runs it, finishes it, then claims the next, so every lease starts when its own run starts and the 240 s timeout keeps it inside the 5-min lease. (`LEASE_SECONDS` in `worker.ts` must equal the SQL interval.)
- Fencing: `job_claim` returns `attempts`; `job_finish(id, worker, attempt, ...)` applies only while that worker holds that attempt's lease (`status='running'`). Otherwise nothing changes and it returns `stale`, which the worker ignores. A NULL worker or attempt is always `stale`.
- Crash-loop cap: an expired lease already at `max_attempts` goes to dead (`lease expired at max attempts`) instead of running again.
- Non-retryable: a handler throws `NonRetryableError` → `p_retryable=false` → dead at once.
- Kill switch: `app_ops.settings.agents_paused` (set with `app.set_agents_paused(bool)`, worker role only) makes `job_claim` skip kinds `agent.%`. Global, not per workspace; jobs stay `ready` until unpaused.
  - Fails closed: the value must be a JSON boolean (CHECK), the setter rejects NULL, and a missing row reads as paused for `agent.%` kinds (other kinds keep running).
  - A pause stops new claims only. Handlers already running finish (or time out) normally, and the crash-loop cap still marks expired max-attempt `agent.%` jobs dead during a pause.
  - Deferred, to land with the first `agent.*` job: a separate ops role for unpausing (today the worker role can both pause and unpause) and an audit log of every change.

## Deploy and rollback of 0005
- Deploy order: **stop the worker, run migration 0005, start the new worker.** 0005 drops the old 4-arg `job_finish`, so an old worker fails every finish, and the new worker needs the 7-arg one.
- Rollback (`db/rollbacks/0005_job_fencing_down.sql`): stop the worker, run the rollback, start the old worker. The rollback drops `app_ops`, so the pause state is lost and agent jobs become claimable again. Check it first: `select value, updated_at from app_ops.settings where key = 'agents_paused';` and do not roll back while a pause is still needed.
- Not built yet: the per-workspace LLM budget and alerting on dead jobs (`dead_24h` is only a number in `job_health()`; nothing pages anyone).
- Every LLM job (later) records model, tokens, cost and a prompt hash on its job row; a per-workspace monthly budget will stop enqueueing at the cap (planned, not implemented).

## Next
1. Real `GmailApi` adapter + `gmail_connections` + token Edge Function (design in `gmail-fetch.md`; needs Owner's go-ahead on the OAuth client).
2. `follow-up-due` cron job that only enqueues (DM2 +4 d, DM3 +7 d, withdraw 14 d).
3. `fanout` / `deliver` for notifications (dedupe key, quiet hours in the recipient's zone).
4. Port `hygiene_scan` (prod 0029) to a workspace-scoped job.
