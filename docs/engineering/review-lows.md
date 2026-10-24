# Claude review lows backlog

Rule (owner decision, Oct 24 2026): high and med are fixed before the next deploy, and so is any low touching data exposure or secrets ("low (security)"). Every other low ("low (backlog)") is listed here. A weekly task fixes the one that matters most and asks Claude to review it.

Format: one line per low: `- [open|fixed <sha>|wontfix: reason] <priority 1-3> | <issue #> | <file:line> | <what> | <smallest fix>`
Priority: 1 = could break a backup, deploy or rollback, or hides a failure; 2 = test or check gap; 3 = docs or wording.

## Open
- [open] 1 | #29 | native/supabase/functions/pending/DEPLOY_SECRETS.md | a 503 from the nightly backup cron has no documented meaning and no alert | add the 503 = rotate both secrets line; alert on non-2xx from the cron job
- [open] 2 | #29 | native/supabase/functions/pending/ari-backup/index.ts:210 | 503 "not configured" is returned before the header compare, so an outsider can tell if the function secret is set (config state, not the secret) | compare the header first, 503 only after a match
- [open] 2 | #24 | native/supabase/migrations/pending/test/run_local.sh | archive grant check does not cover every future custom role | (mostly covered by the non-owner grants check added in 84e255a; confirm and close)
- [open] 3 | #27 | native/supabase/functions/pending/ari-backup/index.ts | drift log line is emitted per request; a cron retry loop could flood logs | log once per cold start
- [open] 3 | #29 | native/supabase/functions/pending/DEPLOY_SECRETS.md:7 | smoke-check cell is a run-on | split into pass and fail criteria

## Fixed
