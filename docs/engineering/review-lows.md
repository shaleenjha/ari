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
- [open] 1 | #50 | native/supabase/migrations/pending/0047_pipeline_jobs.sql (ari_pipeline_enqueue) | low (backlog): the Accepted tap can be blocked if the worker kick fails, because `perform ari_pipeline_kick()` runs inside the user's people write | wrap the kick in `begin ... exception when others then null; end;` (the 1-minute cron re-kicks)
- [open] 2 | #50 | native/supabase/migrations/pending/0047_pipeline_jobs.sql (ari_pipeline_brief_write) | low (backlog): the SQL brief check lacks brief_upsert.py's location words and "P.S." rule, though the comment says the rules match | add `Bengaluru|Bangalore|India| IST|P\.S\.` to the SQL check (same contract both sides)

- [open] 3 | #74 | native/supabase/functions/pending/_shared/ai/chat_guard.ts (SELF_OUT, selfLeak) | low (backlog): "den" / "ari" are banned as whole words in every chat answer, so a German or Dutch reply ("den Account") is replaced by the decline line (fails safe: nothing leaks, the answer is lost) | skip lowercase "den" followed by a lowercase word (or only ban the capitalised / standalone form) and add a German answer case to live_chat_round2_test.ts

- [open] 2 | #77 | native/supabase/functions/pending/ari-ai/chat_draft.ts:42 (findTarget) | low (backlog): with a pronoun and a person on screen, a named person whose lookup was refused (Hold, exec track, ...) carries no name, so the screen person wins: "write Zane a note, make it short" (Zane on Hold) drafts for the person on screen instead of declining (nothing saved without the tap; the card names the person) | keep the first lookup when it returned a refusal reason other than who or ambiguous; add a test

## Fixed
- [fixed in commit "Chat: fix review 76 lows in chat drafts" (6fa7c00, Oct 30 2026)] 2 | #76 | native/supabase/migrations/pending/0051_ai_chat_draft.sql (save after undo) | low (backlog): a save after an undo returned the first saved result | returns saved false, reason undone; a check
- [fixed in commit "Chat: fix review 76 lows in chat drafts" (6fa7c00, Oct 30 2026)] 2 | #76 | native/supabase/functions/pending/ari-ai/chat_draft.ts (findTarget) | low (backlog): a pronoun ask could match a first name in the message over the person on screen | screen person first unless the message holds a full name or a capitalised first name; two tests
- [fixed in commit "Chat: mask snapshot names in output guard" (Oct 30 2026)] 1 | #71 | native/supabase/functions/pending/_shared/ai/factcheck.ts:405, ari-ai/events.ts:67 | low (security): fact-check verdict / trigger detail stored the provider error text | HttpError.message is host + status only, provider text only on .detail and only run.ts errText (ledger) adds it; factcheck and events use safeErr ("provider <status>")
