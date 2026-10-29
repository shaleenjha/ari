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

## Live AI layer (prepared Oct 23 2026, code only, NOT deployed; depends on S1 R7)
Branch `live/ai-layer`. Nothing here is deployed, no migration is applied, no secret is set. Draft, not approved (plans/motions-proposal.md "Live layer").
- `pending/_shared/ai/`: provider layer. Routing (Owner, Oct 23 2026 15:11 IST): ALL drafting on `claude-opus-5-5` (DM1/2/3,
  rewrites, reply drafts; future motion drafts and connect notes must use the `draft` route); `claude-haiku-5-5` for
  classification only (accept match, reply intent); `claude-sonnet-5-5` + Anthropic web search for quick research; deep research
  = `claude-opus-5-5` orchestrating in a tool loop with `grok_search` (Grok `grok-4.7`, `x_search` or `web_search` per call) for
  fresh signals. OpenAI adapter is an unrouted backup stub. Routing table and placeholder prices in `router.ts`; zod-style output
  schemas in `schema.ts` (draft = `{text, rationale, source_facts[], confidence, needs_review}`); one transport (`http.ts`) with a
  host allowlist (LinkedIn refused), per-attempt timeout and exactly one retry (429 / 5xx / network); SSE streaming for draft and
  rewrite; Quill house-style gate (`style.ts`, verbatim copy of app/jobs/src/draft-eval/style.ts) forces `needs_review`.
  Keys only from env `ANTHROPIC_API_KEY` / `XAI_API_KEY` (`OPENAI_API_KEY` optional), never logged or returned.
- `pending/ari-ai/`: one owner-only endpoint (app session; owner check runs in the database as the user via `ari_ai_caller()`
  so the aal2 rule applies). Actions: `rewrite`, `draft_dm1`, `quick_research`, `deep_research` (async `ai_jobs` row; LIVE feed in
  `ai_jobs.steps`: one event per search query `{type: query, source, query}`, per url / post read `{type: read, url, title,
  domain}`, per finding as it lands `{type: finding, fact, source_url, domain}`, plus status / error; each with `seq` and `at`),
  `job_stream` (SSE relay of that feed by seq, `progress` events then `done`; realtime on `ai_jobs` works too), `triage_reply`
  (Haiku classifies intent, Opus drafts book / answer / soft). Internal `x-ari-hook`
  calls: `process` (event path + stale jobs), `run_job`. Writes only through an RPC allowlist (`db.ts`): DM slots, reply drafts,
  research rows, `ai_*` tables, generic pushes. No send path, no config endpoint, errors carry no infrastructure words.
