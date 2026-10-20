# Ari

Ari is a research-first outreach workspace for a single sales rep: it finds the right accounts and people, drafts human-sent messages, tracks follow-ups and replies, and stops at the first meeting set. Nothing is sent automatically.

## Layout
New here? Read `REPO_MAP.md` first: a plain guide to every folder.

- `app2/` - the new app being built (React PWA, background jobs, practice database).
- `web/` - the installable web app (single-page `ops.html`, service worker, manifest, icons, fonts, vendored supabase-js).
- `native/supabase/` - Postgres schema: `migrations/` (applied in order), `pending/` (not yet applied), `rollbacks/`, and the `ari-push` edge function.
- `scripts/` - operational jobs: sheet <-> database sync, reply ingest, daily report, DB backup, deploy, and the git export/sync used to publish this repo.

## Notes
- This repo is a **scrubbed export**. Names of people, companies and employers in demo data and copy are replaced with placeholders, so strings here may not match the running deployment exactly.
- Public-by-design values are present: the Supabase project URL, its publishable (anon) key, and the Web Push VAPID **public** key. No service keys, tokens or private keys are stored here; they are injected at runtime.
- Private repository. Do not make public.
