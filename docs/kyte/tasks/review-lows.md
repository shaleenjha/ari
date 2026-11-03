# Weekly review-lows fix (Saturdays 11:00 IST)

Reads the automatic Claude review issues, keeps `docs/engineering/review-lows.md` current and fixes the one most important backlog low per week through `git_sync.sh`.

| | |
|---|---|
| Schedule type | `weekly` |
| Schedule config | `{"days": ["sat"], "time": "11:00", "timezone": "Asia/Kolkata"}` |
| Timezone | Asia/Kolkata (IST) |
| Credentials it uses | GitHub connector. |
| State at the sunset (Nov 3 2026) | paused |

## Notes for a rebuild

- Depends on `.github/workflows/claude-review.yml`, which was disabled at the sunset. Turn that back on (it needs the `CLAUDE_CODE_OAUTH_TOKEN` repo secret) before this task means anything.

## The prompt (scrubbed)

Copy this into the task, replace the `{...}` placeholders, and keep the rest as written.

```text
Weekly review-lows run for the SDR's Ari repo (public github.com/{OWNER}/{REPO}; workspace {PROJECT_DIR}). the SDR's rule (Oct 24 2026, option A): Claude's automatic review issues ("Claude review: <sha>", filed by .github/workflows/claude-review.yml) mark findings high, med, "low (security)" or "low (backlog)". High, med and low (security) are fixed before the next deploy (not this task's job, but flag any still open). Backlog lows live in docs/engineering/review-lows.md; each week this task fixes the ONE open low that matters most.

Steps:
1. With shell credentials [{"provider":"github"}], read every issue titled "Claude review:" created since this task's last run (first run: since 2026-10-24) via the GitHub API (repo {OWNER}/{REPO}). Add each new backlog low to docs/engineering/review-lows.md under Open in its line format, with priority 1 (could break a backup, deploy or rollback, or hides a failure), 2 (test or check gap) or 3 (docs or wording). Skip duplicates. Move lows already fixed by later commits to Fixed.
2. Pick the open low with the best priority (oldest first on ties). Fix it with the smallest change in the repo source (never work/keel). Run any local tests that cover it (python3 -m unittest in the relevant folder; psql may be missing, that is fine).
3. Mark it fixed in the backlog, then push with exactly: cd {PROJECT_DIR} && bash scripts/git_sync.sh "S1: review low: <short what>" (github credentials; the title must look like 'Area: what changes'; if the output lacks a "pushed" line, run it once more). Commits are under the SDR's name only, which the script handles.
4. Wait about 4 minutes, then read the new "Claude review: <sha>" issue and the commit's check runs. PASS and green = done. FIX or BLOCK caused by your change = revert your change with another git_sync push and mark the low "[open] needs the SDR: <why>".
5. Post ONE short chat line (under 40 words): what you fixed and the review verdict, how many backlog lows remain, and any high, med or low (security) finding still open. If the backlog had nothing open and nothing new arrived, stay silent.

Never deploy anything, never touch Supabase (no PAT, no SQL against any project), never change secrets, keys, vault or workflow permissions, never edit web/ops.html (base lock), and never put secrets, emails, names or personal data in commits, issues or comments. Fix only one low per run.
```
