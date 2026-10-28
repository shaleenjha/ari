# S1 releases 5 and 6: proposed migrations (auditor, read-only, for Tony to apply)

**Files**, laid out as they'd sit under `native/supabase/migrations/pending/`:

| File | What it is |
|---|---|
| `0037_members_aal2.sql` + `_rollback.sql` | R5: members need the two-step code too (Basalt diff 1) |
| `0038_s1_release6.sql` + `_rollback.sql` | R6: the seven parts Hark listed |
| `test/checks_after_0037.sql` | The CI gate: enrol a factor, prove a Google-only (`aal1`) session reads 0 rows and can't write |
| `test/fixtures_before_0038.sql` | Local/CI only. Puts the throwaway database in prod's before-state with synthetic rows: 0036's functions, plus notifications that carry names. |
| `test/checks_after_0038.sql`, `test/checks_after_0038_rollback.sql` | R6 tests |
| `app/docs/code-step-spec.md` (repo path) | The app code step, for Tony |

## How they were tested

Local Postgres 17, built with the repo's own pieces:
- baseline + 0015..0032 + `gen_e3` + seed + 0033..0035, which is prod's ledger;
- each file sent as one query through `api_exec.py`, the way the Management API runs it.

| Step | Result |
|---|---|
| R5 test **before** 0037 | FAIL. Case 3: a member with a factor reads 25 tables at `aal1`. The owner-only case (4) fails the same way. |
| After 0037 | ALL 0037 TESTS PASSED (37 readable tables checked; 7 are closed to signed-in users anyway) |
| R6 test **before** 0038 | FAIL (part 1: DELETE still granted) |
| After 0038, re-applied, rolled back twice, applied again | ALL 0038 TESTS PASSED · ALL 0038 ROLLBACK CHECKS PASSED · R5 still passes · the existing `checks_after_e3.sql` still passes |

The proposed `run_local.sh` lines below were run end to end on a fresh build: all green.

## Order: what has to land differently, or be checked first

1. **Migration numbers clash with Diamond.** `docs/specs/06` is titled "Migration 0037". These files take 0037 and 0038, so Diamond becomes 0039 (a one-line rename in spec 06). If you'd rather keep 0037 for Diamond, rename these two; nothing inside depends on the number except the ledger insert and the R5 assertion text.
2. **R6 part 4 (drop `ari_worker_log_repair`):**
   - Land it only once the spec-05 Log repair is finished or abandoned.
   - `scripts/accept_ingest.py` calls both functions in its repair mode (`:638-651`) and checks they exist (`:736`). Retire that mode in the same release, or a later run reports "rpc missing".
   - Before applying on prod, save the live definition (`pg_get_functiondef`) and put it in the rollback if it differs from the repo copy.
3. **R6 part 2 (`apply_op`):** first confirm prod still runs the 0005 body:
   ```sql
   select md5(prosrc) from pg_proc where proname = 'apply_op';
   ```
   It must equal `c50815d0c0d5a6ef426f7868e44ce5b6` (the 0005 body, the one in the prod-shape baseline). If it doesn't, rebase diff 2 on prod's text.
4. **R6 part 2, a worker check:** the "Draft reply" queue item no longer names the person; it still targets their ID. Confirm the worker's prompt reads `queue.target`, not the name inside `details`.
5. **R6 part 6 (replies CASCADE) is safe now**, because part 1 removes the owner's DELETE in the same release, so only a maintenance session can delete a person. But **no hard erase until R8**: while the Sheet is two-way, the next sync re-creates the person and records the current draft as sent (data-side D2).
6. **R6 part 7:** if release 2 already wrote the 0036 ledger row and the two cron jobs, this part changes nothing. It's an `on conflict` insert, and `cron.schedule` with an existing name updates that job. Confirm the update-in-place behaviour once on staging: the test's part 7 asserts exactly one row per job name.
7. **R6 part 3** uses the wording the privacy trigger writes **today** (0031:307-328), not 0016's older wording, so stored rows match new ones. The test compares them kind by kind through the trigger.
8. **R5 can land any time.** It changes nothing until a factor exists. Owner enrols only after the app code step ships (spec attached). ops.html already has its own code step.
9. **Two of R6's seven parts can't be undone** by the rollback: the notification rewrite and the shadow-event purge. The rollback says so; backups hold the old state for 14 nights.

## Proposed lines for `native/supabase/migrations/pending/test/run_local.sh` (append at the end)

```bash
# S1 releases 5 and 6 (0037, 0038) on top of 0033..0035: synthetic before-state, apply, checks, idempotence,
# rollbacks (each twice), rollback checks, apply again + checks.
$P -f "$HERE/fixtures_before_0038.sql" >/dev/null
for m in 0037_members_aal2 0038_s1_release6; do api "$PEND/$m.sql"; echo "applied $m"; done
$P -f "$HERE/checks_after_0037.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
$P -f "$HERE/checks_after_0038.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
for m in 0037_members_aal2 0038_s1_release6; do api "$PEND/$m.sql"; done; echo "re-applied 0037, 0038 (idempotence): no error"
api "$PEND/0038_s1_release6_rollback.sql"; api "$PEND/0038_s1_release6_rollback.sql"; echo "rolled back 0038 (twice)"
$P -f "$HERE/checks_after_0038_rollback.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
api "$PEND/0037_members_aal2_rollback.sql"; api "$PEND/0037_members_aal2_rollback.sql"; echo "rolled back 0037 (twice)"
for m in 0037_members_aal2 0038_s1_release6; do api "$PEND/$m.sql"; done; echo "applied 0037, 0038 again after the rollback"
$P -f "$HERE/checks_after_0037.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
$P -f "$HERE/checks_after_0038.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
```

Each check file ends with an exception on failure, and `$P` uses `ON_ERROR_STOP`, so with `set -o pipefail` (already in the script) a failure turns the job red. Also update the job name in `ci.yml` ("pending 0032-0034") to say 0033-0038.

## On staging, after the apply

`checks_after_0037.sql` and `checks_after_0038.sql` are written to be staging-safe, but I haven't run them on real Supabase. Both run in one transaction that ends in ROLLBACK, with synthetic rows only:
- `checks_after_0037` creates a synthetic member and `auth.users` row, which adapts to the real `auth.mfa_factors` columns.
- `checks_after_0038` skips part 3 when there are no fixtures.

Never run `fixtures_before_0038.sql` on staging or prod.
