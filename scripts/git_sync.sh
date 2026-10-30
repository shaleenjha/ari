#!/usr/bin/env bash
# Keel: commit + push a scrubbed, code-only snapshot of Kyte to the public GitHub repo named in scripts/keel_repo.conf
# (shaleenjha/ari until Owner renames it; then change that one line, see docs/engineering/code-names.md).
# Run at the end of EVERY deploy:   bash scripts/git_sync.sh "Area: what changes"   (e.g. "Docs: rewrite README")
#
# 1. scripts/git_export.py copies the allow-listed code into the export tree,
#    replaces real names with placeholders (private scrub map, never committed),
#    and scans for secrets / real names. Any finding aborts: fix the source or
#    add a rule to the scrub map, never commit around the scan.
# 1b. Pull first (v18.17.10): scripts/git_pull_remote.py brings commits made on GitHub since our last push
#    (web edits, merged @claude PRs) into the project source, applies remote deletions, and stops with
#    "conflict: <paths>, resolve first" (exit 1, nothing pushed) when a path changed on both sides.
#    Then the export is rebuilt so the pulled files are in the commit.
# 2. Commits locally in the export tree. Title must be "Area: what changes" (one or two words, capitalised, see
#    docs/engineering/commit-convention.md); the older "vX.Y: summary" and "phaseN: summary" still pass.
#    A body may follow the title after a blank line.
# 3. Pushes to the repo through the GitHub connector (scripts/git_push_api.py,
#    git data API), because the sandbox holds no git credentials.
#    It refuses unless remote main is still the commit step 1b synced to; it never forces.
#    Agents run steps 1b-3 in a shell call with credentials [{"provider":"github"}].
# The repo is public (Owner, Oct 24 2026): the export scan is the only gate. Never add data, CSVs, drafts, plans or screenshots.
set -euo pipefail
MSG="${1:?usage: git_sync.sh \"Area: what changes\" (or \"vX.Y: summary\")}"
[[ "$MSG" =~ ^((v[0-9]+(\.[0-9]+)*|phase[0-9]+)|[A-Z][A-Za-z0-9]*( [A-Za-z0-9]+)?):\ .+ ]] || { echo "title must look like 'Area: what changes' (e.g. 'Docs: rewrite README'), or the older 'vX.Y: summary' / 'phaseN: summary'"; exit 1; }
TITLE="${MSG%%$'\n'*}"; (( ${#TITLE} <= 72 )) || { echo "title is ${#TITLE} chars; keep it to 72 or fewer (docs/engineering/commit-convention.md)"; exit 1; }
! grep -qi "^Co-Authored-By:" <<<"$MSG" || { echo "no Co-Authored-By trailers (docs/engineering/commit-convention.md)"; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export KEEL_DIR="${KEEL_DIR:-$ROOT/work/keel}"
export KEEL_EXPORT="${KEEL_EXPORT:-$KEEL_DIR/ari-app}"
python3 "$ROOT/scripts/git_export.py" --refresh-names
PULL_OUT="$(python3 "$ROOT/scripts/git_pull_remote.py" "$KEEL_EXPORT")" || { echo "$PULL_OUT"; echo "git_sync: pull refused, nothing pushed"; exit 1; }
echo "$PULL_OUT"
if grep -q '^PULLED_FILES=' <<<"$PULL_OUT"; then python3 "$ROOT/scripts/git_export.py"; fi
cd "$KEEL_EXPORT"
[ -d .git ] || git init -q -b main
git add -A
if git diff --cached --quiet; then echo "nothing to commit"; else
  git -c user.name="Owner" -c user.email="36487118+shaleenjha@users.noreply.github.com" commit -q -m "$MSG"; fi
python3 "$ROOT/scripts/git_push_api.py" "$KEEL_EXPORT"
