# Code names: Kyte, Ari and the legacy `ari` identifiers

The product is **Kyte**. **Ari** is its code name from before Oct 29 2026. Kelvarrow by Thrandvex was the user-facing name
from v18.13.5 to v18.14.1. Since v18.14.2 the web app says Kyte everywhere a person can see.

Rule (naming plan A+, Owner delegated, Oct 30 2026):
- Docs, plans, script comments, file names and all **new** code say Kyte.
- Anything a live system depends on keeps its `ari` name. Renaming it would break prod, lose data on phones, or need a
  migration with no user-visible gain. That covers the prod web app, the prod worker and its scheduled task, the database,
  the deployed edge functions, secrets, the Supabase and Vercel projects, and the GitHub repo until Owner renames it.
- Kyte's chat never says Ari, Den, Hark, Kelvarrow or any vendor name to the user. That rule is about what Kyte says, not
  about identifiers (see `native/supabase/functions/pending/_shared/ai/chat_guard.ts`).

When you add something new, name it `kyte` / `kyte_` / `Kyte`. Rename a legacy name only with an expand/contract plan
that keeps the old name working until every caller has moved.

## Legacy names kept, and why

### Database (prod `rbkrqlzlblquvgmuohro`, staging `ljojwhnfgfreokqspobg`)
| Kept | Why |
|---|---|
| Role `ari_worker` | The prod worker signs in as it. Grants, RLS policies and the broker (`ari-worker-token`) name it. |
| Functions `ari_*` (`ari_notify`, `ari_pref`, `ari_push_ack`, `ari_worker_*`, `ari_ai_*`, `ari_pipeline_*`, `ari_move_total`, ...) | Called by the live web app, the worker scripts, cron jobs and edge functions. Renaming one is a migration plus a client deploy. |
| Cron job names `ari-*` (`ari-nightly-backup`, `ari-push-retry`, `ari-health-alert`, `ari-due-digest`, `ari-weekly-digest`, `ari-rowcount-daily`, `ari-session-expiry`, `ari-gmail-ingest`, `ari-gmail-shadow-*`, `ari-broker-mints-prune`, `ari-pipeline`, `ari-ai-events`, `ari-ai-prune`, `ari-ai-chat-prune`, `ari-ai-chat-draft-prune`, `ari-gmail-watch-renew`) | Migrations unschedule and reschedule them by name, and rollbacks and checks look them up by name. |
| Vault secrets `ari_ai_hook_secret` and the other `ari_*` secret names; app_config keys | Read by name in SQL and in edge functions. |
| Session setting `ari.actor` | Audit triggers read it. |
| Data values `updated_by = 'ari-ai'`, log event `'Ari edit switch'`, the notes marker `Ari's pick (dmN):` | Stored rows. Code matches these exact strings (0047 never overwrites a worker brief unless `updated_by = 'ari-ai'`; `copy_switch.py`, `ingest_labels.py` and the app parse the other two). |
| Table names | Tables are mostly unprefixed (`people`, `accounts`, ...). The few `ari_*` ones (`ari_notes`, ...) stay for the same reason as functions. |

### Edge functions (Supabase slugs)
| Kept | Why |
|---|---|
| `ari-backup`, `ari-push`, `ari-gmail-ingest`, `ari-gmail-oauth` | Deployed on prod. Cron jobs, the service worker and Google's OAuth redirect URI call these slugs. |
| `ari-gmail-push`, `ari-worker-token` | Pending. Their slugs are in pending migrations and in the Pub/Sub and broker setup docs. |
| `ari-ai` (legacy alias of `kyte-ai`) | Staging runs it, and the database kicks (`ari_ai_kick` in 0041, the pipeline kick in 0047) plus `ari-gmail-push` call `/functions/v1/ari-ai`. The AI function is now `pending/kyte-ai/` (slug `kyte-ai`). `pending/ari-ai/index.ts` is a three-line alias that serves the same `main.ts` under the old slug, and each deployment kicks only itself. On staging, keep `ari-ai` deployed. On prod, deploy both slugs at rollout, or first add a migration that repoints `ari_ai_kick` and the 0047 kick (plus a one-line `ari-gmail-push` change) to `kyte-ai`, then undeploy `ari-ai` and delete the alias folder. |
| Named API keys `ari_ai`, `ari_gmail_push`, `ari_worker_token`; env `ARI_*` (`ARI_SK_*`, `ARI_PUBLISHABLE_KEY`, `ARI_APP_ORIGINS`, `ARI_GMAIL_*`, `ARI_WORKER_*`, `ARI_BACKUP_HOOK`, `ARI_BROKER_*`, `ARI_STYLE_B_AE`) | Set as secrets on the deployed projects. A rename means re-setting secrets on prod. |
| Headers `x-ari-hook`, `x-ari-worker` | Shared between SQL (pg_net), the worker and the functions. Both sides would have to change at once. |

