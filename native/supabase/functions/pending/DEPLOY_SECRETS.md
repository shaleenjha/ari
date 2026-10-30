# Function secrets the pending (R7) functions need before deploy

Set each one on the project BEFORE deploying the function. A missing secret fails closed (every call refused), so set it first, then deploy, then run the smoke check.

| Function | Secret | Value | Smoke check after deploy |
|---|---|---|---|
| ari-backup | ARI_BACKUP_HOOK | the same value as vault secret `ari_backup_hook_secret`; exactly 64 hex characters from `openssl rand -hex 32` (anything else returns 503 "not configured") | call with the real `x-ari-hook` header: expect 202 with a `run` id (503 = the function secret is missing or malformed) (a 202 with `already_running` is not a pass: wait for the lock to free and re-run); not 401; logs must not say "hook secret drift" |
| ari-gmail-oauth | ARI_GMAIL_ALLOW | the one mailbox allowed to connect Gmail | open connect: it must reach Google consent, not return `r=setup` |

Rotation of the backup hook: set both the vault secret and ARI_BACKUP_HOOK to one new `openssl rand -hex 32` value, then repeat the smoke check. If only one changed, the function logs "hook secret drift" and refuses.

## Live AI layer (kyte-ai with its legacy alias ari-ai, ari-gmail-push), added Oct 28 2026; the ari-ai rows below apply to both slugs (same code, same secrets); staging first, plan in work/ai-layer/staging_deploy_plan.md
Both read their OWN named secret key through the built-in `SUPABASE_SECRET_KEYS` (create named keys `ari_ai` and
`ari_gmail_push`, type secret, before the deploy; a missing key = every call 500 before any work). No ARI_SK_* secret is
needed when the named key exists (proved on staging Oct 28 for the R7 functions). Migration 0041 must be applied first (RPCs,
vault `ari_ai_hook_secret`, kill switch `ai_budget.enabled = false`).

| Function | Secret | Value | Needed for |
|---|---|---|---|
| ari-ai | ANTHROPIC_API_KEY | vault "Anthropic API key (Ari)" (key ari-edge, Anthropic workspace Ari, $30 limit, expires 2027-01-31) | every model call; missing = that call fails closed |
| ari-ai | ARI_PUBLISHABLE_KEY | the project's publishable key (public) | only if `SUPABASE_PUBLISHABLE_KEYS` is not injected; harmless to set |
| ari-ai | ARI_APP_ORIGINS | comma list of browser origins allowed by CORS (default the prod app) | browser callers only; curl/server calls ignore CORS |
| ari-ai | XAI_API_KEY | not in the vault yet | deep_research only (Grok search); unset = deep research fails, the rest works |
| ari-ai | BRAVE_SEARCH_API_KEY | not in the vault yet | import_resolve LinkedIn waterfall step 1; unset = skipped (lemlist, then parked) |
| ari-ai | LEMLIST_API_KEY | vault "lemlist API key (ops-account)" | import_resolve waterfall step 2; unset = skipped |
| ari-gmail-push | ARI_GMAIL_CLIENT_ID, ARI_GMAIL_CLIENT_SECRET | same OAuth client as ari-gmail-ingest (already set on the project) | watch renewal only |

Smoke checks after deploy: `ari-ai` POST with no auth -> 401; with a wrong `x-ari-hook` -> 401; `{internal:"process"}` with the
real hook (from `ari_ai_hook()`, never printed) -> 202 and, while `ai_budget.enabled = false`, no model call (no `ai_calls` row with status ok).
`ari-gmail-push` GET -> 405; POST with no OIDC token -> 503 "not configured" until the three gmail_push app_config rows exist, then 401; renew_watch with the real hook -> `{ok:false, reason:"no_topic"}`
until `app_config.gmail_watch_topic` is set. Then `checks_after_0041_staging.sql` must reply "ALL 0041 STAGING CHECKS PASSED".
