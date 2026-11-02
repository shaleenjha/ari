# Kyte

Private repository. Do not make public.

Kyte is an outbound prep system for one sales rep. Kyte prepares, Owner sends. Kyte finds the right accounts and people, drafts the messages, tracks who accepted and who replied, and stops at the first meeting set. Nothing is sent automatically, and LinkedIn is always worked by a human.

## Features

- Account and people research, ranked into a short daily list.
- Drafted connection notes and DMs that follow the house style (short, plain, no hype).
- Follow-up timing: who is due today, and what to say.
- Reply and accept tracking from LinkedIn notification emails (Gmail, read only, optional).
- A daily report of what moved.
- Nightly encrypted backups with an offsite copy.

## Repo layout

New here? Read [`REPO_MAP.md`](REPO_MAP.md) first. It is a plain guide to every folder.

- `web/`: the live installable web app (`ops.html`, frozen), service worker, manifest, public pages.
- `app/`: the new app. `app/web` is the React PWA, `app/jobs` holds background jobs and the draft eval, `app/db` holds the practice schema and its tests.
- `native/supabase/`: database migrations, rollbacks, tests and edge functions.
- `scripts/`: sync, reports, backups, deploy and the git export used to publish this repo.
- `docs/`: specs, runbooks and engineering notes.

## Requirements

- Node 22 and npm (app/web, app/jobs)
- Python 3.12 (scripts)
- Deno 2 (edge functions)
- PostgreSQL 17 client tools (SQL tests)

## Local setup

New app (`app/web`):

```
cd app/web
npm ci
npm run dev          # local dev server
npm run typecheck
npm test             # unit tests
npm run lint:slop    # design tokens, copy and query rules
npm run lint:design  # needs: npx playwright install chromium webkit
npm run e2e
npm run build
```

Background jobs (`app/jobs`):

```
cd app/jobs
npm ci
npm run typecheck
npm test
npm run eval:drafts  # scores drafts against the house style
```

Database tests (a local Postgres 17 on port 5432):

```
bash app/db/run_tests.sh
bash native/supabase/migrations/pending/test/run_local.sh
```

Edge functions (`native/supabase/functions`):

```
deno check native/supabase/functions/pending/ari-worker-token/index.ts
deno test --allow-env --allow-read $(find native/supabase/functions -name '*_test.ts' -o -name '*.test.ts')
```

Scripts:

```
python3 scripts/test_hygiene_scan.py   # and the other scripts/test_*.py files
```

## Deploy

Deploys are approved by Owner, every time. The only deploy command is:

```
python3 scripts/deploy_web.py --target=production --confirm
```

Anything else aborts. `web/ops.html` is locked by `plans/base-lock.json` (not in this repo); only data loss or security fixes change it. Commits reach this repo only through `scripts/git_sync.sh`. See [`docs/engineering/commit-convention.md`](docs/engineering/commit-convention.md).

## Privacy

- The public privacy policy is [`web/privacy.html`](web/privacy.html).
- What data Kyte holds and where: [`docs/privacy-data-inventory.md`](docs/privacy-data-inventory.md).
- This repo is a scrubbed export. Names of people, companies and employers in demo data and copy are replaced with placeholders, so strings here may not match the running deployment exactly.
- Public-by-design values are present: the Supabase project URL, its publishable (anon) key, and the Web Push VAPID public key. No service keys, tokens or private keys are stored here; they are injected at runtime.

## License

All rights reserved. See [`LICENSE`](LICENSE).

## Credits

Built with Hark and Claude.
