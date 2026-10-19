# Runbook: database changes (S1 R2, Oct 19 2026)

**Rule: every change to the prod or staging database goes through a migration file that writes its own
`supabase_migrations.schema_migrations` ledger row.** No hand-run SQL, no dashboard edits, no one-off cron or function
changes. If it is not in a migration file with a ledger row, the repo cannot say what is live, the restore runbook
cannot rebuild it, and the next audit has to guess.

## What counts as a DB change
Tables, columns, indexes, constraints, policies, grants, roles, functions and RPCs, triggers, views, pg_cron jobs,
vault secrets created by SQL, storage bucket policies. Data fixes too (backfills, deletes, repairs).

## How
1. Write `native/supabase/migrations/pending/NNNN_<name>.sql` plus `NNNN_<name>_rollback.sql`. Next free number: check
   both `migrations/` and `migrations/pending/`.
2. The file ends with its ledger row, in a transaction that first checks the change reached its end state:
   `insert into supabase_migrations.schema_migrations (version, name, statements) values ('NNNN', '<name>', array[...])
   on conflict (version) do nothing;`
3. Expand/contract, lock-safe (`set local lock_timeout = '5s'`, `statement_timeout`), re-runnable (if exists / if not exists).
4. CI: the `sql` and `sql-prod-shape` jobs run it against the prod schema shape, with its rollback. Red means it does not ship.
5. Staging first, then prod, in a maintenance session with a short-lived token from Owner. Afterwards confirm with a
   read-only query that the ledger row exists, then update `migrations/pending/README.md`.
6. Cron jobs are created with `cron.schedule('<name>', '<schedule>', $$...$$)` inside a migration, never in the dashboard.

## Live items with NO ledger row (backfill in a later DB release; do not apply anything now)
Found by the read-only checks of Oct 19 2026 (`plans/audit/data-side-live-checks-2026-10-19.txt`, `live-checks-2-2026-10-19.txt`).

| Item | What is live | Backfill |
|---|---|---|
| `0036` `ari_worker_log_repair` | Function `ari_worker_log_repair` exists in prod; ledger max is 0035, no 0036 row. File: `migrations/pending/0036_log_repair_rpc.sql` | Ledger-only migration: assert the function matches the file's definition, then insert the 0036 row. Do not re-create it |
| cron `ari-session-expiry` | Live pg_cron job, schedule `17 * * * *` | Migration that `cron.schedule`s it with the live command (idempotent), plus ledger row |
| cron `ari-weekly-digest` | Live pg_cron job, schedule `30 5 * * 6` | Same as above |

When the backfill release runs, read each live definition first (read-only) and copy it into the migration byte for
byte, so the ledger describes what is running rather than what we think is running.
