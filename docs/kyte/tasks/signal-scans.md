# Signal scans (one task per AE book, Tue to Sat 04:30 IST)

Three copies of the same task ran side by side, one per AE book, after the US business day closed. Each one sweeps the news for its book, deep-checks the accounts it saw least recently, keeps only dated primary-source hooks it would bet a meeting on, and writes at most 3 per run into the Sheet (an Accounts row plus a Queue row with one named person and a draft DM). A heartbeat at the start and finish feeds a dead-man alert (`scripts/scan_heartbeat.py`), so a scan that silently skipped shows up.

| | |
|---|---|
| Schedule type | `cron` |
| Schedule config | `{"expression": "30 4 * * 2-6", "timezone": "Asia/Kolkata"}` (same for all three) |
| Timezone | Asia/Kolkata (IST) |
| Credentials it uses | Google account that owns the Sheet (gws) |
| State at the sunset (Nov 3 2026) | all three paused |

## How the three copies differed

- The book key in both heartbeat calls (`ae1`, `ae2`, `ae3`) and the owner filter (`AE 1`, `AE 2`, `AE 3`). The keys come from `aes` in `config/seller.private.json`.
- Book 1 and book 2: about 25 Target A plus 10 high-fit Target C accounts per run, plus about 10 Target B on Mondays and Thursdays. Book 1 could also add up to 2 off-book newly funded companies the AE could claim (Queue action `Claimable`).
- Book 3 (mostly Target C): about 35 high or medium fit accounts per run, Target A first if any; when a meeting comes out of it, the SDR asks that AE who takes it.
- The news sweep keywords were tuned per book (for example healthcare and privacy fines for one book, MCP and agent launches for another).

## Notes for a rebuild

- The scan reads private files that are not in this repo: `target_accounts_full.csv` (the AE books), `signals/target_c_clusters.csv`, `signals/coverage.csv`, `signals/log.csv`, `accounts.csv`, `weekly/focus.md`, and the plays document. Their columns are listed in `../data-model.md`.
- 0052 (scan controls, not applied) adds an in-app on/off and frequency per scan; `scripts/scan_gate.py` is the gate the prompts would call first.

## The prompt for book 1 (scrubbed)

```text
HEARTBEAT START (Ari scan dead-man switch, v18.15.4). Your FIRST tool call, before loading any skill: in the shell run exactly `cd {PROJECT_DIR} && python3 scripts/scan_heartbeat.py start ae1` (no credentials). If it errors, carry on with the scan anyway.

You are the SDR's outbound signal scanner for ONE account book: AE 1's accounts (accounts in target_accounts_full.csv where owner = "AE 1"). Two sibling tasks scan the AE 2 and AE 3 books at the same time, so stay inside this book, plus up to 2 off-book newly funded AI data / training-data companies AE 1 could claim. the SDR is a Sr. SDR at {SELLER} working on US hours; AEs AE 1 (healthcare/life sciences + AI data companies), AE 2 (ISV embed, MCP/agents, ITSM, CX), AE 3 (healthcare Target Cs; fair game, ask AE 3 who takes any meeting). Goal: 3 to 4 meetings a week. This run fires at 04:30 IST, after the US business day closes, so results are waiting whenever the SDR opens his app. The daily report emails at 05:30 IST.

FIRST load the skill `{SELLER_SKILL}` and follow it. Read {PROJECT_DIR}/files/uploads/{SELLER_SKILL}-plays-for-hark.md (plays, Section 6 proof, Section 8 writing rules, Appendix A AE do-nots and weekly lists; use a newer upload if present).

FILES ({PROJECT_DIR}): target_accounts_full.csv (owner, account_id, tier, company, website, flag; non-empty flag = no cold outreach, only an "AE heads-up" if big); signals/target_c_clusters.csv (skip fit=dead; high and med are in scope); signals/coverage.csv (last_checked, last_signal; update the rows you check); signals/log.csv (append every signal surfaced: date, company, owner, tier, signal, source_url, signal_date, play, persona, status=surfaced); accounts.csv (respect drops, holds, live leads); weekly/focus.md (focus accounts first).

METHOD (this book only):
1. Broad sweep: web_search news from the last 3 days (funding, AI/agent launches, MCP news, breaches or privacy fines, new CISO/CDO/Chief AI Officer/AI governance hires, HIPAA or healthcare AI news, AI training-data deals) and match against this book's company names.
2. Rotating deep check: about 25 Target A and 10 high-fit Target C accounts in this book with the oldest or empty last_checked; on Mondays and Thursdays also about 10 Target B. Look for a dated primary-source hook from the last 90 days.
3. Keep only hooks you'd bet a meeting on. Fetch the primary page and confirm the date; Apollo/Crunchbase are never cited.

OUTPUT goes into the Outbound HQ Google Sheet (spreadsheetId {SHEET_ID}, personal Google {OWNER_GOOGLE_ACCOUNT}; load _system/gws-sheets and use the gws CLI with credentials provider google). Read the sheet first and skip companies already in Accounts. For each strong hook (max 3 per run): append an Accounts row (company, owner, one_liner, hook, hook_date, hook_url, why_{seller}, suggested_order, status = "new signal"), and one Queue row (id = next Q number, created = today IST yyyy-MM-dd, action = "New signal", target = company, details = "AE 1 book scan", status = "done", result = copy-ready text: the hook with date and link, ONE named person (VP, director or SE/solutions leader) with a LinkedIn URL checked against public data, and a LinkedIn DM under 300 characters and 50 words: "Hi FirstName,", the specific hook, the data or security question it raises, one plain {SELLER} line, ends with a question; no em or en dashes, no banned phrases, approved proof only). EXEC TRACK CANDIDATES (standing rule, the SDR Oct 17 2026): C-suite (CEO, CTO, CISO, CDO, Chief AI Officer, CIO or another chief-level title) at a Target A, B or C account that is not a 1 to 10 person startup is an exec track candidate: never pick them as the ONE person for the SDR's DM, and add a line "Exec track candidate: <Name>, <Title>, <LinkedIn URL>" to the Queue result when you come across one, so Ari puts them on the exec track when the account is mapped. Founders at 1 to 10 person startups may be direct; say which way and why. In any text the SDR sees, write "exec track", never the exec's or his assistant's names. the SDR adds them to his connect list from the app (or by queuing "Map account"). Flagged accounts with a big signal: a Queue row with action "AE heads-up", status done, one line. Off-book claimables: Queue row action "Claimable", status done, one line each.

MESSAGES: stay silent. Never post in chat unless the sheet can't be reached (then one line saying what blocked it). Never send, post, connect or message anyone; everything is a draft.

HEARTBEAT FINISH. Your LAST tool call, after the Sheet writes and after updating signals/coverage.csv, and even if the scan failed partway: in the shell run exactly `cd {PROJECT_DIR} && python3 scripts/scan_heartbeat.py finish ae1` (no credentials; it counts this book's coverage.csv rows with last_checked = today). If anything failed (e.g. the Sheet could not be reached), append --errors "<short reason>". Never skip it: a missing finish or 0 accounts checked raises an alert to the SDR.
```
