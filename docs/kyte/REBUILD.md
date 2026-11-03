# Rebuild Kyte from zero

The goal: plug things in and it works again. Follow the steps in order. Every secret here is named, never shown; templates with placeholders are in [config/](config/).

Time needed: about a day for the core (database, app, worker), plus a few hours for push, Gmail and backups. The AI layer is optional.

## 0. What you need on your machine
- Node 22 and npm (`app/web`, `app/jobs`)
- Python 3.12 (`scripts/`)
- Deno 2 (edge functions)
- PostgreSQL 17 client tools (`psql`, `pg_dump`) for migrations and SQL tests
- The `gws` CLI (Google Workspace) authenticated to the Google account that owns the Sheet, or swap the `gws` calls for the Google API client you prefer
- An agent scheduler that can run a prompt on a schedule with a shell in this repo. Kyte used Hark. Anything that can do "every 10 minutes, run this prompt, give it a shell and Google credentials" works.

## 1. Accounts to create

| Account | What for | Notes |
|---|---|---|
| GitHub | the repo, CI | fork or copy this repo; CI needs no secrets except the optional Claude review |
| Supabase | database, auth, realtime, edge functions, pg_cron, Vault, storage | make TWO projects: staging and prod. Every migration goes to staging first. Kyte ran in `ap-south-1` |
| Vercel | static hosting for `web/` | one project; the app lives at `/ops` |
| Google account (owner) | Sign in with Google, the Sheet, sending the daily report to yourself, Calendar | the one person allowed into the app |
| Google account (ops, optional) | the Drive folder for the encrypted backup copy | Kyte used a separate working account so backups never sat in the personal Drive |
| Google Cloud project | two OAuth clients (below) | free tier is fine |
| Anthropic (optional) | AI layer | set a monthly spend limit in the console; Kyte used $30 |
| Parallel (optional) | fact checks in the AI layer | |
| Apollo (optional) | people search for "Map account" | search views only, never spend credits |

### Google Cloud OAuth clients
1. **Sign-in client** (OAuth client ID, type Web application). Authorized JavaScript origin and redirect URI: your app origin (`https://<your-domain>` and `https://<your-domain>/`). Scopes: `openid email profile`. Put the client id into `web/ops.html` (`CLIENT_ID`, the repo shows a placeholder) and into Supabase Auth > Providers > Google (leave "Skip nonce check" off; the app sends a SHA-256 nonce).
2. **Gmail read client** (Web application). Redirect URI: `https://<your-project-ref>.supabase.co/functions/v1/ari-gmail-oauth`. Scope: `https://www.googleapis.com/auth/gmail.readonly`. Its id and secret become the function secrets `ARI_GMAIL_CLIENT_ID` and `ARI_GMAIL_CLIENT_SECRET`. While the consent screen is in testing, add your own address as a test user.

## 2. Secrets and settings, by name

Never commit a value. Where each one is created and used:

