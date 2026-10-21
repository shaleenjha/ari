# Maintenance session (v18.7 batch) - one short-lived Supabase PAT, staging first

Hark requests a short-lived PAT from Owner through Hark Secured Login at the start, and Owner revokes it at the end.
Order: apply each step on **ari-staging** first, run its check, then on **prod (rbkrqlzlblquvgmuohro)**. Rollbacks sit next to each file.

| # | What | How | Check | Rollback |
|---|---|---|---|---|
| 1 | 0025_worker_read_backups.sql | SQL (Management API /database/query) | `cd work && python3 ../scripts/offsite_drive.py` (google ops-account) -> source "ari-backups" | 0025_rollback.sql |
| 2 | 0026_health_alerts.sql | SQL | `select public.ari_health_alert()` returns health JSON; `python3 scripts/health_check.py` uses rpc ari_worker_health; worker allow-list 29 -> 30 | 0026_rollback.sql |
| 3 | 0027_phase0_metrics.sql | SQL | `python3 scripts/phase0_metrics.py` fills metrics 3 to 5; app usage_ping 204 (owner) / 401 (anon) | 0027_rollback.sql |
| 4 | Redeploy edge functions ari-push and ari-backup (constant-time x-ari-hook compare, v18.7 source in functions/) | `supabase functions deploy ari-push --no-verify-jwt` and `ari-backup --no-verify-jwt` | wrong hook -> 401, right hook -> 202/200; next 03:00 IST backup verified | redeploy from git a851ef76 (v18.6) |
| 5 | Enforce SSL on DB connections | Management API `PUT /v1/projects/{ref}/ssl-enforcement {"requestedConfig":{"database":true}}` | GET shows database true; sync + backup still run | same call with false |
| 6 | Re-run restore drill | `python3 scripts/restore_drill.py` | 33+/33+ tables match | n/a |

Not touched on purpose: legacy JWT keys stay enabled (the worker JWT is signed with the legacy secret until it is re-minted, by 2027-04-01).
Already verified without a PAT (Oct 17 04:2x IST): /auth/v1/settings shows disable_signup=true and only Google enabled; anon signup -> 422.
is_owner() is pinned to the owner uid (+ aal2 once a factor is enrolled) and trusts no email claim, so the "email_verified default false" item is moot.

