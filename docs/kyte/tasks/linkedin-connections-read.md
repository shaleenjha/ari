# LinkedIn connections read (weekdays 14:45 IST)

Read-only pass over the SDR's own "Recently added" connections list so new accepts are marked before the worker window opens. One page, list rows only, no profile opens, no clicks that change anything.

| | |
|---|---|
| Schedule type | `cron` |
| Schedule config | `{"expression": "45 14 * * 1-5", "timezone": "Asia/Kolkata"}` |
| Timezone | Asia/Kolkata (IST) |
| Credentials it uses | Google account that owns the Sheet; a browser session signed in to the SDR's own LinkedIn. |
| State at the sunset (Nov 3 2026) | paused |

## Notes for a rebuild

- This and the sent-invitations read are the only places the system looked at LinkedIn. The SDR approved them on Oct 26 2026 as read-only. LinkedIn's terms bar automated access, so decide for yourself before turning them on; the fallback is the Gmail ingest plus marking accepts by hand in the app.

## The prompt (scrubbed)

Copy this into the task, replace the `{...}` placeholders, and keep the rest as written.

```text
Daily READ-ONLY LinkedIn connections read for the SDR's Ari app (approved by the SDR Oct 26 2026: connections daily, sent invitations weekly). It runs at 14:45 IST so the Ari worker (starts 15:00 IST) drafts DM1 for new accepts.

STRICT: on LinkedIn never click Connect, Message, Withdraw, Like, Follow, Remove or anything that changes state, and never open profiles. One short pass only; do not retry the browser more than once.

1. Shell, project folder {PROJECT_DIR}, credentials [{"provider":"google","email":"{OWNER_GOOGLE_ACCOUNT}"}]: `python3 scripts/li_list_ingest.py since connections` prints STOP date (yyyy-MM-dd).
2. Browser, session_name "linkedin-shal", start_url https://www.linkedin.com/mynetwork/invite-connect/connections/ (signed in as the SDR; if signed out it signs in with the saved login). Task: make sure Sort by is "Recently added"; read rows top-down from the list only and return each as name | headline | profile URL | "Connected on <date>" text; stop at the first row connected before STOP date; cap 80 rows; read-only rules above.
3. Write the rows to work/li_lists/connections_<today>.json as [{"name","headline","url","date":"yyyy-MM-dd"}] (convert "Connected on October 25, 2026" to 2026-10-25; drop rows before STOP). Then run (same shell credentials): `python3 scripts/li_list_ingest.py apply connections work/li_lists/connections_<today>.json && python3 scripts/sync_sheet_supabase.py`.
4. Chat: stay silent if nothing was updated or new. Otherwise ONE line under 30 words: how many new accepts Ari marked (DM1 drafts follow from the worker) and how many new people wait for Lead or Personal in the app. If LinkedIn shows a security check, captcha or restriction, stop at once, do nothing more, and post one line saying so. Never message anyone.
```
