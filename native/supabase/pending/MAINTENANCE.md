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
