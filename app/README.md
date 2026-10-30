# app: Kyte rebuild foundations (Phase 1)

Built beside the live app; nothing here is deployed or connected to the live project. Synthetic data only.

| Folder | What | Run |
|---|---|---|
| `db/` | Multi-tenant schema (workspaces, memberships, workspace_id everywhere, composite FKs, RLS via `app.is_member/has_role`), task graph + command RPCs, job queue | `bash db/run_tests.sh` against any Postgres 17 (CI uses a service container) |
| `web/` | Vite + React + TS mobile-first PWA shell: Today (with Tidy up + Who is this?), Today's 15, Replies, Account room, Report over a typed REST data layer against an in-memory PostgREST mock (synthetic workspaces) | `npm ci && npm run typecheck && npm test && npm run e2e` |
| `jobs/` | Job runtime, gmail-ingest fetch (Gmail JSON, cursor, idempotent) + parser + shadow diff, Quill draft-eval harness | `npm ci && npm run typecheck && npm test && npm run eval:drafts` |
| `docs/` | `migration-map.md` (prod → app, expand/contract, not applied), `job-system.md`, `gmail-fetch.md` (fetch, auth design, shadow report), `draft-eval.md` | |

CI: `.github/workflows/ci.yml` (typecheck, unit tests, draft eval, SQL tests, Playwright at 360/412 px on Chromium + WebKit, design lint, prod-shape rehearsal of the pending E1 to E3 migrations).

Design lint: `cd web && npm run lint:design` (static source rules, then the `@design` Playwright checks; `npm run e2e` skips them). Rules and thresholds live in `web/scripts/design-lint/rules.mjs`: tap targets 48x48 at 360/412 px, WCAG AA text contrast from rendered styles, banned copy (exclamation marks, em/en dashes, hype words, city/time-zone words, infrastructure words), Today at most 1.5 viewports tall at 412x915, no system font as the primary family, no gradients or glow shadows outside `EFFECTS_ALLOW_LIST`. One-line escape hatch in source: `// design-lint-allow: <reason>`. Default theme: Graphite (`--graphite-bg #050505`, `--graphite-accent #E2B062`), Inter self-hosted in `web/public/fonts` (OFL).
Local browsers on linux-arm64: `PW_CHROMIUM_PATH=<chromium binary> PW_PORT=<port>` runs the Chromium projects with that binary.
