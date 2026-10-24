# Function secrets the pending (R7) functions need before deploy

Set each one on the project BEFORE deploying the function. A missing secret fails closed (every call refused), so set it first, then deploy, then run the smoke check.

| Function | Secret | Value | Smoke check after deploy |
|---|---|---|---|
| ari-backup | ARI_BACKUP_HOOK | the same value as vault secret `ari_backup_hook_secret`; at least 32 random bytes (e.g. `openssl rand -hex 32`) | call with the real `x-ari-hook` header: expect 202, not 401; logs must not say "hook secret drift" |
| ari-gmail-oauth | ARI_GMAIL_ALLOW | the one mailbox allowed to connect Gmail | open connect: it must reach Google consent, not return `r=setup` |

Rotation of the backup hook: change the vault secret and ARI_BACKUP_HOOK together, then repeat the smoke check. If only one changed, the function logs "hook secret drift" and refuses.
