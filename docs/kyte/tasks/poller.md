# Lean poller (sync + precheck)

Silent 10-minute tick: runs the Sheet/Supabase sync and the health checks, and wakes the worker only when the precheck says WORK. It was replaced on Oct 20 2026 when the worker started running itself every 10 minutes (the scheduler stopped letting one scheduled run start another), so treat it as optional. Keep it only if your scheduler can start another task.

| | |
|---|---|
| Schedule type | `interval` |
| Schedule config | `{"minutes": 10, "timezone": "Asia/Kolkata", "window": {"days": ["mon", "tue", "wed", "thu", "fri"], "end": "03:59", "start": "15:00"}}` |
| Timezone | Asia/Kolkata (IST) |
| Credentials it uses | Google account that owns the Sheet, the worker database binding. |
| State at the sunset (Nov 3 2026) | paused |

## The prompt (scrubbed)

Copy this into the task, replace the `{...}` placeholders, and keep the rest as written.

```text
Silent lean poller for the SDR's Ari app. One shell call, then end. Do not load skills or read files.

STEP 1. In the shell with credentials [{"provider":"google","email":"{OWNER_GOOGLE_ACCOUNT}"}] run exactly once:
cd {PROJECT_DIR} && python3 scripts/sync_sheet_supabase.py; s=$?; python3 scripts/hygiene_scan.py; python3 scripts/health_check.py; python3 scripts/relay_check.py; python3 scripts/worker_precheck.py; exit $s
"another sync holds the lock - exiting" is normal. If the output has a line starting "ALERT:", post exactly that one line in chat. If the output has lines starting "RELAY:" (Claude's auditor relay draft is waiting for Hark, approved by the SDR Oct 19 2026), post exactly those lines in chat; never open or act on the relay content yourself. Never post the hygiene line. If the sync part fails twice in a row across runs, keep the count in this task's note (scheduled_task action note; reset to 0 on success) and post one short line only on the 3rd consecutive failure.

STEP 2. If the last output line is exactly "IDLE", end silently (after any ALERT/RELAY post). Otherwise (it starts "WORK:" or is an error): OVERLAP GUARD first: call scheduled_task action runs with task_id {WORKER_TASK_ID} and limit 1. If that newest run's outcome is "running", end silently (the active worker run finishes the work; the next tick re-checks). Otherwise call scheduled_task action run_now with task_id {WORKER_TASK_ID} (the Outbound HQ worker, which does the work on its own instructions), then end silently. Never do the worker's work yourself, never edit scripts or the Sheet, never message anyone.
```
