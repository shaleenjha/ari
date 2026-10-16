#!/usr/bin/env bash
# Keel: commit + push a scrubbed, code-only snapshot to the private GitHub repo.
# Run at the end of EVERY deploy:   bash scripts/git_sync.sh "v18.4: short summary"
#
# 1. scripts/git_export.py copies the allow-listed code into the export tree,
#    replaces real names with placeholders (private scrub map, never committed),
#    and scans for secrets / real names. Any finding aborts: fix the source or
#    add a rule to the scrub map, never commit around the scan.
# 2. Commits locally in the export tree (message must be "vX.Y: summary").
# 3. Pushes to the private repo through the GitHub connector (scripts/git_push_api.py,
#    git data API), because the sandbox holds no git credentials.
#    Agents run step 3 in a shell call with credentials [{"provider":"github"}].
# Never make the repo public. Never add data, CSVs, drafts, plans or screenshots.
set -euo pipefail
MSG="${1:?usage: git_sync.sh \"vX.Y: summary\"}"
[[ "$MSG" =~ ^(v[0-9]+(\.[0-9]+)*|phase[0-9]+):\ .+ ]] || { echo "message must look like 'vX.Y: summary' or 'phaseN: summary'"; exit 1; }
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export KEEL_DIR="${KEEL_DIR:-$ROOT/work/keel}"
export KEEL_EXPORT="${KEEL_EXPORT:-$KEEL_DIR/ari-app}"
python3 "$ROOT/scripts/git_export.py" --refresh-names
cd "$KEEL_EXPORT"
[ -d .git ] || git init -q -b main
git add -A
if git diff --cached --quiet; then echo "nothing to commit"; else
  git -c user.name="Owner" -c user.email="36487118+shaleenjha@users.noreply.github.com" commit -q -m "$MSG"; fi
python3 "$ROOT/scripts/git_push_api.py" "$KEEL_EXPORT"
