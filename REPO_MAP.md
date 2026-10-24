# Repo map

A plain guide to what is in this repo. Read it top to bottom once. After that, use it to look things up.

"Safe to ignore?" means: can you skip this when you are just trying to understand the product. It never means "safe to delete".

## The short version

- `web/` is the app you use today. It is frozen. Only safety fixes go in.
- `app2/` is the new app being built. All new screens go here.
- `native/supabase/` is the database: its change history, backups and server functions. The name "native" is old and misleading.
- `scripts/` are small programs Hark runs on a timer or by hand: sync, reports, backups, deploys, checks.
- `.github/` runs the automatic checks on every change. Red means not shipped.
- `docs/` holds the numbered specs and how-to guides. `archive/` holds old things kept for reference.

## 1. Live app (`web/`)

The app on your phone right now. One big page plus the files it needs.

| File | What it does | Safe to ignore? |
|---|---|---|
| `web/ops.html` | The whole live app in one file. Frozen. Changing it needs a written reason. | Yes, unless there is a safety fix |
| `web/sw.js` | Lets the app open fast and work offline. | Yes |
| `web/ari.webmanifest`, `web/ari-*.png` | App name and icons for "Add to Home Screen". | Yes |
| `web/ari-fonts.css`, `web/ari-*.woff2` | The app's fonts. | Yes |
| `web/ari-supabase.js` | A copied library the app uses to talk to the database. Not our code. | Yes |
| `web/vercel.json` | Hosting settings for the live site. Do not edit casually. | Yes |
| `web/build.json` | The version number of what is live. | Yes |
| `web/about.html`, `privacy.html`, `terms.html` | Public pages: about, privacy, terms. | Yes |

## 2. New app (`app2/`)

The rebuild. Built beside the live app. It reads real data but does not write yet. See `app2/README.md` for commands.

| Folder or file | What it does | Safe to ignore? |
|---|---|---|
| `app2/web/src/screens/` | One file per screen: Today, Today's 15 (`Today15.tsx`), Replies, Account room, Report, Sign in. Start here to see the product. | No |
| `app2/web/src/ui/` | Shared building blocks: icons, colours (`tokens.css`), offline cache, back button, error screen. | Mostly yes |
| `app2/web/src/data/` | How the app fetches data. `fixtures/` is fake data for tests, all from one invented sales world (made-up companies, clearly fake people). | Yes |
| `app2/web/e2e/` | Robot tests that tap through the app on small phone sizes. | Yes |
| `app2/web/scripts/design-lint/` | The design rules checker: tap size, contrast, banned words. | Yes, unless a check fails |
| `app2/web/scripts/query-lint/` | Checker that stops the app from writing data directly. | Yes |
| `app2/web/tokens/`, `scripts/tokens/` | The design colour and size list, and the tool that turns it into CSS. | Yes |
| `app2/web/public/` | Icons, splash screen, font and offline file for the new app. | Yes |
| `app2/jobs/src/gmail/` | Reads LinkedIn emails from Gmail and spots accepts and replies. | Yes |
| `app2/jobs/src/gmail/sample-linkedin-emails.ts` | Fake LinkedIn emails used by the tests. | Yes |
| `app2/jobs/src/gmail/fake-gmail-api.ts` | A pretend Gmail used by the tests. | Yes |
| `app2/jobs/src/draft-eval/` | Scores drafted DMs against the house style (length, no dashes, no hype). | Yes |
| `app2/jobs/src/runtime/` | The engine that runs background jobs one at a time, safely. | Yes |
| `app2/db/` | The new app's database design, its change files and tests. Practice only; not the live database. | Yes |
| `app2/docs/` | Notes for builders: job system, Gmail fetch, draft scoring, migration plan, sign-in code step. | Yes |
| `app2/docs/references/` | Outside style guides the builders follow. | Yes |

## 3. Database (`native/supabase/`)

The live database's history and tools. Handle with care.

| Folder or file | What it does | Safe to ignore? |
|---|---|---|
| `migrations/` | Every change ever made to the live database, numbered in order. Never rename these. | Yes, but never touch |
| `migrations/pending/` | Database changes written and tested but not live yet. Each has an undo file next to it. | Yes |
| `rollbacks/` | Undo files for the changes in `migrations/`. | Yes |
| `pending/MAINTENANCE.md` | Notes for a past hands-on database maintenance session. | Yes |
| `functions/` | Small programs that run inside the database host: backup, Gmail sign-in, Gmail read, push alerts. | Yes |
| `tests/` | Checks for database rules and the Gmail reader. | Yes |
| `baseline/` | A snapshot of the live database's shape, used by the checks. | Yes |
| `offsite/` | Public keys that lock the offsite backup copy. No secrets. | Yes |
| `RESTORE.md` | How to bring the database back from a backup. | No, read once |