| Name | Where it lives | Used by | How to create |
|---|---|---|---|
| Supabase URL `https://<ref>.supabase.co` | worker env `ARI_SB_URL`, `web/ops.html` `SB_URL`, `app-web` env | everything | from the project |
| Publishable key `sb_publishable_...` | worker env `ARI_SB_APIKEY`, `web/ops.html` `SB_KEY` | app and worker (public by design) | Project Settings > API Keys |
| Worker JWT (role `ari_worker`) | private file, `ARI_SB_JWT_FILE` | `scripts/ari_db.py`, sync, reports | see step 5 |
| `ARI_WORKER_CALLER_SECRET`, `ARI_WORKER_EMAIL`, `ARI_WORKER_PASSWORD`, `ARI_WORKER_UID` | function secrets | `ari-worker-token` (R7, optional) | random secret; a worker Auth user |
| Named secret keys `ari_push`, `ari_backup`, `ari_gmail_oauth`, `ari_gmail_ingest`, `ari_worker_token`, `ari_ai`, `ari_gmail_push` | Supabase API Keys (type secret) | pending (R7) edge functions, read through `SUPABASE_SECRET_KEYS` | API Keys > New secret key, one per function |
| `SUPABASE_SERVICE_ROLE_KEY` | injected | the four live functions as they were on prod | nothing to do; the pending versions don't use it |
| `ARI_BACKUP_HOOK` | function secret + Vault `ari_backup_hook_secret` (same value) | `ari-backup` | `openssl rand -hex 32` |
| Vault `ari_push_hook_secret`, `ari_gmail_hook_secret` | Vault | pg_cron -> functions (`x-ari-hook`) | random, see `config/supabase-config.sql.example` |
| Vault `ari_ai_hook_secret` | Vault | AI layer | created by 0041 |
| Vault `ari_vapid_private_jwk` + `app_config.vapid_public_key` | Vault / table | `ari-push` | generate a VAPID P-256 pair; put the public key in `web/ops.html` (`VAPID17`) too |
| `ARI_GMAIL_CLIENT_ID`, `ARI_GMAIL_CLIENT_SECRET`, `ARI_GMAIL_ALLOW` | function secrets | `ari-gmail-oauth`, `ari-gmail-ingest`, `ari-gmail-push` | Google Cloud, step 1 |
| `EXPO_ACCESS_TOKEN` | function secret | `ari-push` native path | only if you build the native app |
| `OFFSITE_CERT_PEM` | function secret (staging only) | `ari-backup` | optional override |
| Offsite recipient certificates | `native/supabase/offsite/*.pem` (public certs) | `ari-backup`, `offsite_certs.py` | make your own P-384 key pairs with openssl; commit only the certs, keep the private keys offline |
| `ANTHROPIC_API_KEY`, `PARALLEL_API_KEY`, `ARI_APP_ORIGINS`, `ARI_PUBLISHABLE_KEY`, `XAI_API_KEY`, `BRAVE_SEARCH_API_KEY`, `LEMLIST_API_KEY` | function secrets | `kyte-ai` | provider consoles; all optional except Anthropic for the AI layer |
| `ARI_SELLER_CONFIG` -> `config/seller.private.json` | private file | `copy_check.py`, `scan_heartbeat.py` | from `config/seller.private.json.example` |
| Sheet id | task prompts `{SHEET_ID}`, three script constants | worker, scans, sync | from the Sheet URL |
| Vercel token | your shell (`VERCEL_TOKEN`) | `deploy_web.py` | Vercel > Account > Tokens; see gotchas |
| `CLAUDE_CODE_OAUTH_TOKEN` | GitHub repo secret | Claude review workflows (optional) | `claude setup-token`, paste as one line |
| Keel files `scrub_map.json`, `names.json`, `dict_words.txt` | private folder (`KEEL_DIR`) | `git_export.py` | your own scrub rules; see step 10 |

## 3. Database: create and migrate (staging first, then prod)

### 3.1 Project settings
1. Create the project (Postgres 17).
2. Database > Extensions: enable `pg_cron`, `pg_net`, `supabase_vault` (Vault), `pgcrypto`. Leave the rest.
3. Auth > Providers: enable Google with the sign-in client from step 1. Turn on leaked-password protection (Kyte never did).
4. Data API: the Oct 30 2026 grants change is already on for every project (see gotchas). Kyte's migrations grant explicitly, so that's fine.

### 3.2 Set your own values in the SQL first
The repo is scrubbed, so a few files carry placeholders you must replace before running anything:
- The prod project ref appears as `your-prod-project-ref` (and staging as `your-staging-project-ref`) in the baseline, 0003, 0022, 0030, `ari-backup` and docs. Replace with your refs.
- The owner email in the baseline and 0001 appears as `owner@example.com`. Replace with your Google address.
- The owner is pinned by auth user id in 0016 (`is_owner()`), 0024, 0033, 0045 and several test files (one hard-coded uuid). Sign in once to create your auth user (step 6), then replace that uuid everywhere with yours: `grep -rl <old-uuid> native/supabase | xargs sed -i 's/<old-uuid>/<your-uid>/g'`.
- The workspace id in 0033 is a fixed uuid. Keep it; nothing personal.

