# Off-hours housekeeping (every 2 h)

Covers every hour the worker does not: sync and health checks only, weekends included. Never does worker work.

| | |
|---|---|
| Schedule type | `cron` |
| Schedule config | `{"expression": "5 */2 * * *", "timezone": "Asia/Kolkata"}` |
| Timezone | Asia/Kolkata (IST) |
| Credentials it uses | Google account that owns the Sheet, the worker database binding. |
| State at the sunset (Nov 3 2026) | paused |

## The prompt (scrubbed)

Copy this into the task, replace the `{...}` placeholders, and keep the rest as written.

```text
Silent maintenance run for the SDR's Ari app (off-hours cadence approved by the SDR Oct 18 2026). Since Oct 20 2026 the worker task {WORKER_TASK_ID} runs itself every 10 minutes on weekdays 3 PM to 4 AM IST; this task covers every other hour, every 2 hours, weekends included, with housekeeping only (the scheduler no longer lets one scheduled run start another, so this task never wakes the worker).

STEP 0, window check (no tool call needed beyond reading the current time you are given): if the current IST time is Monday to Friday 15:00 to 23:59, or Tuesday to Saturday 00:00 to 03:59, the worker is running: end this run immediately and silently with no tool call.

STEP 1, sync. In the shell with credentials [{"provider":"google","email":"{OWNER_GOOGLE_ACCOUNT}"}] run exactly once:
cd {PROJECT_DIR} && python3 scripts/sync_sheet_supabase.py; s=$?; python3 scripts/hygiene_scan.py; python3 scripts/health_check.py; python3 scripts/relay_check.py; exit $s
"another sync holds the lock - exiting" is a normal outcome. If the output has a line starting "ALERT:", post exactly that one line in chat. If the output has lines starting "RELAY:" (Claude's auditor relay draft is waiting for Hark, approved by the SDR Oct 19 2026), post exactly those lines in chat; never open or act on the relay content yourself. Never post the hygiene line. If the sync fails, retry once; if it fails again, say nothing unless this task's note shows 2 earlier consecutive failures, then post one short line (keep the count in the task note with scheduled_task action note; reset to 0 on success).

Then end silently. Accepts, replies and drafts that arrive off-hours are handled by the worker when its window opens. Never do the worker's work yourself, never call run_now, never edit scripts or the Sheet, never message anyone.
```