## 4. Background jobs and scripts (`scripts/`)

Hark runs many of these on a timer. Names here must not change without updating the timers.

| File | What it does | Safe to ignore? |
|---|---|---|
| `sync_sheet_supabase.py` | Keeps the Outbound HQ Sheet and the database in step, both ways. | Yes |
| `worker_precheck.py` | Quick look for new work so idle runs stop early and save credits. | Yes |
| `health_check.py` | Raises one ALERT line when something is stale or broken. | Yes |
| `hygiene_scan.py` | Flags messy data like duplicates. Never edits. | Yes |
| `scan_heartbeat.py` | Records that each nightly account scan started and finished. | Yes |
| `reply_ingest.py` | Turns LinkedIn replies in Gmail into reply cards with 3 drafts. | Yes |
| `accept_ingest.py` | Spots "accepted your invitation" emails. | Yes |
| `brief_upsert.py` | Saves account briefs into the app. | Yes |
| `draft_tag.py`, `copy_switch.py` | Label drafts so Ari learns which messages work. | Yes |
| `daily_report.py` | Builds and emails the morning report. | Yes |
| `exec_track_handoff.py` | Emails the daily exec track list to your work inbox. | Yes |
| `phase0_metrics.py` | Product numbers: meetings, accepts, replies. | Yes |
| `copy_check.py` | The code check every drafted message must pass before Ari shows it. | Yes |
| `seller_config.py` | Who the seller is, the AE books and which customers a draft may name. Real values live in a private file outside the repo; the repo carries an invented demo workspace. | Yes |
| `ari_db.py` | The one door scripts use to reach the database, with limited rights. | Yes |
| `db_backup.py`, `backup_check.py`, `restore_drill.py`, `offsite_drive.py`, `offsite_certs.py` | Backups: make, check, practise restoring, copy offsite, lock the copy. | Yes |
| `deploy_web.py` | The only way to put the live app online. Refuses anything unusual. | Yes |
| `deploy_app2_preview.py` | Puts the new app on a separate test link for your phone check. | Yes |
| `deploy_provenance.py` | Blocks a deploy unless the code passed the checks on GitHub. | Yes |
| `git_sync.sh`, `git_export.py`, `git_pull_remote.py`, `git_push_api.py` | Publish code to this repo with real names removed and secrets blocked. | Yes |
| `repo_scan.py` | The leak check: no real names, personal emails, phone numbers, real-looking LinkedIn links or keys. Runs in CI on every push. | Yes |
| `test_*.py` | Automatic tests for the scripts above. | Yes |

## 5. Automatic checks (`.github/`)

| File | What it does | Safe to ignore? |
|---|---|---|
| `workflows/ci.yml` | Runs every check on each change: types, tests, design rules, copy rules, database rehearsal. One failure blocks shipping. | Yes, unless red |
| `workflows/repo-scan.yml` | The leak check (`scripts/repo_scan.py`) on every push, docs included. Red means real data got in. | Yes, unless red |
| `workflows/claude.yml` | Lets the outside auditor reply when someone writes @claude on GitHub. | Yes |

## 6. Plans and docs (`docs/`, root files)

| File | What it does | Safe to ignore? |
|---|---|---|
| `README.md` | One-page intro to the repo. | No |
| `REPO_MAP.md` | This guide. | No |
| `docs/specs/` | Numbered specs. 01 is the locked interaction and copy rulebook. 07 is the new look. | No for 01 and 07 |
| `docs/runbooks/` | Step-by-step guides: database changes, git sync. | Yes |
| `docs/privacy-data-inventory.md` | What data Ari holds, where, and for how long. | No, read once |
| `.gitignore` | Tells git which files to leave out. | Yes |

Plans, team notes, data files and screenshots are kept in the private workspace, not in this repo.

## 7. Archive (`archive/`)

| Folder | What it was | Safe to ignore? |
|---|---|---|
| `archive/ui/` | Old versions of the live app and design mockups, on synthetic data. Its README lists each one with its date. | Yes |
| (removed) | The unused Expo starter was removed Oct 21 2026; git history before that date still has it. | Yes |

## 8. Removed in the Oct 24 2026 clean-up

Dropped from the repo because nothing used them any more (the private workspace keeps its own copies):

| File | Why |
|---|---|
| `scripts/retro_stats.py` | One-off weekly retro script; nothing calls it. |
| `app2/docs/audit/01-stage1-audit-brief.md` | One-time brief for the Stage 1 outside audit. History. |
| `app2/docs/ci-gate-first-run-failures.md` | Notes on the first run of the strict checks. History. |