### Web app (prod, frozen under `plans/base-lock.json`)
| Kept | Why |
|---|---|
| `web/ops.html` internal ids, globals (`ariV1812`, `ARI_SVG`, `ARI_MEM`, ...), routes | Frozen file. Only data-loss or security fixes may change it. |
| localStorage keys `ari-*` (`ari-theme`, `ari-font`, `ari-install-id`, `ari-push-ok`, `ari-ui5`, `ari-t4`, ...) | Renaming them would reset every phone's settings and install id. |
| Service-worker caches `ari-v<version>`, `ari-logos-1`, `ari-acks` | A new prefix would orphan the old caches. The version bump already replaces the shell. |
| Files `web/ari.webmanifest`, `web/ari-supabase.js`, `web/ari-fonts.css`, `web/ari-*.woff2`, `web/ari-*.png` | The live app and installed home-screen apps load these paths. The manifest content already says Kyte. |
| `app/web/public/brand/ari-mark-*` | Asset paths in the app2 build. They can be renamed with the app2 brand pass. |

### Worker and scripts (prod worker task)
| Kept | Why |
|---|---|
| `scripts/ari_db.py`, `scripts/ari_token.py`, `scripts/test_ari_token.py` | The worker prompt and most scripts import or call these paths. New modules use `kyte_`; a rename needs a shim first. |
| Worker output copy: calendar titles `Ari · Replies / Follow-ups / Connects` (`focus_blocks.py`), push text "Open Ari to answer" (`reply_ingest.py`), daily report lines (`daily_report.py`), alerts "ALERT: Ari ..." | These are prod worker behaviour, and changing them changes what Owner sees. Switch them to Kyte in a worker change he approves. They are left on purpose in the naming commit. |
| Drive folder "Ari backups", backup files `ari_*.json.gz.cms`, certs `native/supabase/offsite/ari-offsite-recipient*.pem` (subjects "Ari offsite backup recipient", "Ari backup - Owner") | Real names on Google Drive and inside issued certificates. The nightly backup and the restore drill look them up. |
| Vault entries "Anthropic API key (Ari)", Anthropic workspace "Ari" | Real names in Hark's vault and the Anthropic console. |

### Infrastructure and repo
| Kept | Why |
|---|---|
| Supabase project name `ari` | A dashboard label. The ref is what code uses. |
| Vercel project `ari-web` | The prod URL. |
| GitHub repo `shaleenjha/ari` | Owner renames it himself. After he does, change the one line in `scripts/keel_repo.conf` to the new `owner/repo` and commit it. `git_push_api.py`, `git_pull_remote.py` and `deploy_provenance.py` all read it, and `PUBLIC_OK` already allows `shaleenjha/kyte`. GitHub redirects old URLs, but the push uses API POSTs, which do not follow redirects, so the conf line must change. |
| Export tree `work/keel/ari-app`, `KEEL_*` env | Private working paths, not part of the product. |
| `ARI_BASE_FIX` (deploy_web.py) | An operator switch named in every base-lock record. |
| Design specs `docs/specs/01_ui_interaction_cheatsheet.md` and `07_s2_visual_spec.md` still say Ari | Spec 01 is locked by md5 in `plans/base-lock.json` and changes need Owner's approval, so both design specs were left as they are. Read Ari there as Kyte. |
| Quoted UI copy in docs (for example "Can't reach Ari right now." in app/docs) | These quote strings the code shows. They change when that copy changes. |

## Renamed to Kyte
- Doc prose: README, REPO_MAP, privacy inventory, RELEASES, spec 09, RESTORE, functions README, app docs, `plans/builder-sheet.md`.
- Script header comments (no code or output change), and the Claude review prompt.
- The repo name now lives in one line (`scripts/keel_repo.conf`, read by `scripts/keel_repo.py`).
- Pending AI edge function: `pending/ari-ai/` is now `pending/kyte-ai/` (code in `main.ts`, entry `index.ts`), with `pending/ari-ai/index.ts` as the legacy alias. `kyte-ai/alias_test.ts` pins that.
