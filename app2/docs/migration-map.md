# Prod → app2 table map and expand/contract plan (NOT applied)

Written Oct 17 2026 (Phase 1 groundwork). Source of truth for prod shape: schema-only restore of the Oct 16 23:27Z dump + migrations 0001–0028 (+ pending 0029). app2 schema: `app2/db/migrations/0001_tenancy_core.sql`, `0002_task_commands.sql`.

**Rules.** Expand/contract only. The live app (`web/ops.html`) keeps working at every step. Every step has a rollback. Staging first, then prod, in a maintenance window with a fresh short-lived token. Backfills run inside migrations, never as one-off scripts. One workspace ("Owner") gets every existing row; `workspace_id` is the constant id of that workspace.

## 1. Table map
| Prod (public) | app2 (app) | Notes / transform |
|---|---|---|
| `accounts` | `accounts` | `company`→`name`; `stage` text → `account_stage_t` via `ari_stage_norm` (snake_case); `stage_override`→`stage_pinned`; `stage_source` shal→user; `owner`/`ae` text → `account_team` rows (AE membership) once AEs are members, until then `accounts.flags` keeps `ae:<first name>`; meeting_* → `meeting_status/source/at` (`meeting_source` already normalised by 0023; `meeting_date` text parsed, unparseable → null + flag); `play` name → `play_id`; `field_ts` dropped (per-field merge moves to command RPCs). |
| `people` | `people` | text id `PA0001` kept in `flags` as `legacy:PA0001` for one release, new uuid PK; `name`→`full_name`; event timestamps → `*_at`; `ts_approx` kept; `stage` → `person_stage_t` (DM1 ready/DM2 drafted collapse into dm-draft presence, Hold/Personal → `hold`/`review=personal`); `lane` dropped (Founder cut); `dm/dm2_text/dm3_text` → `drafts` rows; `research`, `why_this_person`, `context` kept; `skipped`→`skipped_on`; `company` text dropped once `account_id` is set (0029 findings must be clean first); `sheet_row` dropped. |
| `account_briefs` | `account_briefs` | thesis/why_now/data_flow/committee/angle/soft_angles/sequences → `body` jsonb; `quick_check`, `check_via` kept; `status` mapped; `company` dropped. Creates a `brief` task per account. |
| `account_stage_history` | `activity` (verb `stage_changed`, subject account) | `undo_of/undone_at` kept in payload. |
| `copy_guidance` | `memory_items` (kind `style_rule`, subject `user` or `account`) + `draft_revisions` (before/after) | edit-distance metric reads `draft_revisions`. |
| `sent_messages` | `sent_messages` | `original_body/edited_at` → payload on a `draft_revisions` row. |
| `replies` | `replies` + `ingest_events` (kind reply) | `gmail_id`→`ingest_events.source_msg_id`; `matched_by`→`match_method`; `drafts` → `drafts(kind='reply')`. |
| `research` | `research` | `summary`→`body`, `dated` into body, `confidence` null (unknown). |
| `queue` | `tasks` (kind `map_account`/`research`/`ask`/`custom`) | status mapped; App-change rows are NOT migrated (0019 rule). |
| `tasks`, `task_events` (prod: worker step progress) | `jobs` (+ `task_events` only where a human-facing task exists) | name clash: prod `tasks` are job-progress rows, app2 `tasks` are the shared task graph. Map to `jobs.result`/`status`. |
| `threads`, `messages`, `attachments` | `tasks` kind `custom` with comments in `task_events` (Ask Hark requests) | chat is cut as chat (product.md); only open requests migrate. Attachments: storage path kept in payload. |
| `notifications` | `notifications` | gains `user_id` (owner) and `workspace_id`; `dedupe_key` kept. |
| `push_subscriptions`, `push_tokens` | `devices` | kind webpush/expo; `p256dh/auth` → `keys`; revoked rows not migrated. |
| `ops` | `command_log` | `op_id` kept; only last 30 days migrate. |
| `events` (hash chain) | `activity` | `prev_hash/hash` kept in payload for audit continuity; chain verified before copy. |
| `log_entries` | `metric_facts` + `activity` | dedupe on (`person_id`, `event`). |
| `app_usage` | `usage_days` | per user. |
| `plays` | `plays` | name → uuid id. |
| `book` | `accounts` with `stage='target'` and `flags` `book:<tier>` | 1,100 AE-book rows: import only rows the user works (stage ≠ target or has people); the rest stay a lookup table `book_entries` (Phase 2, deferred). |
| `targets` | `workspaces.settings.targets` | |
| `ari_prefs`, `app_config`, `brief`, `sync_state` | `workspaces.settings` / per-user prefs | `sync_state` dropped with the Sheet. |
| `decisions`, `ari_notes` | `tasks` kind `ask` assigned to the SDR (Ari proposals) | |
| `emails` | not migrated (email tracks deferred; Wren owns email) | archived in the final dump. |
| `scan_heartbeat` | replaced by `jobs` health (queue depth, oldest ready) | |
| `backup_runs` | stays platform-side (not tenant data); no `workspace_id` | |
| `hygiene_findings` (0029) | `hygiene_findings` | entity ids remapped to uuids. |
| `app_changes` | not migrated (app changes happen in Hark only) | |
| views `rpt_people/rpt_accounts/rpt_events/weekly_metrics` | Report RPCs over `metric_facts` | rebuilt, not copied. |

## 2. Expand / contract sequence (each step reversible)
1. **E1 tenancy (prod, additive).** Create `workspaces`, `memberships`; insert workspace "Owner" + owner membership. Add nullable `workspace_id uuid default '<shal ws>'` to every public table. App unaffected. *Rollback:* drop columns + tables.
2. **E2 backfill + constrain.** Inside the migration: `update … set workspace_id = '<shal ws>'`; `set not null`; add `(workspace_id, id)` unique indexes. *Rollback:* drop not null + indexes.
3. **E3 helpers + dual RLS.** Add `app.is_member/has_role`; policies become `is_owner() OR app.is_member(workspace_id)` (OR clause keeps the live app working). pgTAP/SQL matrix from `app2/db/tests` adapted to the prod table names runs on staging. *Rollback:* restore previous policies (saved in rollback file).
4. **E4 task graph.** Create `app.tasks/task_edges/task_events/activity` beside prod `tasks` (renamed `job_progress` view kept under the old name for the live app). Triggers on `people`/`queue` write graph tasks in parallel (shadow). *Rollback:* drop triggers + tables.
5. **E5 enums + typed columns.** New typed columns (`stage_t`) filled by trigger from the old text columns; old columns kept. *Rollback:* drop new columns.
6. **Switch reads** (app2 client at `/next`, behind a flag). ops.html stays on old columns.
7. **C1 contract.** After app2 parity and 2 weeks without ops.html use: drop `lane`, `sheet_row`, `field_ts`, text stages, Sheet sync tables; drop `is_owner()` OR clause; composite FKs replace single-column FKs. Final full dump before each contract step. *Rollback:* restore from that dump (contract steps are the only non-trivial rollbacks, hence last).

## 3. Preconditions
- 0029 hygiene findings reviewed in the app (people without account, duplicates) so `account_id` is trustworthy before `company` text is dropped.
- Restore drill green the same day as any contract step.
- Supabase's `postgres` role must keep BYPASSRLS for SECURITY DEFINER commands under FORCE RLS (true on current Supabase projects; checked in CI by running tests as a non-superuser owner — follow-up).
