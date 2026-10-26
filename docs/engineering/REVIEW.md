# REVIEW.md: what the automatic reviewer treats as a real problem

Owner rules for `.github/workflows/claude-review.yml` (Owner, Oct 26 2026, after the Claude Code team's code review writeup).
The workflow reads this file from the BASE commit, so a change can't rewrite its own review rules.

## What counts as failure here
- Data loss or a migration with no way back.
- Data or secrets exposed: RLS gaps, grants wider than needed, service_role or secrets in client code, real personal data committed.
- Auth or session bugs that sign people out, let the wrong person in, or loop.
- Jobs that run twice, skip work silently, or hide a failure (a cursor that moves past unread mail, a cron with no alert).
- Workflow changes that widen permissions or run untrusted input.
- Docs or config that lie: a runbook step that no longer works, a config that points at the wrong project.
- Anything that breaks the live app.

## What does not count
- Style, naming, formatting, wording, refactors "for readability". Do not report them.
- Missing tests, unless the change touches one of the failure areas above.
- Generated files, fixtures, synthetic data, `archive/`, `work/`, lockfiles.

## How to write findings
- Every finding needs `file:line`. Never guess a filename.
- Tag each finding `new` (this change introduced it) or `pre-existing` (it was already there). A pre-existing finding never turns the verdict into FIX or BLOCK on its own; it goes to the lows backlog unless it is a live data or secret exposure.
- Report the CLASS of a bug once ("three RPCs miss a fixed search_path: a.sql:12, b.sql:40, c.sql:8"), not one finding per line, so one fix clears all of them.
- Do not re-report anything already listed in `docs/engineering/review-lows.md` or raised in an earlier review of the same change, unless this change makes it worse.
- End with one line: `Findings: N` (or `Findings: 0, no issues`).

## Convergence: 3 rounds, then stop
- A change gets at most 3 review rounds (first review plus 2 fix pushes). Rounds 2 and 3 review only what the fix push changed.
- If round 3 is still FIX or BLOCK, the fixer stops patching and brings the approach back to the owner to rethink. No round 4 without the owner's yes.
