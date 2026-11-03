# Kyte

Kyte was my LinkedIn outbound prep system. I'm an SDR, and the part of the job I kept slipping on was LinkedIn, mostly follow-ups. So over about three weeks (Oct 13 to Nov 3 2026) I built this with Hark, my AI agent.

Kyte did the prep and I did the sending. It found accounts with a real, dated reason to reach out, picked the people, drafted the invite and the three DMs, noticed accepts and replies from LinkedIn's notification emails, and told me who to message tonight. It never sent anything. Every invite and every DM went out by hand from my own LinkedIn. That rule never changed.

It started as a Google Sheet with an Apps Script page, then became a phone app called Den, then Ari, then a bird name for about a day, then Kyte. The backend was Supabase, the app was one big installable web page, and the "brain" was a set of scheduled Hark tasks that ran every 10 minutes during my US-hours shift.

## How it ended

On Nov 3 2026 I shut it down. I already run a Claude setup at work, and my LinkedIn work moved in there. Running two systems for the same job didn't make sense. The app is deleted, the scheduled tasks are paused, the database is paused for 30 days and gets deleted after Dec 3 2026.

This repo is what's left, and it's meant to be enough to bring Kyte back if I ever want to. There's no data in here, by design: no people, no companies, no messages, no keys.

## Read this next

- [docs/kyte/journey.md](docs/kyte/journey.md): the story, version by version, what worked and what didn't
- [docs/kyte/architecture.md](docs/kyte/architecture.md): how the pieces fit, with diagrams
- [docs/kyte/data-model.md](docs/kyte/data-model.md): every table, the stages and the cadence rules
- [docs/kyte/components.md](docs/kyte/components.md): every script, function and migration in one line each
- [docs/kyte/REBUILD.md](docs/kyte/REBUILD.md): from zero to working, step by step
- [docs/kyte/tasks/](docs/kyte/tasks/README.md): the scheduled task prompts, the part you replug
- [docs/kyte/sunset.md](docs/kyte/sunset.md): what got shut down, when, and what's left
- [REPO_MAP.md](REPO_MAP.md): a plain tour of every folder

## Repo layout

- `web/`: the app as it last ran (`ops.html` at `/ops`), service worker, manifest, public pages.
- `app/`: a rebuild I started and then stopped on Oct 28. React PWA on demo data, background jobs, practice schema.
- `native/supabase/`: the database. Baseline, migrations with rollbacks and checks, edge functions, restore notes. "native" is an old name.
- `scripts/`: what the scheduled tasks ran: sync, Gmail ingest, copy checks, reports, backups, deploys, and the export that publishes this repo.
- `docs/`: specs, runbooks, engineering notes, and the Kyte record in `docs/kyte/`.
- `archive/`: old UI versions and mockups, on made-up data.

## Running the tests

```
cd app/web && npm ci && npm test        # rebuild app unit tests
cd app/jobs && npm ci && npm test       # jobs, Gmail parser, draft eval
bash native/supabase/migrations/pending/test/run_local.sh   # needs a local Postgres 17
python3 scripts/test_repo_scan.py       # and the other scripts/test_*.py
```

CI runs all of it on every push, plus a leak scan over the whole repo.

## About the scrub

Every file gets here through `scripts/git_sync.sh`, which copies an allow-list of files, swaps real names for placeholders, and refuses to commit if it finds a name, email, phone number, LinkedIn link or key. So the demo data, some identifiers and a couple of names (a company shows up as Thrandvex, an old product name as Kelvarrow) won't match what actually ran. That's on purpose.

## License

All rights reserved. See [LICENSE](LICENSE). If you want to reach me, my GitHub profile is the way.

Built with Hark and Claude.
