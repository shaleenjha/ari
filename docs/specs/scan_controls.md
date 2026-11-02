# Scan controls (backend half)

Approved by Owner Oct 30 2026 19:24 IST. Status: WRITTEN. Migration `0052_scan_controls` rehearsed locally only; staging first, prod only with Owner and a short-lived PAT.
The Settings screen is built after the web/ops.html sync fix lands. This spec is everything that screen needs.

## What it is
Owner decides from the app when Kyte reads his LinkedIn lists and profiles: on or off, how often, which days, which hours, and "Scan now".
LinkedIn stays read-only. Nothing in this feature connects, messages, likes, follows or withdraws. It only changes **when** the three read scans run.

| Scan (`scan`) | Today | Task |
|---|---|---|
| `connections` | Connections list read, weekdays 14:45 IST, once | 65ecf885 (cron `45 14 * * 1-5`) |
| `sent` | Sent invitations read, Mondays 14:30 IST, once | b31e4e93 (weekly) |
| `profile` | One profile per run, at most 5 per batch, 2 h rest, 15 min gap (`scripts/profile_scan.py`) | 6ce5ff32 (every 20 min, weekdays 15:00 to 03:59) |

The worker e8fbd86f (every 10 min, weekdays 15:00 to 03:59) does not change and never opens LinkedIn.

## Time model
- All times are IST.
- A **scan day** runs 04:00 to 03:59 IST, the same day the worker window uses. A window like 15:00 to 03:59 is one day, and its weekday is the day it started on (a Friday 15:00 to Saturday 03:59 window counts as Friday).
- Owner's hours must sit inside one scan day (start before end, counting from 04:00).

## Settings per scan (table `scan_settings`, one row per workspace and scan)
| Field | Values | Default (= today) |
|---|---|---|
| `enabled` | on / off. The screen's "Off" frequency sets this to off and keeps the last frequency. | on for all three |
| `frequency` | `1x` or `2x` a day. Profile also has `paced` (as many as pacing allows, up to the daily cap). For profile, 1x = one batch of 5, 2x = two batches (10). | connections `1x`, sent `1x`, profile `paced` |
| `days` | any of mon..sun, at least one | connections mon-fri, sent mon, profile mon-fri |
| `start_time`, `end_time` | IST, minutes, inside the allowed hours below | connections 14:45 to 03:59, sent 14:30 to 03:59, profile 15:00 to 03:59 |

Today's one-shot cron at 14:45 becomes "due from 14:45, once". The end of 03:59 lets a scan that missed its start catch up later that day instead of skipping it; it never adds a second run.

Minimum gaps so LinkedIn does not flag the account (fixed, see caps): with `2x`, the second connections read starts at least 4 h after the first, the second sent read at least 6 h after. The set RPC refuses `2x` when Owner's window is shorter than that gap (`window_too_short`).

## Safety caps (cannot be raised from the app)
They live in code, in `kyte_scan_caps(scan)` (an immutable SQL function). Only a new migration can change them. The set RPC validates against them, and the decision function enforces them before anything else, Scan now included.

| Cap | connections | sent | profile |
|---|---|---|---|
| Runs per scan day, scheduled and Scan now together | 3 | 2 | 25 profiles |
| Gap between two scheduled runs (2x) | 240 min | 360 min | 15 min |
| Gap between any two runs (Scan now too) | 60 min | 60 min | 15 min |
| Allowed hours for any start | 09:00 to 03:59 | 09:00 to 03:59 | 09:00 to 03:59 |
| Rows read per run (enforced in the task prompt, documented here) | 80 | 300 | 1 profile |
| A run with no finish counts as abandoned after | 90 min | 90 min | 60 min |

Plus two rules that hold across scans:
- **One LinkedIn read at a time.** All three share one signed-in browser (`linkedin-shal`). While any scan has a running row, every other start answers `busy`.
- **A LinkedIn check stops that scan.** When a run reports `blocked` (security check, captcha, restriction), that scan is held (`blocked_at`) until Owner taps Resume. No schedule or Scan now gets past it. This replaces today's "pause the task until Owner says resume".
- profile_scan.py keeps its own pacing (5 per batch, 2 h rest, 15 min gap). The gate never loosens it.

## The decision (`kyte_scan_decide(scan, now)`)
One function, used by the worker RPCs and by the screen. Returns `{run, reason, next_due}`. Checked in this order:

