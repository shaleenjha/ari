# Supabase edge functions (prod project rbkrqlzlblquvgmuohro)

Source of the four live edge functions, brought into the repo in S1 R2 (Oct 19 2026, Claude Supabase audit S4).
Read-only: nothing here was deployed or changed. Deploying a function is a separate, Owner-approved step.

## Live versions and how they were checked
Listed with `GET /v1/projects/rbkrqlzlblquvgmuohro/functions` and each live bundle fetched with
`GET .../functions/<slug>/body` (read-only token), Oct 19 2026 about 13:20 IST. The live bundle is an ESZIP holding the
transpiled module (types stripped). Each `<slug>/index.ts` here was transpiled the same way and compared with the live
module after removing comments, whitespace, semicolons, parentheses and trailing commas: **all four are identical**.
So these files are what runs, apart from formatting and comments.

| Function | Live version | Last deployed (UTC) | Verify JWT | Env it reads |
|---|---|---|---|---|
| `ari-push` | 7 | 2026-10-16 23:22 | off | SUPABASE_URL, **SUPABASE_SERVICE_ROLE_KEY**, EXPO_ACCESS_TOKEN |
| `ari-backup` | 3 | 2026-10-16 23:10 | off | SUPABASE_URL, **SUPABASE_SERVICE_ROLE_KEY**, SUPABASE_DB_URL, OFFSITE_CERT_PEM, STAGING_URL, STAGING_SECRET_KEY |
| `ari-gmail-oauth` | 3 | 2026-10-17 09:27 | off | SUPABASE_URL, **SUPABASE_SERVICE_ROLE_KEY**, ARI_GMAIL_CLIENT_ID, ARI_GMAIL_CLIENT_SECRET |
| `ari-gmail-ingest` | 2 | 2026-10-17 03:12 | off | SUPABASE_URL, **SUPABASE_SERVICE_ROLE_KEY**, ARI_GMAIL_CLIENT_ID, ARI_GMAIL_CLIENT_SECRET |

- All four read the legacy `SUPABASE_SERVICE_ROLE_KEY`. Revoking the legacy keys (S1 release 7) needs each one moved to a
  new secret key first, or it breaks push, the nightly backup and Gmail ingest.
- `ari-backup` also bundles `npm:postgres@3.4.4` and `pkijs` (esm.sh) for the CMS encryption.
- No secret values are in these files: every key comes from the function's environment.
- Verify JWT is off on all four; each checks its own caller (hook secret header or one-time ticket) inside the code.

## Prepared, not deployed
- `pending/ari-backup/index.ts` (S1 R3, Oct 19 2026): `ari-backup` encrypting the nightly `.cms` to BOTH recipient
  certificates (the Hark vault key and Owner's own, `native/supabase/offsite/ari-offsite-recipient*.pem`). Only
  `cmsEncrypt` and the built-in certificate bundle change. Round trip checked with pkijs 3.2.4 and two throwaway P-384
  certificates: openssl decrypts with either key, and `scripts/offsite_certs.py` sees exactly two recipients. Ships with the
  next edge release (staging first); afterwards move it over `ari-backup/index.ts` and drop Owner's cert from
  `PENDING_IN_FUNCTION` in `scripts/backup_check.py`.
  Also (Claude R-03, Oct 19 2026): the plaintext copy to ari-staging is removed (`STAGING_URL` / `STAGING_SECRET_KEY` are no
  longer read; `backup_runs.offsite` is always false), and `OFFSITE_CERT_PEM` is honoured only on the staging
  project (`ljojwhnfgfreokqspobg.supabase.co`, allowlist, issue #4 follow-up); prod, a custom domain, an unparseable or
  missing URL all get the built-in two-recipient bundle. After the deploy, delete the two
  STAGING_* function secrets and the old plaintext objects in ari-staging's ari-backups bucket.

## S1 R7 (prepared Oct 21 2026, not deployed)
- `pending/ari-push`, `pending/ari-gmail-oauth`, `pending/ari-gmail-ingest`, `pending/ari-backup`: each reads its OWN named
  secret key (`ari_push`, `ari_gmail_oauth`, `ari_gmail_ingest`, `ari_backup`) through `secretKey()` and sends it as `apikey`
  only (an `sb_secret_` key is not a JWT). No fallback to `SUPABASE_SERVICE_ROLE_KEY`: a missing key fails closed.
  `secretKey()` reads `SUPABASE_SECRET_KEYS` (JSON name -> key) or the function secret `ARI_SK_<NAME>`.
- `pending/ari-worker-token`: the worker's token broker (design D). Verify JWT off; called only on
  `https://<ref>.functions.supabase.co/ari-worker-token` with header `x-ari-worker-caller`. Env: `ARI_WORKER_CALLER_SECRET`,
  `ARI_WORKER_EMAIL`, `ARI_WORKER_PASSWORD`, `ARI_WORKER_UID`, named key `ari_worker_token`, kill switch `ARI_BROKER_DISABLED=1`.
  Gate and mint log in migration `pending/0040_s1_release7_broker.sql`. Offline tests: `deno test --allow-env pending/ari-worker-token/`.
- `pending/check_no_legacy_keys.py` (CI) refuses a pending function that reads the legacy key or sends a Bearer secret key.
- Order and undo: `work/r7/runbook.md` (not in the repo). After each prod deploy, move the pending file over the live one.