- `pending/ari-gmail-push/`: Pub/Sub push target. Verifies Google's OIDC token (RS256, audience, push service account, expiry),
  acks 204 at once, then runs `ari-gmail-ingest` immediately and `ari-ai {internal: process}`: classify (Haiku confirms the
  accept and the person; must agree with the deterministic vanity / name match) -> draft_dm1 (Opus, `draft` route; only into an empty DM slot
  or over Ari's own unedited text) -> `ari_notify('draft_due', 'draft:dm1:ai:<person>')` = generic "DM1 ready" push.
  Daily watch renewal via cron. The manual "Accepted" tap calls `ari-ai {action: draft_dm1, person_id, source: accepted_tap}`.
- Idempotency: `ai_triggers` (accept by Gmail msg id, dm1 by person id) claimed in the database before any model call; ingest
  already dedupes by msg id; pushes dedupe by key. The 10-minute cron (`ari-ai-events`) is the fallback and also picks up
  manual accepts and stale deep-research jobs. The Hark 10-min worker keeps running unchanged as the outer fallback.
- Migration `../migrations/pending/0041_ai_layer.sql` (+ `_rollback`), tested by `../migrations/pending/test/checks_after_0041.sql`
  in `run_local.sh` (CI sql-prod-shape). Staging/prod-safe check (one statement, deliberate raise): `../migrations/pending/test/checks_after_0041_staging.sql`.
  Oct 28 2026: rehearsed locally in staging's real order (0041 after 0045/0046): applies, checks pass, rollback x2 clean, 0045/0046 checks unaffected.
  Staging deploy plan: work/ai-layer/staging_deploy_plan.md (not in the repo). Spend guard: `ai_budget` (OFF by default, $50 / month, $5 / day), worst-case
  reservation under an advisory lock before every call, real cost booked after; refusals logged; one generic alert per cap.
- Offline tests: `deno test --allow-env --allow-read pending/_shared/ai/ai_test.ts pending/ari-ai/ari_ai_test.ts
  pending/ari-gmail-push/push_test.ts` (list the files explicitly; directory discovery missed two of them here).
  CI needs one change on main (branch pushes may not edit `.github/`), in the `functions` job:
  `deno check native/supabase/functions/pending/ari-ai/index.ts native/supabase/functions/pending/ari-gmail-push/index.ts` and
  `deno test --allow-env --allow-read <the three test files>`.

### Gmail push (Pub/Sub) setup, after deploy (Google Cloud project that owns the ARI_GMAIL_CLIENT_ID OAuth client)
1. Enable the Pub/Sub API. `gcloud pubsub topics create ari-gmail-push`
2. Let Gmail publish (Google's fixed Gmail push publisher, domain `system.gserviceaccount.com`): `GSA_DOMAIN=system.gserviceaccount.com; gcloud pubsub topics add-iam-policy-binding ari-gmail-push --member="serviceAccount:gmail-api-push@$GSA_DOMAIN" --role=roles/pubsub.publisher`
3. Push identity: `gcloud iam service-accounts create ari-gmail-push-invoker` (no roles needed). If the project predates
   Apr 2021, also grant the Pub/Sub service agent `roles/iam.serviceAccountTokenCreator` on that service account.
4. Push subscription to the function URL with an OIDC token:
   `gcloud pubsub subscriptions create ari-gmail-push-sub --topic=ari-gmail-push --push-endpoint=https://<ref>.supabase.co/functions/v1/ari-gmail-push --push-auth-service-account=ari-gmail-push-invoker@<gcp-project>.iam.gserviceaccount.com --push-auth-token-audience=https://<ref>.supabase.co/functions/v1/ari-gmail-push --ack-deadline=30 --message-retention-duration=1h --expiration-period=never`
5. Tell Ari (SQL, Owner's go): `insert into app_config(key, value) values ('gmail_watch_topic', 'projects/<gcp-project>/topics/ari-gmail-push'), ('gmail_push_audience', 'https://<ref>.supabase.co/functions/v1/ari-gmail-push'), ('gmail_push_sa', 'ari-gmail-push-invoker@<gcp-project>.iam.gserviceaccount.com') on conflict (key) do update set value = excluded.value;`
6. First watch: `select public.ari_gmail_watch_kick();` then check `gmail_watch.expires_at` is about 7 days out. Renewal:
   pg_cron `ari-gmail-watch-renew` daily 01:45 IST (a watch lasts 7 days, so a missed day or two is harmless).
   The watch covers label INBOX (LinkedIn mail in the Social tab still carries INBOX); mail a filter skips the inbox for is
   caught by the 10-minute fallback.
7. Off switch: `gcloud pubsub subscriptions delete ari-gmail-push-sub` (the watch lapses in 7 days); everything AI stops at once with
   `update ai_budget set enabled = false`.

## ari-push copy (Oct 29 2026, prepared, NOT deployed)
`ari-push/index.ts` and `pending/ari-push/index.ts`: the summary words for batches of 4+ say Kyte and the app's labels
("5 first messages ready", "Their first messages are drafted in Kyte.") instead of "DM1s ready ... in Ari". Copy only; transport,
auth and grouping unchanged. The web service worker (v18.14.7) already rewrites the old words on the phone, so this is not urgent.

