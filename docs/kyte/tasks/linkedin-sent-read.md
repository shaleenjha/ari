# LinkedIn sent invitations read (Mondays 14:30 IST)

Weekly read-only pass over the Sent invitations list to catch invites the SDR sent but forgot to tick in the app.

| | |
|---|---|
| Schedule type | `weekly` |
| Schedule config | `{"days": ["mon"], "time": "14:30", "timezone": "Asia/Kolkata"}` |
| Timezone | Asia/Kolkata (IST) |
| Credentials it uses | Google account that owns the Sheet; a browser session signed in to the SDR's own LinkedIn. |
| State at the sunset (Nov 3 2026) | paused |

## Notes for a rebuild

- Same LinkedIn caveat as the connections read.

## The prompt (scrubbed)

Copy this into the task, replace the `{...}` placeholders, and keep the rest as written.

```text
Weekly READ-ONLY LinkedIn sent-invitations read for the SDR's Ari app (approved by the SDR Oct 26 2026: connections daily, sent invitations weekly).

STRICT: on LinkedIn never click Withdraw, Connect, Message, Like, Follow or anything that changes state, and never open profiles. One pass only; do not retry the browser more than once.

1. Shell, project folder {PROJECT_DIR}, credentials [{"provider":"google","email":"{OWNER_GOOGLE_ACCOUNT}"}]: `python3 scripts/li_list_ingest.py since sent` prints STOP date.
2. Browser, session_name "linkedin-shal", start_url https://www.linkedin.com/mynetwork/invitation-manager/sent/ (People tab). Task: read rows top-down from the list only: name | headline | profile URL | "Sent X ago" text; stop once rows say "Sent 2 weeks ago" or older, cap 300 rows; read-only rules above.
3. Convert "Sent N days ago" to today minus N days, "Sent 1 week ago" to today minus 7 (approximate dates are fine); drop rows before STOP. Write to work/li_lists/sent_<today>.json as [{"name","headline","url","date":"yyyy-MM-dd"}], then run (same credentials): `python3 scripts/li_list_ingest.py apply sent work/li_lists/sent_<today>.json && python3 scripts/sync_sheet_supabase.py`.
4. Chat: stay silent if nothing was updated or new. Otherwise ONE line under 30 words: how many sends Ari had missed and how many new people wait for Lead or Personal. If LinkedIn shows a security check, captcha or restriction, stop at once and post one line saying so. Never message anyone.
```
