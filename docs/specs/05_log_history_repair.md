# 05 Log history repair (atomic, sync paused)

Status: written Oct 18 2026 00:30 IST by Otto. Nothing has been run against the Sheet or Supabase. The dry run only read data.
Code: `scripts/accept_ingest.py repair-log`. Tests: `scripts/test_log_repair.py` (32 of 32 pass).
Needs: `work/0036_log_repair_rpc.sql` (a draft, not applied).
Dry run: `work/log_repair_dryrun_2026-10-18.json`.

## 1. Why a plain Sheet edit breaks the Log

How the sync builds the key (`sync_sheet_supabase.py` `log_key` and `sync_log`):
- For every non-blank Log row, in Sheet order, the key is `md5("ts␟person_id␟event␟detail")[:20] + "#" + n`.
- `n` counts identical rows (1 for the first, 2 for the second copy). The live Log has 39 rows with `#2`.
- `log_entries.sheet_key` is unique. On each run the sync inserts every Sheet key that is not in the DB.
- The sync never updates or deletes a DB Log row whose key has left the Sheet.

So if you rewrite a row in the Sheet, its key changes. The next sync inserts a second copy and the old DB row stays. A test proves this: `naive Sheet rewrite`.

There is a knock-on effect too. If an edited row becomes identical to another row, `n` can change for an untouched row further down. The planner recomputes every key across the whole tab, not just the edited rows. The live data has 0 such moves.

## 2. What the dry run found

Live dry run, Oct 18 00:21 IST. The Sheet Log has 383 rows and the DB has 383 rows. The two key sets are identical and every DB row has a key.

| Fix | Count | Rows / people |
|---|---|---|
| Column-swapped Log rows: `person_id` and `event` swapped, event set to `Accepted` | 3 | rows 257 (P154), 304 (P149), 370 (P156) |
| Nonstandard event names (`Accepted via Gmail`, `accepted via Gmail`, `accept`) | 3 | the same 3 rows |
| Untouched rows whose key moves | 0 | |
| Missing `Accepted` rows, added to both sides | 11 | P112 to P115, P133 to P139 |
| `accepted` corrected (People tab and DB) to the email time in IST | 12 | UTC-dated: P114, P115, P133, P134. Bare date: P112, P113, P135 to P139, P154 |
| Blockers | 0 | |

- The 3 edited rows also take the accept email's time as `ts` (for example 20:25 becomes 20:14), as 0032's RPC would. Their `detail` stays as it is.
- After the repair there will be 394 rows on each side.
- One new accept (P157, email at 00:14 IST Oct 18) is left out on purpose. The worker or scan records it with its own Log row. Adding it here would duplicate that row.

## 3. Procedure

Run it after prod has 0033 to 0035, and after `work/0036_log_repair_rpc.sql` is applied (see section 5).

Credentials: one shell call with credentials `[{"provider":"google","email":"owner@example.com"}]`. The worker bearer for Supabase is injected in the same command.

1. **Pause both writers.**
   - Pause task `56e17ef1` (sync) **and** task `e8fbd86f` (worker).
   - The worker writes Log rows straight into the Sheet; that is where the swapped rows came from. Its step 6 also runs the sync.
   - Then wait at least 15 minutes.
2. **Dry run again:** `python3 scripts/accept_ingest.py repair-log --dry-run --out work/log_repair_dryrun_<date>.json`. The counts should match section 2, with no blockers.
3. **Execute:** `ARI_SYNC_PAUSED=1 python3 scripts/accept_ingest.py repair-log --execute --out work/log_repair_run_<date>.json`.
   - **Preflight** refuses to run unless all of these hold:
     - the env flag is set;
     - `sync_state.lock` is free (older than 8 minutes);
     - `sync_state.last_run` is older than 15 minutes;
     - `scan_heartbeat.running` is false;
     - the 0036 RPC exists;
     - the plan has no blockers. Blockers include: any Sheet key missing from the DB, any DB key missing from the Sheet, a DB row whose content differs from its Sheet row, and a key collision.
   - **Lock:** it writes `sync_state.lock = {holder: repair-log}` and refreshes it before every item. A stray sync then exits with "another sync holds the lock".
   - **Snapshot:** it saves `work/backups/log_repair_<utc>/snapshot.json`. This holds the Sheet Log and People tabs, every `log_entries` row, `people` (id, accepted, ts_approx), the matched accept emails and the plan. Every write is logged in `journal.jsonl`.
   - **Each Log fix:**
     - First the DB: `ari_worker_log_repair(old_key, new_key, expect=old content, set=new content)`. It finds the row by its OLD key, checks its content and sets the new content and new key.
     - Then the Sheet: the row is rewritten only if it still holds the old values.
     - Key moves run in an order where no update takes a key another row still holds.
   - **Each missing row:**
     - The DB insert comes first. It uses `source='backfill'`, `detail='gmail backfill'` and the key the sync would compute for that row.
     - Then the Sheet row is written at its planned row number (385 to 395), oldest first.
   - **Each accepted date:**
     - DB: `PATCH people.accepted` to the email time. Not noon, so the 0028 trigger clears `ts_approx`.
     - Sheet: the People `accepted` cell becomes `yyyy-MM-dd HH:mm` IST.