1. `blocked`: held after a LinkedIn check.
2. `busy`: another scan is reading LinkedIn now.
3. `daily_cap`: the hard daily cap is used up.
4. `too_soon`: less than the hard gap since the last run of this scan (looks back across 04:00).
5. `outside_allowed_hours`: now is outside 09:00 to 03:59.
6. `requested` (run): a Scan now is pending (younger than 12 h). Runs even when the schedule is off, on a non-active day or outside Owner's hours, because Owner asked for it. Caps 1 to 5 still apply.
7. `off`: schedule off.
8. Inside Owner's day and hours: `gap` (2x, waiting for the second slot), `due` (run), or `done_today`.
9. Otherwise `not_today`, `before_hours`, `after_hours`, `done_today`, with `next_due` = the next scheduled start.

Runs counted: anything that opened LinkedIn or was claimed to (`running`, `ok`, `empty`, `error`, `blocked`, `abandoned`). `idle` runs do not count. Scheduled frequency counts only scheduled runs; Scan now runs count toward the hard caps only.

## Scan now
`run_now` from a scheduled run is refused by the scheduler, so a tap cannot start a task directly. The tap stores a request; the next poll of that scan claims it.

**Options**
- A. The worker runs the scan inline. The worker already wakes every 10 minutes.
- B. Each scan task polls every 10 minutes and no-ops unless the gate says due or requested.

**Recommendation: B.**
- The worker's own rule is "never open LinkedIn in a browser". Inline scans would break the one rule that keeps the worker away from LinkedIn.
- A browser read takes 3 to 6 minutes. Inside the worker it would hold the worker lock while Owner waits for drafts.
- The worker only runs weekdays 15:00 to 03:59, so a Sunday Scan now would wait until Monday.
- B keeps one task per scan, so one scan failing never stalls another, and the gate's `busy` rule stops two reads overlapping.

**Cost of B, stated plainly:** an idle poll is one shell call that prints `SKIP ...` and ends. With all three tasks polling every 10 minutes from 09:00 to 03:59, every day, that is about 114 idle runs per task per day (about 340 in total) on top of today's ~39 profile polls. If that is too much for Owner's pool, phase 2 merges the three into one "scan runner" task (`scan_gate.py next` picks the one scan that is due, requested first), which cuts idle runs to about 114 a day. Not built now.

**Flow**
1. Owner taps Scan now. The app calls `kyte_scan_request(scan)`. It stores `requested_at` (a second tap while pending changes nothing) and returns the current decision, so the screen can say when it will run.
   - If the daily cap is used up the request is not stored (`error: daily_cap`), so it never carries into the next day.
   - If held by a LinkedIn check: `error: blocked`.
2. Within 10 minutes (inside the allowed hours), that scan's task runs `scan_gate.py start <scan>`. `kyte_worker_scan_start` locks the settings rows, abandons stale running rows, decides, inserts a `running` row with `trigger = 'requested'` and clears the request, all in one transaction. Two polls can never both claim it.
3. The task does its read and ends with `scan_gate.py finish <run_id> <result>`.
4. A request older than 12 h expires unclaimed. Cancel: `kyte_scan_request(scan, true)`.

## Last run, result, next due
`kyte_scan_settings_get()` returns, per scan: the settings, `requested`, `blocked`, `last_run` (`started_at`, `finished_at`, `result`, `items`, `trigger`; idle runs skipped), `decision` (`run`, `reason`, `next_due`) and `caps` (so the screen can show the limits). `next_due` is an estimate at the next poll: a task polling every 10 minutes starts up to 10 minutes after it.

Run results: `ok` (read and something new), `empty` (read, nothing new), `idle` (claimed but nothing to do, e.g. profile queue empty), `error`, `blocked`, `abandoned` (no finish within the stale time).

Why not reuse `scan_runs` (0032): `ari_scan_deadman()` reads it with a 25 minute miss rule meant for the old 10 minute signal scan, so daily LinkedIn reads there would raise false alarms every day; and `ari_worker` cannot read it. `ari_prefs` was not reused either: it is a key/value table the owner may write, and these settings need typed checks, caps and owner-only writes. Hence two new tables, `scan_settings` and `scan_control_runs`.

## How each task reads the settings and skips itself
`scripts/scan_gate.py` (worker role through `scripts/ari_db.py`, no raw SQL, no credentials parameter needed):

```
python3 scripts/scan_gate.py check <scan>                read-only:  RUN <reason> | SKIP <reason> [next HH:MM IST, Day]
python3 scripts/scan_gate.py start <scan> [--task <id>]  claims:     RUN <run_id> <reason> | SKIP <reason> [next ...]
python3 scripts/scan_gate.py finish <run_id> <ok|empty|idle|error|blocked> [--items N] [--note "short text"]
python3 scripts/scan_gate.py status
```

