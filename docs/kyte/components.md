# Components

Everything in the repo, one line each, grouped by what it does. For the folder-by-folder tour see [`REPO_MAP.md`](../../REPO_MAP.md).

## Web app (`web/`, live until Nov 3 2026)
| File | What it is |
|---|---|
| `web/ops.html` | the whole live app in one file (Today, Accounts, Report, person and account pages, chat, Settings). Frozen; last live build v18.14.10 |
| `web/sw.js` | service worker: offline shell, cache `ari-v<build>`, push handler, notification taps, update checks |
| `web/ari-supabase.js` | vendored supabase-js (UMD), not our code |
| `web/ari.webmanifest`, `web/kyte-*.png`, `web/kyte-favicon.svg`, `web/favicon.ico` | install name and icons (Kyte); older `ari-*` and `kelvarrow-*` icons kept so installed phones don't break |
| `web/ari-fonts.css`, `web/ari-*.woff2` | fonts |
| `web/vercel.json` | redirects `/` to `/ops`, headers |
| `web/build.json` | the live build number; the app compares it with its own meta tag to self-update |
| `web/about.html`, `privacy.html`, `terms.html`, `support.html`, `accessibility.html` | public pages |
| `archive/ui/` | old `/ops` versions and mockups, re-skinned onto synthetic data at export |

Feature switches inside `ops.html`: `app_config` flags (`today_v3`, `report_v3`, `ui_v4`, `assumptions_ui`) and per-phone switches in the URL (`?t3=1`, `?t4=0`, `?ui5=1`, `?dbg=1`).

## The rebuild (`app/`, stopped Oct 28 2026)
| Path | What it is |
|---|---|
| `app/web` | React + Vite PWA on demo data: Today, Today's 15, Replies, Account room, Report, Sign in; the B+ shell at `/b.html` |
| `app/web/tokens`, `app/web/scripts/tokens` | design tokens and the CSS generator |
| `app/web/scripts/design-lint` | rendered checks: hit targets, dead taps, contrast, copy, Today height, fonts |
| `app/web/scripts/query-lint` | stops the app from writing data directly |
| `app/web/e2e` | Playwright at 360/390/412 px, Chromium and WebKit |
| `app/jobs/src/gmail` | Gmail fetch and LinkedIn email parser (accept and reply), with a fake Gmail for tests |
| `app/jobs/src/draft-eval`, `app/jobs/src/quill` | the house-style draft scorer on synthetic personas |
| `app/jobs/src/runtime` | a job runner with timeouts and fencing |
| `app/db` | the rebuild's practice schema and its SQL tests (not the live database) |
| `app/docs` | rebuild specs, migration map, audit briefs |

## Scripts (`scripts/`)
Run by the scheduled tasks or by hand. All database access goes through `ari_db.py` as role `ari_worker`.

