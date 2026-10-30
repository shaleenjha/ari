# Live AI layer: deploy checklist (prepared Oct 23 2026; NOT deployed, draft, needs Owner's go on each step)

Code: branch `live/ai-layer` (`native/supabase/functions/pending/{_shared/ai,ari-ai,ari-gmail-push}`, migration
`native/supabase/migrations/pending/0041_ai_layer.sql`). Setup detail: `native/supabase/functions/README.md`.

## Hard prerequisite: S1 R7 live first
- 0040 applied, the four functions on their named secret keys, the worker on the broker token (off legacy service_role).
- Why: ari-ai and ari-gmail-push read ONLY named keys (`ari_ai`, `ari_gmail_push`) through `secretKey()`; there is no
  legacy fallback, so they fail closed before R7. And ari-gmail-push calls the R7 `ari-gmail-ingest` (named key `ari_gmail_ingest`).
- Do not deploy any piece of this before R7's production step is done and verified.

## Secrets (function secrets, project-wide)
| Name | What | Notes |
|---|---|---|
| `ari_ai`, `ari_gmail_push` | new named secret keys (`sb_secret_...`) | injected in `SUPABASE_SECRET_KEYS`, else set `ARI_SK_ARI_AI` / `ARI_SK_ARI_GMAIL_PUSH` |
| `ANTHROPIC_API_KEY` | Anthropic key | Opus (all drafts, deep research orchestration), Sonnet (quick research), Haiku (classify); set a provider-side monthly limit too |
| `XAI_API_KEY` | xAI key | Grok searches inside deep research (x_search / web_search); set a provider-side limit too |
| `ARI_PUBLISHABLE_KEY` | only if `SUPABASE_PUBLISHABLE_KEYS` is not injected | public by design (the app ships it) |
| `ARI_APP_ORIGINS` | comma list of app origins allowed by CORS | default `https://ari-web.vercel.app`; add the app origin |
| `ARI_GMAIL_CLIENT_ID` / `_SECRET` | already set for ingest | reused by ari-gmail-push for users.watch |
| `OPENAI_API_KEY` | optional, unused | backup stub only |

## Token scope needed (short-lived, from Owner; revoke after)
- Supabase access token for project rbkrqlzlblquvgmuohro (staging ljojwhnfgfreokqspobg first) that can: deploy Edge Functions,
  write function secrets, create API keys (the two named secret keys), and run SQL (apply 0041, app_config rows, ai_budget).
- Google Cloud: an account with Pub/Sub Admin + Service Account Admin on the project that owns the Gmail OAuth client.
- GitHub: none for deploy. CI change on main needs a normal push to main (branch pushes refuse `.github/`).

## Order (staging, then prod)
1. Stop the worker (pause the Hark 10-minute worker and the off-hours check; confirm no run in flight).
2. Apply `0041_ai_layer.sql` (one request). `ai_budget.enabled` stays false, so the new crons are no-ops.
   Verify: ledger row 0041, crons `ari-ai-events` / `ari-gmail-watch-renew` / `ari-ai-prune`, grants as in checks_after_0041.sql.
3. Start the worker again (it is untouched by 0041).
4. Create the named keys, set the secrets above, deploy `kyte-ai`, its legacy alias `ari-ai` (entrypoint `ari-ai/index.ts`, same code; the database kicks and
   `ari-gmail-push` call this slug) and `ari-gmail-push` with Verify JWT OFF
   (place `pending/_shared` at `functions/_shared` and each function dir at `functions/<slug>` for the bundle).
5. Staging smoke (synthetic person): `update ai_budget set enabled = true`; app session -> `quick_research`, `draft_dm1`,
   `rewrite` with a chip (stream), `triage_reply`, `deep_research` + `job_stream` (watch queries, reads and findings arrive live);
   check `ai_calls` costs (Opus turns are the expensive line; default cap $50 a month, $5 a day); set
   `monthly_cap_usd` to 0.05 and confirm a 429 `spend_limit`; then disable again.
6. Prod: repeat 2 to 4, then Owner's go -> `update ai_budget set enabled = true`.
7. Gmail push: README "Gmail push (Pub/Sub) setup" steps 1 to 6.
8. Add the CI lines from the README to `.github/workflows/ci.yml` on main.
9. After each prod deploy, move the pending dirs over the live ones (same rule as R7).

## Undo
- Instant: `update ai_budget set enabled = false` (every model call refused, crons idle).
- Push path: delete the Pub/Sub subscription. Functions: undeploy `kyte-ai`, `ari-ai`, `ari-gmail-push`.
- Schema: `0041_ai_layer_rollback.sql` (stop the worker first). Drafts and research already written stay.