### 3.3 Apply, in this order
Run each file as `postgres`, one file per request, with `psql -v ON_ERROR_STOP=1 -f <file>` (or the Management API query endpoint). Each pending file has a `test/checks_after_<n>.sql` that ends with a deliberate error saying `ALL <n> CHECKS PASSED`; that error is the pass.

1. `native/supabase/baseline/prod_public_schema_2026-10-17_pre0015.sql` (= prod after 0014; this is the path CI proves). The alternative, 0001 to 0014 in order on an empty project, was never rehearsed end to end.
2. `native/supabase/migrations/0015_*.sql` to `0032_*.sql`, in order.
3. `migrations/pending/0033_app2_e1_tenancy.sql`, `0034_app2_e2_backfill.sql`, `0035_app2_e3_dual_rls.sql` (0035 is generated from the schema; if its precheck refuses, regenerate it with `test/gen_e3.py` against your database). Run `test/checks_after_e3.sql`.
4. `0037_members_aal2.sql`, `0038_s1_release6.sql` (+ checks). Skip 0036 (0038 removes what it added). Never run `test/fixtures_before_0038.sql` outside a throwaway database.
5. `0042_security_hardening.sql`, `0043_definer_caller_checks.sql` (+ checks).
6. `0045_pair_visibility.sql`, `0046_draft_assumptions.sql` (+ checks).
7. `0041_ai_layer.sql` (+ `checks_after_0041_staging.sql` on staging). It leaves `ai_budget.enabled = false`. Pause the `ari-ai-events` cron job unless you also fix 0047's known bugs.

That is exactly prod at the sunset. Optional, never on prod, all with rollbacks and checks:
- `0040` R7 broker (do this on a new project, see step 5).
- `0048` push digest = Today's total. `0050` decline line in the app-change trigger (the live trigger still says "That's handled in Hark, not here."; apply 0050 to fix).
- `0049`, `0051` instant chat and chat drafts (need the AI layer deployed).
- `0052` scan controls. `0044` typed event labels.
- `0047` AI pipeline: has 2 HIGH bugs found in staging (it drafted for Hold and exec-track contacts and ignored account flags). Fix before use.

### 3.4 Rehearse locally first (recommended)
`PGHOST=... PGUSER=postgres bash native/supabase/migrations/pending/test/run_local.sh` builds a Supabase-like Postgres 17, loads the baseline and 0015 to 0032, then applies, checks and rolls back every pending migration twice. CI job `sql-prod-shape` runs the same.

## 4. Edge functions
Deploy with the Supabase CLI (`supabase functions deploy <slug> --no-verify-jwt`). Verify JWT stays OFF on every function: each checks its own caller.

1. Set the function secrets first (`config/edge-functions.env.example`). A missing secret fails closed.
2. Deploy the live four from `native/supabase/functions/<slug>/`: `ari-push`, `ari-backup`, `ari-gmail-oauth`, `ari-gmail-ingest`. Or, on a new project, deploy the `pending/` versions instead: they read their own named secret keys and never the legacy service key (`pending/check_no_legacy_keys.py` checks that).
3. Smoke checks: `ari-backup` with the real `x-ari-hook` returns 202 and a run id; `ari-push` test via the app's Settings > Send a test ping; `ari-gmail-oauth` opens Google consent (not `r=setup`).
4. Optional AI layer: deploy `pending/kyte-ai` as `kyte-ai` and `pending/ari-ai` as `ari-ai` (same code; the database kicks still call `ari-ai`). Smoke: no auth -> 401, wrong hook -> 401, `{internal:"process"}` with the real hook -> 202 and no model call while the budget is off. Runbook: `docs/runbooks/live-ai-layer-deploy.md`.
5. Run `config/supabase-config.sql.example` (VAPID, hook secrets, `gmail_fn_base`, push privacy).
6. Check cron: `select jobname, schedule, active from cron.job;` should list the `ari-*` jobs from [architecture.md](architecture.md).