**Fails open.** Before 0052 is applied, after its rollback, or when the RPC is missing, it prints `RUN none no_settings` (and `finish none ...` prints `OK not recorded`). When the database cannot be reached it prints `RUN none gate_unreachable`. Either way the scan behaves exactly as it does today, still bounded by its schedule and profile_scan.py's pacing. A permission error (403) is treated as unreachable, also RUN, so a grant mistake can never silently stop the scans; the `status` line shows it.

### Exact prompt lines to add (do not apply until 0052 is live on prod)
Change the three tasks on a weekday morning before 14:30 IST or at a weekend, so the first poll does not repeat a read that already ran today (the run table starts empty).

**65ecf885 connections** (and change the schedule to interval 10 min, window every day 09:00 to 03:59). Insert as the new first step:
> 0. GATE. First tool call, shell, no credentials: `cd /workspace/projects/d84638cf-73aa-405d-b0e8-5ed983885c65 && python3 scripts/scan_gate.py start connections --task 65ecf885`. If the output starts with SKIP, end the run at once, silently, with no other tool call. If it starts with RUN, remember the second word as RUN_ID and continue.

and as the new last step:
> 5. FINISH. Last tool call, also when a step failed: `cd /workspace/projects/d84638cf-73aa-405d-b0e8-5ed983885c65 && python3 scripts/scan_gate.py finish <RUN_ID> <result> --items <new rows applied>`. result = ok when the apply step marked anything new, empty when it marked nothing, error when the browser or the apply step failed, blocked when LinkedIn showed a security check, captcha or restriction (add --note "security check"). A blocked result holds this scan until Owner taps Resume in the app; do not pause the task yourself.

**b31e4e93 sent** (schedule: interval 10 min, window every day 09:00 to 03:59). The same two lines with `sent` and `--task b31e4e93`.

**6ce5ff32 profile** (schedule: interval 10 min instead of 20, window every day 09:00 to 03:59). Replace STEP 1 with:
> STEP 1 (first and, when idle, only tool calls). Shell, credentials [{"provider":"google","email":"owner@example.com"}]: `cd /workspace/projects/d84638cf-73aa-405d-b0e8-5ed983885c65 && python3 scripts/scan_gate.py check profile && python3 scripts/profile_scan.py next`. If the first line starts with SKIP, or the last line starts with IDLE, REST or WAIT: end the run at once, silently. Otherwise the last line is one JSON person. Then run `python3 scripts/scan_gate.py start profile --task 6ce5ff32`: SKIP means end silently; RUN gives RUN_ID.

and in STEP 2 replace the "pause yourself with scheduled_task" instruction with:
> run `python3 scripts/scan_gate.py finish <RUN_ID> blocked --note "security check"` and `python3 scripts/profile_scan.py skip <id> blocked`, post ONE chat line that profile scans are held until Owner taps Resume in the app, and end.

and add after STEP 3 (and on the "profile unavailable" path, with `idle`):
> run `python3 scripts/scan_gate.py finish <RUN_ID> ok --items 1` (or `idle` when the profile was unavailable, `error` when the browser failed).

Note: `check` before `profile_scan.py next` keeps idle polls to one shell call and writes nothing; only `start` writes a run row.

