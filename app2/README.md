# app2: Ari rebuild foundations (Phase 1)

Built beside the live app; nothing here is deployed or connected to the live project. Synthetic data only.

| Folder | What | Run |
|---|---|---|
| `db/` | Multi-tenant schema (workspaces, memberships, workspace_id everywhere, composite FKs, RLS via `app.is_member/has_role`), task graph + command RPCs, job queue | `bash db/run_tests.sh` against any Postgres 17 (CI uses a service container) |
| `web/` | Vite + React + TS mobile-first PWA shell: Today (with Tidy up + Who is this?), Today's 15, Replies, Account room, Report over a typed REST data layer against an in-memory PostgREST mock (synthetic workspaces) | `npm ci && npm run typecheck && npm test && npm run e2e` |
| `jobs/` | Job runtime, gmail-ingest fetch (Gmail JSON, cursor, idempotent) + parser + shadow diff, Quill draft-eval harness | `npm ci && npm run typecheck && npm test && npm run eval:drafts` |
| `docs/` | `migration-map.md` (prod → app2, expand/contract, not applied), `job-system.md`, `gmail-fetch.md` (fetch, auth design, shadow report), `draft-eval.md` | |

CI: `.github/workflows/ci.yml` (typecheck, unit tests, draft eval, SQL tests, Playwright at 360/412 px on Chromium + WebKit).
