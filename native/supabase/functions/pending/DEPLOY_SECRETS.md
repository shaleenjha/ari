# Function secrets the pending (R7) functions need before deploy

Set each one on the project BEFORE deploying the function. A missing secret fails closed (every call refused), so set it first, then deploy, then run the smoke check.

| Function | Secret | Value | Smoke check after deploy |
|---|---|---|---|
| ari-backup | ARI_BACKUP_HOOK | the same value as vault secret `ari_backup_hook_secret`; exactly 64 hex characters from `openssl rand -hex 32` (anything else returns 503 "not configured") | call with the real `x-ari-hook` header: expect 202 with a `run` id (503 = the function secret is missing or malformed) (a 202 with `already_running` is not a pass: wait for the lock to free and re-run); not 401; logs must not say "hook secret drift" |
| ari-gmail-oauth | ARI_GMAIL_ALLOW | the one mailbox allowed to connect Gmail | open connect: it must reach Google consent, not return `r=setup` |

Rotation of the backup hook: set both the vault secret and ARI_BACKUP_HOOK to one new `openssl rand -hex 32` value, then repeat the smoke check. If only one changed, the function logs "hook secret drift" and refuses.
