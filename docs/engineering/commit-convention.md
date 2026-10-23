# Commit convention

How commits in this repo are written. Older history stays as it is; it is never rewritten.

## Title

`Area: what changes`

- Area is the part of the repo, in plain words: `Web`, `App2`, `Jobs`, `DB`, `Functions`, `Scripts`, `CI`, `Docs`, `Legal`, `Release review`.
- What changes is imperative and plain: "add", "fix", "remove", not "added" or "fixes".
- 72 characters or fewer.
- No version in the title. A build number like v18.16.4 goes in the body.

Examples:

- `CI: run edge function tests`
- `Jobs: skip accepts already drafted`
- `Docs: add commit convention`

## Body

Leave one blank line after the title, then say:

1. Why: the problem or the request this answers.
2. Risk: what could break, and the rollback if there is one.
3. Verified: how it was checked (tests, CI run, phone check).

A stage tag like S1 or S2 can go in the body or the branch name.

## One focused change per commit

A commit does one thing. A README rewrite and a CI change are two commits. Never one commit per file for a single change.

## Author

Every commit is authored as Owner with the GitHub noreply address:

`Owner <36487118+shaleenjha@users.noreply.github.com>`

No other names or addresses.

## No Co-Authored-By trailers

GitHub turns every email in a Co-Authored-By trailer into a listed contributor, and an address can map to a stranger's account. Credit for the tools that helped lives in the README credits line instead.

## How commits are pushed

- To main: `bash scripts/git_sync.sh "Area: what changes"`. It pulls first, scrubs names, scans for secrets and pushes one commit.
- To a review branch: `python3 scripts/git_push_api.py <export_dir> --branch <name>`.
- Never the per-file contents API. It makes one commit per file and stamps the wrong author email.
- Never force push.