4. **Post-check** (automatic):
   - Sheet keys equal DB keys.
   - The row counts equal the planned 394.
   - The sync's own `sync_log` in dry-run mode reports `insert: 0`.
   - A fresh plan is empty.
   - Then it releases the lock and writes `finished.json`.
   - The output's `next` says either "resume tasks" or "KEEP THE SYNC PAUSED".
5. **Resume** both tasks. Watch the first sync line: `Log {"insert": 0, "append": 0}`, or appends only for app taps made during the pause.

## 4. Safety properties (each covered by a test)

- **Idempotent.**
  - Every step checks the current state first.
  - A second `--execute` prints "nothing to repair" and makes zero writes.
  - After the repair, the sync's People diff sees the same date on both sides, because `canon()` reduces a time to its date. So it does not flip anything back.
- **If it fails halfway:**
  - Keep the sync paused.
  - Running `--execute` again finds the unfinished backup (no `finished.json`) and finishes that run's plan, matching rows by DB id. Identical rows can share content and keys, so the id is the only safe handle.
  - Tested by crashing after each of the 17 writes in the fixture: every rerun ended in the same state as a clean run.
- **Rollback:** `ARI_SYNC_PAUSED=1 python3 scripts/accept_ingest.py repair-log --rollback work/backups/log_repair_<utc>`.
  - It works in reverse order. Each step reverts only a value that is still in its repaired state.
  - It covers: People cells and `accepted` (back to the noon value, which re-flags approx), the appended Sheet rows (cleared; the sync skips blank rows), the 11 inserted DB rows (`ari_worker_log_unappend`, which deletes only `source='backfill'` rows from the last 7 days), and the edited rows (content and key restored by id).
  - You can run it again safely, including after a half-done run. Tested at every crash point.
  - Note (Oct 2026): `ari_worker_log_unappend` is dropped by migration 0038, so this rollback path no longer exists after 0038.
- **App taps during the pause** are fine. They add DB Log rows without a key, and the sync appends them to the Sheet on resume. Keys are computed from Sheet rows only, so these rows do not touch the repair.

## 5. Migrations

- **0036 is needed.** Role `ari_worker` may only `UPDATE log_entries(sheet_key)` (0018) and cannot DELETE. So it cannot rewrite the 3 swapped rows' content or undo an insert.
  - `work/0036_log_repair_rpc.sql` adds two narrow SECURITY DEFINER functions, granted to ari_worker only. They are described in section 3 and section 4.
  - The SQL is **untested**: there was no Postgres in the sandbox. The fake in the tests copies its logic.
  - It has to be applied while the Supabase PAT is still live, so in the step 4 window, before step 5 revokes the PAT. Alternatively, keep the PAT until the repair runs.
- **0033 to 0035 (checked by reading the files).**
  - 0033 adds `log_entries.workspace_id uuid default 'f5a1e000-0000-4000-8000-000000000001'` (line 231). Inserts that leave the column out get workspace Owner.
  - 0034 adds trigger `ws_guard` (`app.ws_guard()`, lines 48 to 58), which turns a NULL on insert into Owner and only refuses a *change* of `workspace_id`.
  - The repair never sends `workspace_id`, so both the default and the trigger cover it. 0036 updates never touch the column.
  - 0035 leaves the ari_worker policies untouched. The 0036 functions are security definer anyway.
  - The `(workspace_id, id)` unique index does not matter here; `sheet_key` stays globally unique.
- **0032 is not needed** by the repair: the `accepted` fixes are plain `people` PATCHes, which the worker already has rights to.
  - Spec 04 backfill step 3 (`scan --backfill` without `--dry`, through `ari_worker_accept_record`) can run before or after the repair.
  - If it runs after, it only records the `gmail_events` ids: every time is already exact and `was` is not null, so it adds no Log row.

## 6. For Owner to decide

1. 0036: apply it in the step 4 window (recommended), or keep the PAT until step 6.
2. The 3 edited rows: should `ts` move to the email time (as planned) or keep the time the worker logged it? Their `detail` stays as it is.
3. The `detail` for the 11 new rows: `gmail backfill` (as planned) or `gmail`, to match 0032.
4. The new rows go at the bottom of the Log (rows 385 to 395, dated Oct 5 to 12), not in date order. Inserting them in date order would be possible, but it is riskier.
5. Root cause: the worker prompt (task `e8fbd86f`, step 0) says "Append a Log row (accepted via Gmail)" with no column order. Fix the wording before resuming, or the swapped rows will come back.
6. Note (inferred, not verified): 13 of 15 accept emails arrived at minute :14. LinkedIn seems to batch these notifications hourly, so the email time is the latest the accept could have happened, not the exact moment.

## 7. Later: a stable row id for Log

Content should stop being the key.
- Add a Sheet column `row_id` (E) and a `log_entries.row_id uuid unique default gen_random_uuid()`.
- Whoever appends a Log row (worker, app sync, scripts) writes a UUID.
- The sync matches on `row_id` when it is present and falls back to the hash for older rows. Backfill: `row_id` set to the DB's value for every keyed row, in one paused run like this one.
- After that, editing a Log row's content is a normal two-way field update and needs none of the above.
