# app2: Ari rebuild foundations (Phase 1)

Built beside the live app; nothing here is deployed or connected to the live project. Synthetic data only.

| Folder | What | Run |
|---|---|---|
| `db/` | Multi-tenant schema (workspaces, memberships, workspace_id everywhere, composite FKs, RLS via `app.is_member/has_role`), task graph + command RPCs, job queue | `bash db/run_tests.sh` against any Postgres 17 (CI uses a service container) |
| `web/` | Vite + React + TS mobile-first PWA shell: Today (with Tidy up + Who is this?), Today's 15, Replies, Account room, Report over a typed REST data layer against an in-memory PostgREST mock (synthetic workspaces) | `npm ci && npm run typecheck && npm test && npm run e2e` |
| `jobs/` | Job runtime, gmail-ingest fetch (Gmail JSON, cursor, idempotent) + parser + shadow diff, Quill draft-eval harness | `npm ci && npm run typecheck && npm test && npm run eval:drafts` |
| `docs/` | `migration-map.md` (prod → app2, expand/contract, not applied), `job-system.md`, `gmail-fetch.md` (fetch, auth design, shadow report), `draft-eval.md` | |

CI: `.github/workflows/ci.yml` (typecheck, unit tests, draft eval, SQL tests, Playwright at 360/412 px on Chromium + WebKit, design lint, prod-shape rehearsal of the pending E1 to E3 migrations).

Design lint: `cd web && npm run lint:design` (static source rules, then the `@design` Playwright checks; `npm run e2e` skips them). Rules and thresholds live in `web/scripts/design-lint/rules.mjs`: tap targets 48x48 at 360/412 px, WCAG AA text contrast from rendered styles, banned copy (exclamation marks, em/en dashes, hype words, city/time-zone words, infrastructure words), Today at most 1.5 viewports tall at 412x915, no system font as the primary family, no gradients or glow shadows outside `EFFECTS_ALLOW_LIST`. One-line escape hatch in source: `// design-lint-allow: <reason>`. Default theme: Graphite (`--graphite-bg #050505`, `--graphite-accent #E2B062`), Inter self-hosted in `web/public/fonts` (OFL).
Local browsers on linux-arm64: `PW_CHROMIUM_PATH=<chromium binary> PW_PORT=<port>` runs the Chromium projects with that binary.

## web: data modes and the Phase 1 read-only wiring (v18.14.0)
- `mock` (default build, e2e, design lint): synthetic rows through the in-memory PostgREST fixture (`src/data/fixtures/`), every action works.
- `live` (build with `VITE_ARI_DATA=live VITE_ARI_SUPABASE_URL=… VITE_ARI_SUPABASE_KEY=<publishable key> VITE_ARI_GOOGLE_CLIENT_ID=…`, optional `VITE_ARI_WORKSPACE_ID`): `src/data/live.ts` reads production `public.*` with the signed-in user's JWT, so RLS decides the rows; every read is a GET with `workspace_id=eq.<ws>` and a `limit`. Sign-in (`src/data/auth.ts`) is Google ID token to Supabase `grant_type=id_token`, the same path as the current app.
- Live is always read-only. `?ro=1` gives the same read-only UI over synthetic rows; `?data=mock` forces synthetic rows on a live build.
- Read-only UI: write controls keep their place with `aria-disabled="true"` (never native `disabled`), a tap shows one toast, one "Read-only" pill in the header. Design lint exempts only `[aria-disabled="true"]` from text contrast (`rules.mjs` `CONTRAST_EXEMPT`); 48px targets and live taps still apply.
- CI write ban: `npm run lint:query` rule `no-client-writes` (`scripts/query-lint/no-client-writes.mjs`) fails on any `.rpc(`, insert/upsert/update/delete, storage writes, and any non-GET request in `app2/web/src` (sign-in on the auth path excepted). No allow escape; only `*.test.ts(x)` and `fixtures/` are exempt.