## Done Oct 17 2026, 04:35 to 05:10 IST (v18.7.1 maintenance session, PAT hark-maint-2026-10-17)
All applied staging first, rollback rehearsed on staging (0025, 0026, 0027, 0028 rollback + re-apply; SSL false + true), then prod.
Ledgers in step: both projects 0001..0028. Files moved to migrations/ (0025_offsite_encrypted replaced the worker-reads-backups
draft, kept as work/maint1017/*.REJECTED.sql), rollbacks in rollbacks/. Edge functions ari-push + ari-backup redeployed on both.
SSL enforcement on for both. Restore drill 34/34 tables, 2,316/2,316 rows. Nothing pending here.

## Pending for the NEXT maintenance window (added Oct 17 2026, Phase 1 groundwork; needs a fresh short-lived PAT)
| # | File | Kind | Check after | Rollback |
|---|---|---|---|---|
| 1 | 0029_data_hygiene.sql | SQL | run `native/supabase/tests/0029_data_hygiene_test.sql` on staging (self-contained transaction, rolls back) -> "ALL 0029 TESTS PASSED"; `python3 scripts/hygiene_scan.py` as ari_worker prints one hygiene line; worker allow-list 30 -> 32 (ari_hygiene_scan, ari_worker_hygiene); anon -> 401 on hygiene_open / hygiene_resolve | 0029_data_hygiene_rollback.sql |
| 2 | Add `python3 scripts/hygiene_scan.py` after the sync step in task 56e17ef1 | task prompt | next sync prints the hygiene line, exit 0 | remove the step |
| 3 | v18.8 front end "Tidy up" (work/v188_hygiene, spec plans/data-hygiene.md) | deploy | harness pass, then device check | redeploy v18.7.1 |
Tested Oct 17 on local Postgres 17 with the prod schema (schema-only restore, synthetic rows): apply, tests, rollback, re-apply, tests: all pass.

## Done Oct 17 2026, 06:05 to 06:40 IST (maintenance window #2, v18.8, PAT hark-maint-2026-10-17b)
- Fresh verified backup first: ari_20261017_0039Z.dump, restore-test 34/34 tables, 2,317/2,317 rows (only benign "role ari_worker does not exist" grant errors in the throwaway restore).
- 0029 on staging: applied, test file run inside one transaction (staging's own 2 synthetic people/accounts hidden in-transaction; the run ends in a deliberate raise so nothing persists) -> "ALL 0029 TESTS PASSED"; rollback, re-apply, tests pass again. Anon -> 401 on hygiene_open, hygiene_resolve, ari_hygiene_scan. Worker-executable public functions +2 (ari_hygiene_scan, ari_worker_hygiene; catalogue count 32 -> 34 including non-app helpers).
- 0029 on prod: applied, ledger 0001..0029 on both, 46 hand-set no_connect_tick flags removed by the backfill, anon 401 x3, worker +2. Files: migrations/0029_data_hygiene.sql, rollbacks/0029_rollback.sql.
- hygiene_scan.py added after the sync step in task 56e17ef1 (prompt only). First prod scan as ari_worker: 43 accept_no_connect, 42 no_account_link, 14 dm1_past_due, 0 duplicate_account, 0 stale_stage; rescan idempotent.
- v18.8 "Tidy up" deployed (frozen base web/ops_v1871.html); live /build.json v18.8. Device check owed (remote browsers stop at the passkey gate by design).
- After: worker 06:19 clean; scheduled sync 06:25 clean with the hygiene line, no ALERT; test ping delivered 3/3. Session helper using the token deleted. Nothing pending here.

## Done Oct 17 2026, 08:26 to 08:50 IST (v18.8.1 Gmail shadow, PAT bound as supabase-mgmt, approved by Owner 08:25 IST)
- 0030_gmail_shadow on staging: apply; tests/0030_gmail_shadow_test.sql in one transaction ending in a deliberate raise -> "ALL 0030 TESTS PASSED" (vanity, privileges, one-time ticket + state, allowlist, Vault round trip + update, idempotent record, forward-only cursor, diff counts 2 match / 1 time mismatch / 1 unmatched with no names in the report, alert on the 3rd failure only, needs_reconnect, kick refuses while not connected, people untouched). Rollback -> ledger 0029, 0 functions/tables/cron/Vault entries; re-apply; tests pass again. Staging app_config gmail_fn_base set to its own ref.
- Edge functions ari-gmail-oauth + ari-gmail-ingest deployed (verify_jwt off) on staging then prod: wrong/no hook -> 401; right hook (sent from SQL) -> 200 {"skipped":"disconnected"}; start without the OAuth client -> 503 "Not set up yet".
- Prod: 0030 applied, ledger 0030, 2 cron jobs (ari-gmail-ingest */10, ari-gmail-shadow-diff 19:00 UTC = 00:30 IST), status disconnected. Anon (publishable key) -> 403 on ari_gmail_status / connect_ticket / ingest_config / hook / disconnect and on gmail_shadow_events.
- Purely additive (new tables/functions only), so no pre-apply dump; next 03:00 IST backup picks the new tables up.
- Session helper work/maint_gmail.py (ARI_MAINT-gated) deleted at the end. NOT mine but found: work/sec_q.py (Oct 16) calls the Management API with no ARI_MAINT gate; it should be deleted.
- Pending: the Google OAuth client (blocked, see app2/docs/gmail-fetch.md §4) and the two function secrets on both projects.

## Done Oct 17 2026, 14:40 to 15:20 IST (v18.10.1, PAT hark-maint-2026-10-17c, 24 h, approved by Owner 14:38 IST)
- 0031_copy_tags_edits_rescan_push: local PG17 + staging apply / tests (ALL 0031 TESTS PASSED) / rollback / re-apply / tests, then prod (ledger 0031). Rollback rollbacks/0031_rollback.sql matches prod's pre-0031 function bodies.
- ari-gmail-oauth redeployed (v3) on staging then prod: browser outcomes redirect to /ops?gmail=...
- Helper work/maint_0031.py deleted; token revoked on supabase.com (list empty); api.supabase.com 401. Nothing pending here.

## Worker kill switch (S1 R7, Oct 21 2026; usable once migration 0040 is applied)
Stops every worker credential within a minute, the static token included: run `native/supabase/ops/r7_kill_switch_on.sql`
through the Management API query endpoint (Owner's short-lived PAT). It revokes `ari_worker` from `authenticator` (PostgREST
then refuses every ari_worker token), disables the broker gate, and bans the worker Auth user. Undo:
`native/supabase/ops/r7_kill_switch_off.sql`. If the broker itself is suspect, also set the function secret
`ARI_BROKER_DISABLED=1` on `ari-worker-token`. Worker-side emergency off without a PAT: `ARI_WORKER_BROKER=0` or delete
`work/state/ari_worker_broker.on` (falls back to the static token only while it still exists, i.e. before the revoke).
