# Sunset (Nov 3 2026)

I shut Kyte down on Tue Nov 3 2026. My LinkedIn work moved into the Claude setup I already use at work (one spreadsheet as shared memory, no hosting, LinkedIn read by hand). Keeping a second, personal system for one channel didn't make sense anymore.

## Timeline (IST)

| When | What | By |
|---|---|---|
| Nov 3, 00:40 to 01:10 | plan to move Kyte in-house at work; settled on sheet only, no hosting | me, with Hark and Claude |
| Nov 3, 01:28 to 01:40 | final read-only LinkedIn check and a handover export of work leads for the new setup (kept out of this repo) | Hark |
| Nov 3, 14:49 | decided to sunset Kyte | me |
| Nov 3, 14:50 | all six active Kyte scheduled tasks paused (worker, profile scan, off-hours, connections read, sent read, review lows); the other Kyte tasks were already paused | Hark |
| Nov 3, ~15:20 | my calls: GitHub is the only record, no data in it, apps deleted, a rebuild should be plug-in | me |
| Nov 3, 15:26 | Vercel projects deleted: the live app and the `app/` preview | Hark |
| Nov 3, ~15:26 | GitHub workflows `claude-review` and `claude` (Claude Code) disabled; `ci` and `repo-scan` stay on | Hark |
| Nov 3 | checked that the public key reads zero tables | Hark |
| Nov 3 | this record written to the repo | Hark |

## What is shut down
- **The app.** Both Vercel projects are gone, so `/ops` no longer loads. Installed home-screen copies will show their cached shell at most, with no data.
- **The brain.** Every Kyte scheduled task is paused, not deleted: worker, poller, off-hours check, LinkedIn connections and sent reads, profile scan, three signal scans, backup check, daily report, review lows. Their prompts are in [tasks/](tasks/README.md).
- **Calendar.** All Kyte calendar events were removed on Nov 2 and `focus_blocks.py` was switched off.
- **AI review on GitHub.** Both Claude workflows disabled.

## What I'm doing myself
- Revoke the Anthropic API key used by the AI layer, and the Claude Code OAuth token used by the GitHub workflows.
- Pause both Supabase projects (prod and staging).

Still open on Nov 3: the leftover Kyte panels on my Hark home and their refresh task.

## What remains
- **This repo,** public, code and docs only. CI and the leak scan stay on.
- **Supabase prod and staging,** paused, data intact, during a 30-day freeze.
- **The nightly encrypted backups** already taken (storage bucket and the Drive copy), until deletion.
- **The private workspace** in Hark (data files, scrub map, task history), until deletion.
- **Legacy identifiers** (`ari_*` names, the repo name `ari`): left as they are. Renaming the repo is my call.

## Data deletion: Dec 3 2026
After a 30-day freeze, on or after **Thu Dec 3 2026**, unless I say otherwise before then:
1. Delete the Supabase prod and staging projects (database, auth users, storage, backups, Vault).
2. Delete the encrypted backup copies in Google Drive.
3. Delete the private data files and the scrub map's private name lists in the Hark workspace.
4. Revoke the Gmail read grant for the Kyte OAuth client and delete the Google Cloud OAuth clients.

Nothing in this repo needs deleting: it never held data.

## If I bring it back
Start at [REBUILD.md](REBUILD.md). The database comes back from the baseline plus migrations, the app from `web/`, and the brain from the prompts in [tasks/](tasks/README.md).