## 5. The worker's database identity
The worker never uses the service key. It signs in as role `ari_worker` (created and granted by 0018). Two ways:

- **A. Long-lived JWT (what prod used).** Mint a JWT with `{"role": "ari_worker", "iss": "supabase", "exp": <date>}` signed with the project's JWT secret, save it in a private file, point `ARI_SB_JWT_FILE` at it. Only works while the project still has a legacy HS256 JWT secret. Revoking legacy keys breaks it at once. Set a renewal reminder before `exp`.
- **B. Short-lived tokens through the broker (R7, tested on staging only).** Apply 0040, create a worker Auth user with role `ari_worker` through the Auth admin API, deploy `pending/ari-worker-token` with its secrets, and set `ARI_WORKER_BROKER=1`, `ARI_BROKER_URL`, `ARI_WORKER_CALLER_FILE`, `ARI_WORKER_UID` for the worker. `python3 scripts/ari_token.py ensure --whoami` must print role `ari_worker`. Use this on any new project.

Check: `python3 scripts/sync_sheet_supabase.py --verify` prints row counts on both sides.

## 6. Web app
1. In `web/ops.html` set `SB_URL`, `SB_KEY`, `VAPID17` and `CLIENT_ID` (the repo shows placeholders). Keep the rest.
2. Deploy `web/` to Vercel as a static site. `web/vercel.json` redirects `/` to `/ops`. `scripts/deploy_web.py --target=production --confirm` is the old path; outside Hark it needs your Vercel token added to its API call.
3. Open `https://<your-domain>/ops`, sign in with Google. This creates your auth user; now finish step 3.2 (pin your uid) if you haven't.
4. Install it to the home screen, turn on pings in Settings, set a passkey.
5. Optional, the rebuild in `app/`: `cd app/web && npm ci && npm run dev` with `config/app-web.env.example`. It runs on demo data by default.

## 7. Google Sheet
1. Create the Sheet from [config/sheet-template.md](config/sheet-template.md).
2. Put its id in the three scripts and the prompts.
3. First load: `python3 scripts/sync_sheet_supabase.py --backfill` (writes tagged backfill, so no pushes fire). Then a normal run.

## 8. Gmail ingest
1. In the app, Settings > Connect Gmail. It goes through `ari-gmail-oauth` and comes back to `/ops?gmail=connected`.
2. Turn on LinkedIn email notifications for invitations accepted and messages.
3. The worker's step 0 (`scripts/gmail_step.py`) also reads them through `gws`; both paths can run.

## 9. Scheduled tasks
Recreate each from [tasks/](tasks/README.md), in the order listed there. Replace the placeholders, keep the wording. Then:
- `python3 scripts/worker_precheck.py` should print `IDLE` on an empty system.
- Add one test lead in the app (Settings > add a lead), watch the worker pick it up within 10 minutes and write a draft.
- Run the backup check by hand once; it should report `{"ok": true ...}`.

## 10. The repo gate (if you publish a copy)
`bash scripts/git_sync.sh "Area: what changes"` is the only way to commit. It needs a private folder (`KEEL_DIR`) holding:
- `scrub_map.json`: `{"rules": [["l"|"w"|"p"|"x", "<real>", "<placeholder>"], ...], "files": {"<glob>": [rules]}, "ignore": ["<word>"]}`. `l` literal, `w` word, `p` proper noun, `x` regex.
- `names.json`: real names to scan for (`git_export.py --refresh-names` pulls them read-only from the database).
- `dict_words.txt`: common words never treated as names.
Add any new path to `INCLUDE` in `scripts/git_export.py`. If the scan finds something, fix the source or add a scrub rule; never commit around it.