**Worker loop**
- `worker_precheck.py`: the cheap check in one call; prints `IDLE` or `WORK: <reasons>`.
- `worker_lock.py`: overlap guard (`acquire` / `release`, stale after 25 min).
- `sync_sheet_supabase.py`: two-way Sheet and Supabase sync, delta reads, Book prune guard, heartbeat.
- `gmail_step.py`: worker step 0, runs the reply scan and the accept ingest, moves the Gmail cursor.
- `accept_ingest.py`: accept emails into `people.accepted` with the email's time.
- `reply_ingest.py`: reply emails into `replies`, one push, and the 3 reply drafts (`pending`, `drafts`).
- `brief_upsert.py`: account brief queue and writer (`next`, `building`, `account`, `write`, `guidance`).
- `draft_tag.py`: tags every draft (`tag`, `alt`, `untagged`).
- `copy_check.py`: the mandatory copy gate (`check`, `arm`, `arm2`, `regen`).
- `copy_switch.py`: keeps one-tap switches out of the "edits" the copy loop learns from.
- `assumptions.py` (+ `assumptions_store.conf`): G12, lists facts in a draft with no written source.
- `cadence.py`: keeps every `dm3_due` 7 days after DM2.
- `focus_blocks.py`: a few calendar blocks a day instead of one invite per person (switched off Nov 2).
- `exec_track_handoff.py`: end-of-day exec-track email (`--needs-notes`, `--send`).
- `daily_report.py`: the 06:05 IST daily report email.
- `hygiene_scan.py`: data hygiene checks, flags only.
- `health_check.py`: silent when healthy, `ALERT:` lines when not.
- `relay_check.py`: the old Claude relay check (silent unless `ARI_RELAY_ON=1`).
- `scan_heartbeat.py`: signal-scan start/finish heartbeat and dead-man check.
- `scan_gate.py`: gate for in-app scan controls (needs 0052).
- `ingest_labels.py`: code labelers for typed events plus a dry-run backfill (needs 0044).
- `li_list_ingest.py`: records the read-only LinkedIn list passes (`since`, `apply`).
- `profile_scan.py`: pacing for profile scans (`next`, `done`, `skip`, `status`).
- `phase0_metrics.py`: the five baseline measurements, read-only.
- `seller_config.py`: seller, AE books, allowed proof and competitors from a private JSON file (synthetic defaults otherwise).

**Backups**
- `backup_check.py`: checks last night's in-database backup.
- `offsite_drive.py`: copies the encrypted backup to Google Drive, keeps 14.
- `offsite_certs.py`: which certificates an encrypted backup must open for.
- `db_backup.py`: manual `pg_dump` path (maintenance only).
- `restore_drill.py`: restore test against a backup (maintenance only).

**Tokens**
- `ari_db.py`: the worker's only database client (PostgREST, RPCs, gzip, retries).
- `ari_token.py`: client for the R7 token broker (off unless `ARI_WORKER_BROKER=1`).

