# app2: Ari rebuild foundations (Phase 1)

Built beside the live app; nothing here is deployed or connected to the live project. Synthetic data only.

| Folder | What | Run |
|---|---|---|
| `db/` | Multi-tenant schema (workspaces, memberships, workspace_id everywhere, composite FKs, RLS via `app.is_member/has_role`), task graph + command RPCs, job queue | `bash db/run_tests.sh` against any Postgres 17 (CI uses a service container) |
| `web/` | Vite + React + TS mobile-first PWA shell: Today, Today's 15, Replies, Account room, Report over a typed data layer (mock) | `npm ci && npm run typecheck && npm test && npm run e2e` |
| `jobs/` | Job runtime skeleton + deterministic gmail-ingest parser (shadow mode first) | `npm ci && npm run typecheck && npm test` |
| `docs/` | `migration-map.md` (prod → app2, expand/contract, not applied), `job-system.md` | |

CI: `.github/workflows/ci.yml` (typecheck, unit tests, SQL tests, Playwright at 360/412 px on Chromium + WebKit).
