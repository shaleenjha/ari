# app2 E1 to E3 (tenancy, backfill, dual RLS) and 0036 log repair: LIVE in prod. 0037 and 0038 (S1 R5, R6): LIVE in prod since Oct 20 2026 10:25 IST

## Status (checked Oct 19 2026, read-only, counts only; plans/audit data-side live checks)
| Migration | Prod | Ledger row (`supabase_migrations.schema_migrations`) |
|---|---|---|
| `../0032_accept_ingest.sql` | LIVE | yes |
| `0033_app2_e1_tenancy.sql` | LIVE (schema `app` with `workspaces` + `memberships` exists) | yes |
| `0034_app2_e2_backfill.sql` | LIVE | yes |
| `0035_app2_e3_dual_rls.sql` | LIVE | yes (ledger max is 0035) |
| `0036_log_repair_rpc.sql` | LIVE (`ari_worker_log_repair` and `ari_worker_log_unappend` exist in prod; the spec-05 Log repair it served finished Oct 18 2026, 395 rows) | **no** at the Oct 19 check. 0038 part 7 writes the row |
| `0037_members_aal2.sql` (+ rollback) | LIVE Oct 20 2026 (checks_after_0037 PASSED on prod). S1 R5: members need the two-step code too | yes |
| `0038_s1_release6.sql` (+ rollback) | LIVE Oct 20 2026 (checks_after_0038 PASSED on prod; both repair functions gone). S1 R6: seven parts, incl. dropping `ari_worker_log_repair` and `ari_worker_log_unappend` (accept_ingest repair-log retired in v18.17.7) | yes (ledger 0034 to 0038) |

- `0036_log_repair_rpc.sql` was never applied as a whole file. Per function:
  - `ari_worker_log_repair`: applied by hand, repair only (the Oct 18 Log repair); no ledger row; ledger row via 0038 part 7; dropped by 0038.
  - `ari_worker_log_unappend`: WAS applied by hand to prod with 0036 (Oct 18 2026; confirmed read-only Oct 19: SECURITY DEFINER,
    EXECUTE to ari_worker, postgres, service_role). 0038's drop removes it (not a no-op), and the 0038 rollback does not
    recreate it (repair-only delete helper, not needed after the Oct 18 repair).
- 0037 and 0038 came from the outside auditor's R5/R6 package (Oct 19 2026). Tests, apply order and the prod checks to run first
  (apply_op md5, save the live `ari_worker_log_repair` definition, worker reads `queue.target`) are in `README-R5-R6.md`. CI runs
  them on the throwaway database through `test/run_local.sh`. `test/fixtures_before_0038.sql` is for that throwaway database only:
  never run it on staging or prod. Diamond (`docs/specs/06`) is now migration 0039.
- These files stay in `pending/` until a DB release moves them, so paths cited elsewhere keep working. Do not re-apply them:
  they are live. The header of `../0032_accept_ingest.sql` still says "NOT applied"; that line is stale.
- Everything below this section is the original Oct 17 write-up (how the files were built and rehearsed). Where it says
  "not applied" or "staging first", read it as history.

## Original write-up (Oct 17 2026)