**Deploy and repo**
- `deploy_web.py`: deploys `web/` to Vercel prod; refuses unless `--target=production --confirm` and the provenance gate passes.
- `deploy_provenance.py`: deploy only what is committed and reviewed.
- `deploy_app2_preview.py`: preview deploy of `app/web` on demo data.
- `git_export.py`: builds the scrubbed export (allow-list, scrub map, scans).
- `git_sync.sh`: the only way to commit and push (pull first, export, commit as the owner's noreply, push).
- `git_pull_remote.py`, `git_push_api.py`: pull and push through the GitHub API.
- `keel_repo.py` (+ `keel_repo.conf`): the repo name in one line.
- `repo_scan.py`: the leak scan CI also runs.
- `test_*.py`, `test_*.js`: unit tests for the scripts above (CI job `scripts`).

## Edge functions (`native/supabase/functions/`)
| Function | Status | Job |
|---|---|---|
| `ari-push` | live | sends web push (VAPID) for queued notifications |
| `ari-backup` | live | nightly dump of every table, auth users and migration history to a private bucket, restore test, encrypted copy |
| `ari-gmail-oauth` | live | connect Gmail, store the refresh token in Vault |
| `ari-gmail-ingest` | live | read LinkedIn notification emails every 10 min |
| `pending/ari-*` | prepared | the same four reading their own named secret keys (R7), no legacy service key |
| `pending/ari-worker-token` | prepared | R7 broker: 1-hour ES256 tokens for the worker |
| `pending/ari-gmail-push` | prepared | Gmail Pub/Sub push instead of polling |
| `pending/kyte-ai` (alias `pending/ari-ai`) | staging only | the AI layer: draft, rewrite, research, deep research, triage, chat, chat drafts, pipeline |
| `pending/_shared/ai` | staging only | providers, router, prompts, schemas, copy check, fact check, chat guard |
| `pending/check_no_legacy_keys.py` | CI | refuses a pending function that reads the legacy key |

## Migrations index (`native/supabase/migrations/`)
| # | What |
|---|---|
| 0001 | base schema (people, accounts, queue, log, threads, push, ...) |
| 0002, 0003 | push queue and wiring (pg_net, pg_cron, Vault) |
| 0004 | person context |
| 0005 | undo restores next action |
| 0006 | device pings |
| 0007 | scan heartbeat |
| 0008 | account stages and history, auto-advance |
| 0009 | reporting layer RPCs |
| 0010 | one-call Report dashboard, account health |
| 0011 | war room: briefs, quick check, sent messages |
| 0012 | brief ready push |
| 0013 | push diagnostics |
| 0014 | replies and Today's 15 |
| 0015 | generic lock-screen text for reply pushes |
| 0016 | default privileges locked, owner pinned |
| 0017 | anon loses push ack |
| 0018 | least-privilege `ari_worker` role |
| 0019 | app-change requests closed at write time |
| 0020, 0021 | generic SQL functions dropped |
| 0022 | nightly backup inside Supabase |
| 0023 | meeting source attribution |
| 0024 | second factor for the owner once enrolled |
| 0025 | encrypted offsite copy |
| 0026 | health alerts inside Supabase |
| 0027 | phase 0 metrics plumbing |
| 0028 | exact event times |
| 0029 | data hygiene checks |
| 0030 | Gmail read in shadow mode |
| 0031 | draft tags, draft edits, re-scan push |
| 0032 | accept ingest and scan dead-man switch |
| 0033 to 0035 (`pending/`) | workspaces, backfill, dual RLS (live) |
| 0036 | log repair RPCs (applied by hand, dropped by 0038) |
| 0037, 0038 | members need a second factor; S1 release 6 (live) |
| 0039 | reserved, never written |
| 0040 | R7 token broker guardrails (not applied) |
| 0041 | AI layer tables and RPCs (live, budget off) |
| 0042, 0043 | security hardening, definer caller checks (live) |
| 0044 | typed event labels (not applied) |
| 0045 | pair visibility (live) |
| 0046 | draft assumptions column (live) |
| 0047 | AI pipeline jobs and fact-check cache (not applied, known bugs) |
| 0048 | push digest equals Today's move total (not applied) |
| 0049 | live Ask Kyte chat (not applied) |
| 0050 | decline line in the app-change trigger (not applied) |
| 0051 | drafting in chat (not applied) |
| 0052 | scan controls (not applied) |

Every pending migration has a `_rollback.sql` and a `test/checks_after_<n>.sql`. Older ones have rollbacks in `native/supabase/rollbacks/`. `native/supabase/RESTORE.md` is the restore runbook.

## AI layer
- Routing (decided Oct 23 2026): all drafting on Opus, classification on Haiku, quick research on Sonnet with web search, deep research = Opus orchestrating Grok search. OpenAI adapter exists as an unrouted stub.
- Every draft comes back as `{text, rationale, source_facts[], confidence, needs_review}` and passes the same house-style gate as the scripts.
- Fact check through Parallel, with a name filter so person names never leave, and a safe-terms list for vendor, state and agency words.
- Cost: staging runs cost $0.14 to $0.17 for a full contact; chat about $0.007 an answer.
- `ai_budget` kill switch plus daily and monthly caps; the Anthropic workspace itself had a $30 monthly limit.

## Copy system
- **Point-first DMs.** Every DM: the point as a statement (their workflow + the exact data + where it bites), what we do in under 10 words, optional one short proof, one closed ask. DM1 under 45 words, DM2 under 40, DM3 under 35. DM1 opens "Thanks for connecting, <First>." or "<First>, quick one." DM2 opens "<First>, following up on <the DM1 point>." DM3 opens "<First>, last one from me on <the point>."
- **Pick plus switch.** Every draft is Ari's pick plus one alternative under the same rules. The SDR can switch with one tap; the switch is logged, not learned from as an edit.
- **`copy_check.py` gates:** G1 banned phrases and leftover placeholders; G2 customer naming rules per AE style; G3 no trigger line without a dated hook on file; G4 one closed ask; G5 length; G6 shape (openers, closers, connect note rules); G7 never explain how it works; G8 name the concrete data; G9 no question before the ask; G10 no hovering lines ("curious", "Most <peers> we talk to"); G11 follow-ups reuse a concrete word from what was sent; G12 list unsourced facts (opt-in). FLAG means redraft, up to 2 times; a draft that still fails is marked Flagged and never shown as the pick.
- **DM2 A/B.** Per person, by id hash: a "seen" arm (a real dated item) or a "reason" arm (a new consequence).
- **Learning loop.** Tags on every draft, every edit kept with its diff, a weekly copy read planned (Copy Lab). The living playbook part never got far.
- **Exec notes.** Separate shape: "Hi <First>, hope all is well." + one trigger or tension sentence + "We spend all day on that same tension." + "Free for 20 minutes next week?" Under 300 characters.
- Rules files that were private (they named real people and customers): `plans/copy-lab/ae-styles.md` and the seller skill. Templates in [config/](config/).

## Design system and character
- **Character.** Ari started as a pebble with eyes, brows, a mouth and a listening ring, nine states, tricks. Cut to three faces (calm, working, done) on Oct 16, then replaced by the Kyte mark (a folded kite K) on Oct 28 to 29. Voice: full sentences, dry, warm, plain; no exclamation marks, no emoji, bad news first.
- **Motion.** One token object (springs, durations, easings), transform and opacity only, reduced motion respected, a kite loader with a thread paying out.
- **Themes.** Many came and went. At the end: a light "Editorial" theme in the seller's ink colour with Kyte indigo, and a true black theme, following the phone.
- **Type.** A 5-size scale (13/16/19/23/34), 4/8 spacing, 44 to 48 px tap targets.
- **Rules.** Calm urgency (no red except real errors, no streaks), plain-language labels (First message, Follow-up, Last note, Invite), no commentary in the UI.
- Specs: `docs/specs/01_ui_interaction_cheatsheet.md` (md5-locked) and `07_s2_visual_spec.md`. Both still say Ari; read it as Kyte.

## CI and review (`.github/workflows/`)
- `ci.yml`: commit titles, web (typecheck, unit, build), jobs, drafts-eval, sql, sql-prod-shape (baseline + every pending migration applied, checked, rolled back twice), functions (deno check and tests), scripts (python unit), anti-slop-static, design-lint, e2e, failure-report (posts failed logs to an issue).
- `repo-scan.yml`: the leak scan on every push.
- `claude-review.yml`: automatic Claude review issue on risky pushes (PASS, FIX, BLOCK). Disabled Nov 3 2026.
- `claude.yml`: `@claude` in an issue runs Claude Code on a `claude/*` branch. Disabled Nov 3 2026.
- Review rules: `docs/engineering/REVIEW.md`; backlog of low findings: `docs/engineering/review-lows.md`; commit titles "Area: what changes": `docs/engineering/commit-convention.md`.

## Security model
- Data stays in the database and the private workspace; the repo is an allow-listed, scrubbed export with a name scan and a CI leak scan.
- Owner-only RLS, a pinned owner id, members need a second factor, new objects closed to `anon` and `authenticated` by default.
- The worker runs as `ari_worker` with explicit grants and no SQL. Generic SQL functions were dropped in 0020/0021.
- Edge functions check a Vault hook secret or a one-time ticket. Secrets live in Vault and function secrets, never in code.
- Deploys need an explicit flag and a provenance check; the frozen file needs a written reason and an md5 update.
- Backups encrypted to two certificates, restore-tested nightly, second vendor copy.
- Prompt injection: chat text, emails, pages and model output are data. The chat declines anything about its own build.
- What it lacked: R7 short-lived worker tokens, leaked-password protection, `search_path` pinned on 13 older functions, `pg_net` out of `public`.
