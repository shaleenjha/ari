# Profile scan before DM1 (every 20 min in the window)

Before DM1 goes to someone who accepted, view that one person's profile read-only and redraft DM1 from what they own. One profile per run, 5 per batch, then a 2-hour rest; `scripts/profile_scan.py` enforces the pacing.

| | |
|---|---|
| Schedule type | `interval` |
| Schedule config | `{"minutes": 20, "timezone": "Asia/Kolkata", "window": {"days": ["mon", "tue", "wed", "thu", "fri"], "end": "03:59", "start": "15:00"}}` |
| Timezone | Asia/Kolkata (IST) |
| Credentials it uses | Google account that owns the Sheet; the worker database binding; a browser session signed in to the SDR's LinkedIn. |
| State at the sunset (Nov 3 2026) | paused |

## Notes for a rebuild

- Same LinkedIn caveat. It pauses itself on any security check or captcha.

## The prompt (scrubbed)

Copy this into the task, replace the `{...}` placeholders, and keep the rest as written.

```text
Profile-informed DM1 for the SDR's Ari app (approved by the SDR Tue 27 Oct 2026 19:51 IST). Before DM1 goes out to someone who accepted his LinkedIn invite, view that ONE person's LinkedIn profile read-only and redraft DM1 from what they actually own. Pacing (the SDR's rule): one profile at a time, at most 5 in a batch, then rest, then 5 more. scripts/profile_scan.py enforces it; never bypass it and never scan more than one profile per run.

STEP 1 (first and, when idle, only tool call). Shell, credentials [{"provider":"google","email":"{OWNER_GOOGLE_ACCOUNT}"}]:
cd {PROJECT_DIR} && python3 scripts/profile_scan.py next
If the output starts with IDLE, REST or WAIT: end the run at once, silently, no other tool call. Otherwise it is one JSON person (id, name, title, company, owner, linkedin_url, accepted).

STEP 2. Browser, session_name "linkedin-shal", start_url = that person's linkedin_url (signed in as the SDR; if signed out it signs in with the saved login). Task text: "View-only. Read this one profile: headline, current role title and its description, About, and up to 3 recent posts or reposts (date + one line each) if the Activity section shows them on the profile page. Do not open any other profile or page beyond this profile and its Activity tab. Never click Connect, Message, Follow, Like, Comment, More, or anything that changes state. If LinkedIn shows a security check, captcha or restriction, stop immediately and report it." If it reports a security check, captcha or restriction: post ONE chat line saying so, run `python3 scripts/profile_scan.py skip <id> blocked`, and end (do not try again; later runs will continue the queue, so also pause yourself with scheduled_task action update status paused on this task's own id and say in the line that profile scans are paused until the SDR says resume). If the profile is unavailable: `python3 scripts/profile_scan.py skip <id> unavailable` and end silently.

STEP 3. Save the findings (facts only, no copy of whole pages) to work/profiles/<id>.md and run `python3 scripts/profile_scan.py done <id> work/profiles/<id>.md`.

STEP 4. Redraft DM1. Load the skill {seller}-outbound and read plans/copy-lab/ae-styles.md in full; run `python3 scripts/copy_check.py arm <id>` for the AE style. Read the person's People row (Sheet "Outbound HQ" {SHEET_ID}, tab People; columns by header name: dm, notes, dm1_sent, research, next_action) and the account's hook. If dm1_sent is now set, stop silently. Write the point-first DM1: open "Thanks for connecting, <First>." or "<First>, quick one."; the point as a STATEMENT built from what the profile shows they own (their team's product or workflow + the exact sensitive data + where it bites); what we do in under 10 words; one closed ask ("Worth 15 minutes?" for AE 1, AE 3 or no-AE accounts; "Worth 20 minutes?" for AE 2); under 45 words (AE 2 50); no praise or summary of their profile, never mention that you viewed their profile or their posts unless a post is a real dated item worth naming; approved proof only; no dashes. If the profile adds nothing specific to their remit (generic headline, no role description), use the existing account or company signal instead. Write a switch alternative: the existing DM1 (if it passes) or the public-signal version. Check both with `python3 scripts/copy_check.py check <id> dm1 <file>` (PASS keeps; FLAG means redraft up to 2 times). Write the pick to People dm, research "Draft ready", next_action "Send DM1", and replace any older "Ari's pick (dm1)" V notes line with: "Profile scan: <yyyy-MM-dd>. Ari's pick (dm1): <AE AE 1 style|AE AE 2 style>. Switch to other angle: \"<alt text>\"". Save the alt to work/copylab/alts/<id>_dm1.json as [{"text": "...", "structure": "<style> other angle"}]. Tag per the worker's rules: work/tags/<id>_dm1.txt + .json, then `python3 scripts/draft_tag.py tag <id> dm1 work/tags/<id>_dm1.json --body-file work/tags/<id>_dm1.txt` with variant "arm=profile;alt=angle;trig=<0|1>" and hook_kind role_pain (or post_talk when a dated post is used).

STEP 5. Publish: `cd {PROJECT_DIR} && python3 scripts/sync_sheet_supabase.py; python3 scripts/focus_blocks.py` (same credentials). End silently.

Never send, connect, message, like, follow or withdraw anything; never touch dm1_sent, dm2_sent, dm3_sent; skip Hold, personal, exec-track and replied people (the script already does). Chat only for a LinkedIn security block.
```