Written Oct 17 2026 from `app2/docs/migration-map.md` section 2, steps 1 to 3. Renumbered and rewritten lock-safe Oct 17 2026
(spec `docs/specs/03_app2_database_migration.md`, Owner's decisions 23:21 IST): Otto's `0032_accept_ingest.sql` lands first, so the
app2 set is now 0033 to 0035. Expand only: nothing is dropped or renamed, and the live app (owner over PostgREST as `authenticated`,
the worker as `ari_worker`) keeps working unchanged. Rehearsed only in a throwaway local Postgres 17 (see "Local rehearsal").
Staging first, then prod, never the other way.

| File | What | Rollback (same folder) |
|---|---|---|
| `0033_app2_e1_tenancy.sql` | schema `app`; `app.workspaces` + `app.memberships` (app2 shape); workspace "Owner" (`f5a1e000-0000-4000-8000-000000000001`) + owner membership (uid `is_owner()` is pinned to, role sdr); nullable `workspace_id uuid default <Owner>` on the 42 tenant tables (`backup_runs` stays platform-side) | `0033_app2_e1_tenancy_rollback.sql` |
| `0034_app2_e2_backfill.sql` | trigger `ws_guard`, batched backfill of nulls (expected 0), `workspace_id` NOT NULL via a validated CHECK, FK to `app.workspaces` (NOT VALID, then VALIDATE), unique `(workspace_id, <pk>)` per table (`<table>_ws_pk_uidx`) | `0034_app2_e2_backfill_rollback.sql` |
| `0035_app2_e3_dual_rls.sql` | `app.is_member` / `app.has_role` (authenticated only); member read policies on `app.*`; the 37 owner policies on the 42 tenant tables become `<old> OR (select app.is_member(workspace_id))`; the 11 `ari_worker` policies and the 2 owner policies 0032 adds (`gmail_events`, `scan_runs`, no `workspace_id`) untouched | `0035_app2_e3_dual_rls_rollback.sql` (each policy verbatim, generated) |

All six files are GENERATED: `test/gen_e12.py` writes 0033 + 0034 and their rollbacks; `test/gen_e3.py <db>` writes 0035 and its
rollback from a post-0032 prod-shape database. Edit the generators, not the files.

## How the files are built (lock-safe)
- **Many short transactions, not one big one.** Each file is a precheck transaction, then one `begin ... commit` per table per
  phase, then the ledger row. Every transaction starts with `set local lock_timeout = '5s'` and `set local statement_timeout = '60s'`,
  so a lock is held for one table only, for milliseconds, and a busy table makes the request stop cleanly instead of queueing the app.
- **Re-runnable, resumes.** Every step is "if not exists / if exists"; a stopped request leaves the earlier tables done and a re-run
  finishes the rest. The ledger row (`supabase_migrations.schema_migrations`) is written last, in a transaction that first checks
  all 42 tables (or 37 policies) reached the end state, so the ledger never claims a half-applied file.
- **0034 phases (phase-major: every table finishes a phase before the next starts).**
  A `ws_guard` trigger, created only if missing; B backfill, at most 1,000 rows per transaction, 2 transactions per table per run,
  `session_replication_role = replica` set only when nulls exist, explicit ROW EXCLUSIVE lock first (no count-then-ALTER lock upgrade),
  then one read-only check that stops the request if nulls remain (batches stay committed; re-run continues);
  C `CHECK (workspace_id is not null) NOT VALID` + FK `NOT VALID` (catalog only); D `VALIDATE` both (SHARE UPDATE EXCLUSIVE: reads and
  writes keep flowing); E `SET NOT NULL` (PG 12+ uses the validated check, no scan; proven locally by the DEBUG line) and drop the helper
  check; F plain `CREATE UNIQUE INDEX IF NOT EXISTS` per table (Owner: no CONCURRENTLY; tables are about 1,100 rows max, well under 5s).
- **0035** swaps each table's policies in ONE transaction per table (drop + create together), so no table is ever without its policy.

### Lock profile after the rewrite (measured with `pg_locks` on a local table, `test/lock_local.sh` section 1)
| Statement class | Lock on that public table | Blocks the app? |
|---|---|---|
| 0033 add column `workspace_id` with constant default (metadata only) | ACCESS EXCLUSIVE, ms, one table per transaction | yes, for ms; 5s cap |
| 0034-A create trigger `ws_guard` (only if missing) | SHARE ROW EXCLUSIVE | writes, ms |
| 0034-B lock + batched backfill update | ROW EXCLUSIVE (+ ACCESS SHARE from its subselect, after) | no |
| 0034-C add CHECK not valid | ACCESS EXCLUSIVE, catalog only | yes, ms |
| 0034-C add FK not valid | SHARE ROW EXCLUSIVE (also on `app.workspaces`) | writes, ms |
| 0034-D validate CHECK / FK | SHARE UPDATE EXCLUSIVE (+ ACCESS SHARE for the scan; the FK check also reads `app.workspaces`) | no |
| 0034-E set not null (validated check present) / drop helper check | ACCESS EXCLUSIVE, no scan | yes, ms |
| 0034-F create unique index (non-concurrent) | SHARE for the build (about 1,100 rows max) | writes, ms |
| 0035 drop policy + create policy, same transaction | ACCESS EXCLUSIVE | yes, ms |
| rollbacks: drop column / drop trigger, constraint, index / drop not null / policy swap | ACCESS EXCLUSIVE, catalog only | yes, ms |

## ws_guard behaviour change (read this)
`ws_guard` (BEFORE INSERT OR UPDATE OF workspace_id; a NULL on insert becomes Owner, a changed `workspace_id` on update is refused
with 42501) behaves differently from the earlier draft in three ways:
1. **It is created only if missing; a re-run no longer drops and re-creates it.** A re-run cannot change the trigger's definition
   (its timing, events or columns). The function body is still `create or replace`, so logic changes in `app.ws_guard()` do apply.
   To change the trigger itself, drop it in a later migration.
2. **It goes live first, table by table, before the backfill and NOT NULL** (it used to be the last step inside one transaction).
   From phase A on, an insert with an explicit NULL `workspace_id` (for example through `jsonb_populate_record` in `apply_op`) gets
   Owner, and `apply_op` patching `workspace_id` is refused (42501) on that table, even while later tables are still in phase A.
3. **The backfill skips it** (and `touch_row`) via `session_replication_role = replica`, set inside the backfill transaction only when
   that table has nulls (expected none). On Supabase this runs as `postgres`, as RESTORE.md step 3 does; if the target refuses it
   (permission denied), the request stops at that table with nothing else affected: tell Kavi, do not grant anything.

## Running through the Management API (one file = one request)
`POST /v1/projects/<ref>/database/query`, body `{"query": "<whole file>"}`, as `postgres`. The endpoint goes through pg-meta, which
sends the body as one simple-protocol query. Postgres runs such a string with each explicit `begin ... commit` as its own transaction;
the first error stops the rest of the string and earlier commits stay. That is exactly what the local rehearsal does
(`test/api_exec.py`, libpq `PQexec`), so **no part files are needed**: each migration is one request. Sizes: 0033 21 KB, 0034 about
200 KB, 0035 20 KB (Studio's editor limit is about 1 MB).
- Not yet verified on the hosted endpoint. First request of the staging session, harmless probe (expect `2`):
  `begin; create temp table if not exists _p (x xid8); insert into _p values (pg_current_xact_id()); commit; begin; insert into _p values (pg_current_xact_id()); commit; select count(distinct x) from _p;`
  If it returns `1`, or errors on the second `begin`, the endpoint wraps requests in one transaction: stop and use `psql` instead.
- After a request that errors inside a transaction, that session is left in a failed transaction block. pg-meta is believed to open and
  close a connection per request (unverified); to be safe, send `rollback;` as its own request before re-running.
- Alternative: `psql -v ON_ERROR_STOP=1 -f <file>` with the staging connection string. `ON_ERROR_STOP` is required: without it psql
  carries on after an error.
- A stopped request is normal (lock timeout, backfill batches left): read the error, re-run the same file. Each file's prechecks
  refuse to run out of order.

## Staging apply order (one maintenance session)
0. **Before**
   - `select max(version) from supabase_migrations.schema_migrations;` must be `0032` (0026 and Otto's 0032_accept_ingest applied;
     0033's precheck enforces both).
   - Fresh backup: `select public.ari_backup_kick();` and wait for the `backup_runs` row with `verified = true`.
   - Note the baseline: `select count(*) from public.people;` (and accounts, queue, replies) as postgres, plus one owner session in the app showing Today.
   - Run the transaction probe above.
1. **0033** apply. Check:
   - `select count(*) from information_schema.columns where table_schema='public' and column_name='workspace_id';` = 42
   - `select count(*) from app.workspaces;` = 1, `select role from app.memberships;` = sdr
   - `select version from supabase_migrations.schema_migrations where version = '0033';` returns a row
   - worker: next sync run prints its usual line (it reads `ari_worker_columns()`, which now lists `workspace_id`)
2. **0034** apply (re-run it if it stops asking to continue the backfill or on a lock timeout). Check:
   - `select count(*) from public.<t> where workspace_id is null` is 0 (the file already refuses to finish otherwise)
   - `select count(*) from pg_indexes where indexname like '%\_ws\_pk\_uidx';` = 42; `select count(*) from pg_trigger where tgname='ws_guard';` = 42
   - `select count(*) from pg_constraint where conname like '%\_workspace\_fk' and convalidated;` = 42; `... where conname like '%\_ws\_nn'` = 0
3. **0035** apply (the precheck raises if the owner policy shape differs: 39 owner policies, 37 of them on the 42 tenant tables;
   then stop and regenerate with `test/gen_e3.py` against a staging schema dump). Check:
   - run `test/checks_after_e3.sql` as postgres (psql prints `ALL E1-E3 CHECKS PASSED`; through the Management API success is simply no error, since every failed check raises). It rolls itself back.
     Unverified on Supabase: its ari_worker block uses `set local role ari_worker`, which needs `postgres` to have SET on that role (PG 17 does not give it to the role's creator by default). If that block fails with "permission denied to set role", rely on the real worker run below instead of granting anything.
   - app as owner on a phone: Today, Today's 15, Replies, an Account room, Report load; mark one synthetic item and undo it
   - worker: one sync + `python3 scripts/hygiene_scan.py` + `scripts/health_check.py` run clean as `ari_worker`
   - Supabase advisors (Database > Advisors): no new "RLS disabled" or "function search_path mutable" findings for `app.*`
4. **Rollback rehearsal on staging**: apply `0035_..._rollback`, `0034_..._rollback`, `0033_..._rollback` in that order (each has a
   precheck that refuses to run before the later one is rolled back; each is re-runnable), rerun the step 3 app and worker checks,
   confirm `max(version)` is `0032` and `select count(*) from pg_namespace where nspname='app'` = 0. Then re-apply 0033, 0034, 0035 and rerun the checks.
5. Only after staging is green and has run a day of normal syncs: the same steps on prod, in a maintenance window.

## What the session needs from Owner
- **One short-lived Supabase personal access token** (Account > Access Tokens, expiry set to the session, e.g. 1 day), handed over through Hark Secured Login at the start and revoked by Owner at the end, as in the Oct 17 session. It is used only for `POST /v1/projects/{ref}/database/query`, which runs SQL as `postgres`.
- Supabase PATs are account-wide (not limited to one project or to database endpoints), which is why it must be short-lived and revoked. If a scoped token is available instead (OAuth app or fine-grained token), the minimum is **database write on the staging project** (`database:write`, plus `database:read` for the checks); not verified that such a scope exists on Owner's plan.
- No service-role key, no anon key change, no edge-function deploy, no auth settings change.

## Things to know
- Visible change for clients: `select=*` responses carry one more key, `workspace_id`. `apply_op` keeps working; patching `workspace_id` through it is refused by `ws_guard` (42501).
- **0032's new tables are not tenant-scoped.** `gmail_events` and `scan_runs` (from `0032_accept_ingest.sql`) are not in the approved
  42, get no `workspace_id`, and keep their owner-only `owner_read` policy (no member path). Adding them is a decision for Owner: it would
  mean 44 tables in 0033/0034 and 39 dual policies in 0035 (add them to `TABLES` in `test/gen_e12.py`, regenerate all six files, rerun the rehearsal).
- Restores: after 0034, restoring a pre-0033 backup with `session_replication_role = replica` (RESTORE.md step 3) skips `ws_guard`, so fill the column in the insert (`coalesce(workspace_id, 'f5a1e000-0000-4000-8000-000000000001')`) or roll back 0034 first. RESTORE.md is not yet updated for this.
- `gmail_*` tables get `workspace_id` too (they are tenant data); they keep no owner policy, so members still cannot read them directly.

## Local rehearsal (Oct 17 2026, Postgres 17.11)
`PGHOST=/tmp PGPORT=54340 PGUSER=postgres bash native/supabase/migrations/pending/test/run_local.sh` (CI job `sql-prod-shape` runs the same),
then `bash .../test/lock_local.sh`. Files are sent the way the Management API sends them (`test/api_exec.py`).
- `run_local.sh`: Supabase-like roles + platform stubs, `baseline/prod_public_schema_2026-10-17_pre0015.sql` (= prod after 0014) + 0015 to 0032,
  regenerate 0035 from that shape, synthetic seed; probes as owner, a non-owner signed-in user, `ari_worker` and anon (216 table/view reads,
  159 function calls with each call undone) before, after each of 0033/0034/0035, after re-applying all three, and after the rollbacks:
  0 differences each time; `checks_after_e3.sql` passed; every rollback run twice without error; schema and policies after the rollbacks
  identical to before; apply again after the rollback, checks passed.
- `lock_local.sh`: (1) the lock profile table above; (2) a session holding ACCESS SHARE on `people` makes 0033 stop after 5s with
  28 of 42 tables done and no ledger row, the re-run finishes; (3) 2,500 explicit-null rows in `plays` + 3 in `people`: the first 0034 run
  fills 2,000 and stops asking for a re-run, the second finishes, `people.updated_at` untouched; (4) 0033 to 0035 applied under a
  continuous owner + `ari_worker` read/write loop: about 1,000 iterations, 0 errors, every row inserted during the apply got workspace Owner.


## Prod apply, Oct 20 2026 ~10:25 IST
Fresh backup ari_20261020_0454Z (45 tables, 3240 rows; restore-test row counts match, 0 mismatches) taken first. 0037 then 0038 sent through the Management API with a 1-day scoped PAT; checks_after_0037 and checks_after_0038 PASSED; ledger 0034..0038; 9 cron jobs, one row each; post-apply sync run clean. Evidence: work/prod_r5r6/.