## How the app reads and writes (owner-only RPCs)
No direct client writes. The app calls only these RPCs, all `security definer`, `search_path = public`, each opening with `is_owner()` (Owner's user id; two-step code required once he enrols a factor). Anyone else gets error 42501; anon cannot execute them at all.

| RPC | Args | Returns |
|---|---|---|
| `kyte_scan_settings_get()` | none | `{now, scans: [view x3]}` in the order connections, sent, profile |
| `kyte_scan_settings_set(p_scan, p_enabled, p_frequency, p_days, p_start, p_end)` | null keeps the current value | `{ok: true, scan: view}` or `{ok: false, error}`; errors `unknown_scan`, `bad_frequency`, `bad_days`, `bad_hours`, `hours_outside_limits`, `window_too_short` |
| `kyte_scan_request(p_scan, p_cancel default false)` | | `{ok, scan: view, decision}` or `{ok: false, error: daily_cap / blocked}` |
| `kyte_scan_resume(p_scan)` | | `{ok, scan: view}` |

Worker RPCs (role `ari_worker` and `service_role` only; never `authenticated`): `kyte_worker_scan_check(scan)`, `kyte_worker_scan_start(scan, task)`, `kyte_worker_scan_finish(run, result, items, note)`.
Helpers `kyte_scan_caps`, `kyte_scan_daymin`, `kyte_scan_decide`, `kyte_scan_view`: `service_role` only.
Tables: RLS on, owner read policy, `select` granted to `authenticated` (RLS limits it to the owner), no insert, update or delete for `authenticated`, nothing for `anon` or `ari_worker`, full explicit grants to `service_role` (Supabase Data API rule, Oct 30 2026: nothing is exposed by default). Workspace-scoped like 0033 (`workspace_id` defaults to the Owner workspace, foreign key to `app.workspaces`).

### Open decision for the UI build: where the screen lives
The CI rule `no-client-writes` (app/web/scripts/query-lint, part of `npm run lint:slop`) bans **every** write from app/web/src today, `.rpc(` included, with no allow escape (Phase 1, read-only app). web/ops.html, the live app, is frozen under plans/base-lock.json (data-loss and security fixes only). So the Settings screen cannot ship as written in either place without one of:
- **A (recommended):** a narrow lint change: allow `.rpc(` only for a named list of owner RPCs (`kyte_scan_settings_get`, `kyte_scan_settings_set`, `kyte_scan_request`, `kyte_scan_resume`), still no `.insert/.update/.upsert/.delete`, the list kept in the lint source (not allow.json) so any addition is a reviewed code change. Needs Owner's yes, since the rule says "no allow escape".
- B: build it in web/ops.html under a base-lock exception. Needs Owner's yes and a new base md5.
Reads alone (`kyte_scan_settings_get`) still go through `.rpc(`, so even a read-only status card needs A or B.

## Copy for the Settings screen
Plain, short, no dashes, no timezone or city names, no infrastructure words. Section title **LinkedIn reads**.

Intro line: "Kyte reads your LinkedIn lists and profiles. It never connects, messages or likes."

Scan names: **Connections** ("New accepts"), **Sent invites** ("Invites still waiting"), **Profiles** ("One profile before each first message").

Frequency chips: "Off", "Once a day", "Twice a day"; Profiles adds "As paced" (helper: "Up to 25 a day, 5 at a time with a rest").
Days row: "Mon Tue Wed Thu Fri Sat Sun". Hours: "From" and "Until" (label "Your hours").

Status line, by `decision.reason`:
| reason | Line |
|---|---|
| due, requested | "Running in the next 10 minutes" |
| gap, before_hours, after_hours, done_today, not_today | "Next: {next_due as Tue 2:45 PM}" |
| off | "Off. Scan now still works." |
| busy | "Waiting for another read to finish" |
| too_soon | "Next possible: {next_due}" |
| daily_cap | "Done for today. Daily limit reached." |
| outside_allowed_hours | "Runs at {next_due}" |
| blocked | "Paused. LinkedIn asked for a check." |

Last run line: "Last read {started_at as Today 2:47 PM}: {n} new" (ok), "nothing new" (empty), "nothing to read" (idle), "didn't finish" (error, abandoned), "LinkedIn asked for a check" (blocked). None yet: "Not run yet".

Buttons: "Scan now" (pending: "Cancel scan"), "Resume reads" (only when blocked; confirm sheet "Open LinkedIn on your phone first and clear the check. Then resume.").
Scan now toast: "Scan queued. Runs in the next 10 minutes." or, outside the allowed hours, "Scan queued. Runs at {next_due}."
Set errors: hours_outside_limits "Reads can run between 9:00 AM and 3:59 AM." · bad_hours "Pick an end after the start." · window_too_short "Twice a day needs at least {gap} hours between From and Until." · daily_cap "Daily limit reached. Try again tomorrow."
Limits footnote (from `caps`): "Limits you can't change here: up to {max_runs_day} reads a day, at least {now_gap_min} minutes apart, one read at a time."

## Naming rule
Kyte never names Hark, Ari, Den, Kelvarrow or any vendor in anything the user sees: screen copy, toasts, errors, notes. The RPCs return reason codes only; the screen maps them to the copy above. Run notes written by the tasks stay short and factual ("security check") and are never shown verbatim. Internal identifiers follow docs/engineering/code-names.md (new objects are `kyte_*`; the role stays `ari_worker`).

## Files
- `native/supabase/migrations/pending/0052_scan_controls.sql`, `0052_scan_controls_rollback.sql`
- `native/supabase/migrations/pending/test/checks_after_0052.sql` (one statement, ends in a deliberate raise; staging-safe), lines appended to `test/run_local.sh`
- `scripts/scan_gate.py`, `scripts/test_scan_gate.py` (in the CI scripts job)

## Next
1. Staging: apply 0052, run checks_after_0052, roll back twice, apply again (needs Owner's staging PAT).
2. Prod: same, with a prod PAT.
3. Update the three task prompts and schedules as above, before 14:30 on a weekday or at a weekend.
4. Owner picks A or B above, then the Settings screen is built after the ops.html sync fix lands.
