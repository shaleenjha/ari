# GitHub repository secrets

| Secret | Used by | How to make it |
|---|---|---|
| `CLAUDE_CODE_OAUTH_TOKEN` | `.github/workflows/claude-review.yml`, `claude.yml` (both disabled at the sunset) | run `claude setup-token` with a Claude subscription, paste the token as ONE line (a wrapped copy broke it once) |

`ci.yml` and `repo-scan.yml` need no secrets (they use the built-in `GITHUB_TOKEN`).
