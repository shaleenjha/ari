# Runbook: git sync (v18.17.10, Oct 19 2026)

Commit and push only with `bash scripts/git_sync.sh "vX.Y: summary"`, in a shell call that carries the GitHub
credential. The sync is pull-first: after the scrubbed export is built, `scripts/git_pull_remote.py` compares remote
`main` with the last commit we pushed (kept in `work/keel/.git_sync_state.json`, never committed; bootstrapped from the
remote commit whose tree matches the export repo's HEAD). Any commits made on GitHub since then, such as web edits or
merged `@claude` PRs, are brought into the project source: added and changed files are written (changed files merged
with `git merge-file`, so scrubbed placeholders never replace real values), and remote deletions are applied. If a path
changed both on GitHub and locally, or GitHub added a path outside the export allow-list, the sync prints
`conflict: <paths>, resolve first` (or the allow-list path) and exits 1 with nothing pushed: bring the remote change in
by hand, then rerun. Otherwise the export is rebuilt, committed under Owner's noreply identity, and
`scripts/git_push_api.py` pushes it as a normal child of the remote HEAD the pull synced to. It refuses if `main` moved
in between, and it never forces or rewrites history. Tests: `python3 scripts/test_git_sync_pull.py` (mocked API, CI job
`scripts`).
