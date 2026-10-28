# Runbook: draft assumptions (G12), v18.13.8, Oct 28 2026

Spec: plans/assumptions-to-confirm.md (Owner chose option C, Oct 28 13:32 IST). Status: **staging only**. Production has no
`queue.assumptions` column and the worker does not run this contract until Owner says go (needs migration 0046 on prod with a
fresh PAT, then the ae-styles.md line flipped to LIVE, then scripts/assumptions_store.conf set to `on`; it ships `off`).

## What it is
Every draft (DM1, DM2, DM3, connect note, exec note) carries a short list of the facts in it that have no written source:
names, titles, numbers, dates, events, customer names, claims. Owner confirms, edits or strikes each one under the draft.
Nothing is ever written into the copy itself.

Item shape (JSON, stored in `queue.assumptions`):
`{"id": "<10 hex>", "text": "<exact phrase>", "kind": "name|title|number|date|event|customer|claim", "source": "drafter|checker", "status": "open|confirmed|struck|edited"}`

One queue row per draft: `id = AS:<person_id>:<kind>`, `action = "Draft assumptions"`, `target = <person_id>`,
`details = <kind>`, `status = "done"`, `result = "<n> to confirm"`. The app hides these rows from every task list and the
sync never copies them to the Sheet.

## Drafter contract (the worker)
1. Write the draft as today (People column, alt file, V notes pick line, tags). Nothing about the draft itself changes.
2. Write every fact in the draft that you did not read in a written source (People row, account hook or research, the account
   brief, emails, what Owner already sent or told you) to `work/assumptions/<person_id>_<kind>.json`:
   `[{"text": "<exact phrase as it appears in the draft>", "kind": "<kind>"}]`. Use the exact words from the draft so Strike
   can find them. An empty list `[]` is fine. Kinds: name, title, number, date, event, customer, claim (anything else becomes claim).
3. Run the mandatory check with the list:
   `python3 scripts/copy_check.py check <person_id> <kind> <draft.txt> --assumptions work/assumptions/<person_id>_<kind>.json --store`
4. PASS / FLAG works exactly as before (G12 never flags and never changes the exit code). The line before the verdict,
   `ASSUMPTIONS <n>: [...]`, is the union of your list and G12's. A line `NOTE assumptions not stored (...)` means storage is off
   or failed; the draft still stands.
5. Only the pick is stored (the text in the People column). Do not store the switch alternative.

## Checker (G12, scripts/assumptions.py)
- Extracts dates (month day, ISO, quarters, years, "last week"), numbers (digits, %, $, spelled counts), titles (VP, Head of X,
  Chief X Officer...; "your CISO" style generic roles are skipped), events (HLTH 2026, Summit/Conference names, trigger-verb
  clauses like "raised a Series B"), customer names in proof context ("(X handles it)", "teams like X", "X uses us") and other
  proper nouns. The fixed guide lines and the closing ask are skipped.
- Sources: the people row, already-sent DMs, the account row, account_briefs, research, sent_messages, replies, Owner's Chat
  rows about the person, emails at the account, work/profiles/<pid>.md, Section 6 of the plays doc, and every item Owner
  confirmed for this person before.
- Approved customers (seller settings) count as sourced. An unapproved or never-name customer stays a hard G2 fail in copy_check.
- Known limit: a single capitalised word that opens a sentence and is not followed by a comma or possessive (for example a
  company name) is read as an ordinary word. The prospect's own company is sourced anyway; the drafter list covers the rest.

## Union rules
Drafter items come first. Same or contained phrases are one item; if either side is a hard kind (number, customer) the item
stays hard. Owner's earlier status carries over by item id (a hash of the phrase). A struck or edited phrase that comes back in
a redraft is open again. Confirmed items stay on the row as sources. At most 60 items per row (constraint).

## The app (web/ops.html, module v18.13.8)
- Flag: `app_config` key `assumptions_ui` = `true` shows it; missing or anything else hides everything. Staging has it on
  (work/oct28/assumptions/staging_seed_flag.sql); prod has no row, so prod shows nothing even if this ops.html ships.
- Under each draft block (Today card and person file): "N to confirm" with a coral dot when N > 0. Tap opens chips: Confirm,
  Edit, Strike. Confirm stores `confirmed`. Edit puts the cursor on the phrase in the draft field. Strike removes the phrase,
  saves the draft through the normal edit path and re-runs the in-app checks (open list against the new text, dashes, one
  question). The full copy_check re-run happens on the worker's next check of that draft.
- Option C: Copy (block Copy, card Copy & open, person file Copy & open, focus mode) is off while an open number or customer
  item remains. Other kinds only count.

## Off switch and rollback
Hide: set `assumptions_ui` to `false` (or delete the row). Storage off: put `off` in scripts/assumptions_store.conf (ARI_ASSUMPTIONS_STORE=1 is a one-run override only). Schema:
`native/supabase/migrations/pending/0046_draft_assumptions_rollback.sql` (refuses while Owner's confirmed/struck items exist unless
`set ari.allow_drop_assumptions = 'yes'`).