## 11. Verification checklist
- [ ] Public key reads nothing: `curl "https://<ref>.supabase.co/rest/v1/people?select=id&limit=1" -H "apikey: <publishable>"` returns `[]` or a permission error.
- [ ] Owner sees Today with live data; a tap writes and survives a reload.
- [ ] A change made in the Sheet shows up in the app within one sync.
- [ ] Settings > Send a test ping reaches the phone.
- [ ] An accept email marks the person accepted and a DM1 draft follows.
- [ ] The worker's copy check passes on a fresh draft (`python3 scripts/copy_check.py check <id> dm1 <file>` prints `PASS`).
- [ ] Next morning: a `backup_runs` row with `verified = true`, and the encrypted copy in Drive.
- [ ] `ari-health-alert` quiet, `python3 scripts/health_check.py` prints nothing.
- [ ] CI green on the repo, repo-scan clean.

## Known gotchas
- **The proxy injected the auth.** Inside Hark the sandbox's egress proxy added `Authorization: Bearer <ari_worker JWT>` to Supabase calls, plus the Google, Vercel and GitHub credentials. The scripts therefore send only the publishable key. Outside Hark, set `ARI_SB_JWT_FILE` (or the broker vars) and give `deploy_web.py` a token, or every call returns 401. The restore drill deliberately bypasses the proxy so the header isn't swapped.
- **Egress.** One full sync read was about 4 MB and ran every 10 minutes, which pushed the free plan's egress. The Nov 2 fix (delta reads by `updated_at`, a local base cache, a row-count check, a full read every 6 hours, gzip) brought it to about 65 KB. Keep it. The app side (`ops.html` caching and narrower selects) was never done.
- **Grants change (Oct 30 2026).** Supabase stopped auto-granting new `public` tables to `anon`, `authenticated` and `service_role` on every project from that date ([changelog](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically)). Any new table you add needs explicit `grant`s plus RLS, or PostgREST answers `42501 permission denied`. Kyte's migrations already grant explicitly and 0016/0042 lock defaults, but write grants into every new migration (see `docs/runbooks/db-changes.md`).
- **Base lock md5.** `web/ops.html` is frozen by an md5 in `plans/base-lock.json` (private, not in the repo). `deploy_web.py` refuses a changed file unless `ARI_BASE_FIX='<reason>'` is set, and then you record the new md5. On a rebuild, create your own `plans/base-lock.json` with `{"file": "web/ops.html", "md5": "<md5 of your file>"}` or drop the check.
- **Legacy names.** Database roles, functions, cron jobs, Vault secrets, edge function slugs, localStorage keys and cache names still say `ari`. Don't rename them casually; see `docs/engineering/code-names.md`.
- **Scrubbed names in code.** The repo shows a placeholder company (`Thrandvex`, e.g. `why_thrandvex`), a placeholder product name (`Kelvarrow`, e.g. `kelvarrow-*.png`), placeholder people in demo data, and placeholder refs and keys. The live app used the real ones. When you set up your own copy, these are the spots to fill in.
- **Exec-track stored values.** The old route, stage and Queue action values for the exec track contained a real exec's name. Pick neutral values and change them in `ops.html`, the worker prompt and `exec_track_handoff.py` together.
- **The legacy decline line.** Without 0050, app-change rows get "That's handled in Hark, not here." from the trigger. The app's display map rewrote it on screen; apply 0050 to fix it at the source.
- **iPhone Home Screen apps** lay out one status bar short unless the root is `100lvh` (fixed in v18.0.2; keep it). Phones cache old shells: bump the `sw.js` cache name on every deploy.
- **The 10-minute floor.** Chat through the worker answers in up to 10 minutes. For instant chat you need the AI layer plus 0049.
- **LinkedIn.** Its terms bar automated access. The design that holds up is notification emails plus human ticks. The read-only list passes and profile scan were explicit, paused choices.
- **Token renewal.** The long-lived worker JWT and its tasks expired together (Apr 2027 on prod). Keep expiry and task end dates in one place.
