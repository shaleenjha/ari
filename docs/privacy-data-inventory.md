# Ari: what data it holds, where, for how long, and who processes it

*Inventory for Ari's privacy page, written from the code at `e4dafbb` plus Hark's read-only counts of 19 Oct 2026. Three kinds of gap are marked inline:*
- *[FILL IN]: a fact the repo can't settle.*
- *[TODAY] / [AFTER S1]: today the clocks in section 4 aren't running yet; they arrive with releases 6 to 8.*
- *Publish the [AFTER S1] lines only once they're live, or date them. The current page already says things that aren't true (V5).*

## 1. Whose data

| Who | Why Ari has it |
|---|---|
| **Prospects**: people at companies Owner targets | The whole point: Ari helps Owner research them and draft his LinkedIn messages. Owner sends every message himself. |
| **People who aren't prospects** | Owner's own LinkedIn contacts get caught along the way: rows marked personal, and LinkedIn emails from people Ari can't match. Ari keeps as little of them as it can (section 4). |
| **Thrandvex colleagues** | Account executives' names, as owners of accounts and leads. |
| **Owner** | His Google sign-in, his devices for notifications, his settings. |

**Sources:**
- **LinkedIn:** profiles Owner looks at and adds.
- **LinkedIn's own notification emails** in Owner's Gmail: invites accepted, replies, InMail text.
- **Public web research** by Ari's agent: company sites and news. Ari never uses LinkedIn, Apollo or Crunchbase pages as research sources (`0031:113`).
- **Thrandvex's account list** (the "Book").

**Not collected:** phone numbers, home addresses, personal email addresses. The email-draft table can hold a work email address. It's empty today (0 rows) [decide: drop the feature, or say "work email, only when Owner adds one"].

## 2. What Ari holds

| Kind | What exactly | Where it's kept |
|---|---|---|
| **Prospect profile** | Name, job title, company, LinkedIn profile link, role, the Thrandvex AE who owns the account, outreach stage and its dates (invited, accepted, messages sent, replied, meeting, withdrawn) | `people` |
| **Research notes** | Why this person, personal context Owner adds, notes (including Ari's suggested and alternative message text) | `people` |
| **Account briefs** | About the company: thesis, angle, why now, sources. About people: a buying-committee list with names, titles and likely objections. | `accounts`, `account_briefs`, `account_stage_history` (stage reasons can mention a first name) |
| **Messages to prospects** | Ari's drafts, Owner's edits, the exact text marked sent, labels describing each draft (angle, hook) | `people`, `sent_messages`, `draft_edits`, `draft_tags`, `copy_guidance` |
| **Replies from prospects** | Their reply text (up to 2,000 characters), LinkedIn headline, conversation link, Ari's suggested answers, Owner's answer. Taken from LinkedIn's emails to Owner's Gmail, or pasted by Owner. | `replies` |
| **LinkedIn email events** | For each "accepted" or "replied" email: the sender's name, profile link and time. Includes people who aren't prospects. 9 rows today, 4 of them unmatched. | `gmail_shadow_events`, `gmail_events` |
| **Work lists and history** | Requests to Ari and its results; a log of what happened, by person ID (and, before release 6, names); a record of every edit Owner made | `queue`, `log_entries`, `ops`, `hygiene_findings` |
| **Notifications** | The push messages sent to Owner's phone. Generic text since 17 Oct: "New reply on LinkedIn". The 94 older ones that name people are rewritten in release 6. | `notifications` |
| **Email drafts** | Recipient name and work email, subject, body. 0 today. | `emails` |
| **Owner's own** | Google sign-in identity, Gmail connection (the token lives in a locked vault), phone push endpoints, settings | `auth.*`, `gmail_connection`, `push_*`, `ari_prefs` |

## 3. Where the copies are

| Place | What's there | Protection | Until |
|---|---|---|---|
| **Supabase database** ("ari", Mumbai, India) | Everything in section 2 | Sign-in required. Only Owner's account can read. Two-step code once he enrols. | The clocks in section 4 |
| **Google Sheet "Outbound HQ"** (Owner's personal Google account, shared with nobody) | Prospects, research notes, drafts, work list, email drafts, history | Google account | [TODAY] Kept in sync. [AFTER S1, release 8] The file is deleted, along with its version history and the Drive trash. |
| **Nightly backups in Supabase** | A full copy, readable | Private storage, same access as the database | 14 nights |
| **Encrypted backups** (Supabase `ari-offsite` and Owner's Google Drive) | The same full copy, encrypted. [TODAY] One key opens it, held by Hark for restores. [AFTER S1, release 3] Owner's own key opens it too. | Encrypted (CMS, AES-256) | 14 nights |
| **Test project backup** (staging) | A full readable copy | Private storage | [TODAY] Exists. [AFTER S1, release 3] Wiped; test data only from then on. |
| **Hark's workspace** (the agent's working disk) | Database dumps, Sheet snapshots, draft alternatives | The agent platform | [FILL IN] Deleted after each maintenance session once the step is written into MAINTENANCE.md. |
| **AI agent transcripts** (Hark's platform) | What the agent reads while drafting: a prospect's reply, their profile and notes, and every message sent to them | [FILL IN: platform] | [FILL IN: platform retention] |
| **Owner's work inbox, and Slack via his work assistant "Wren"** | Daily report and exec-track handoff: names, titles, companies, LinkedIn links, connection-note text. Email drafts if any exist. | Thrandvex's Google Workspace and Slack | Thrandvex's retention rules [FILL IN] |
| **Owner's personal Gmail** | LinkedIn's own emails, which Ari reads. Ari doesn't create them. | Google account | As long as Owner keeps them |
| **Owner's phones** | app: today's list, kept 24 hours, wiped on sign-out. ops.html: an encrypted copy of the last load, plus unsent drafts and edits waiting to send. | Device lock and the app's own lock | app: 24 h. ops.html: until "Clear cached data", because sign-out doesn't clear it. Drafts 72 h. |
| **Phone notification services** (Apple, Google) | The generic notification text only | Their transport encryption | Delivery only |
| **Google's favicon service** | Company website domains, to show logos | n/a | n/a |
| **Supabase and Vercel logs** | Request addresses, which carry record IDs, not text | The providers | Short platform retention [FILL IN plan values] |

## 4. How long (decision A)

| Whose record | Kept until |
|---|---|
| Invited, never accepted | 30 days after the invitation is withdrawn. Owner withdraws at day 14. |
| Accepted, no reply | 6 months after the last activity. Any new message restarts the clock. |
| Replied, or a meeting was set | 12 months after the last activity |
| Anyone who asks to be deleted | Deleted right away from the database, then from the backups as they roll off (14 nights) |

**What "forgotten" means:** the name, title, profile link, notes, drafts and message text are removed. Ari keeps:
- the dates, for its counts;
- a keyed, one-way code of the LinkedIn profile link, so it doesn't contact the same person again too soon.

[Decide: may the time-based expiry keep that code, or only explicit opt-outs?]

**Side records:**

| Record | Kept | Status |
|---|---|---|
| Unmatched LinkedIn email events | 7 days | release 6 |
| All LinkedIn email events | 30 days | release 6 |
| Notification text | Generic text kept as long as the row exists | proposed: blank the text after 7 days |
| Edit records (`ops.payload`), finished work items, sent email drafts | Text removed | proposed: after 30 days |
| Resolved data-quality flags | Deleted, except dismissals (kept as IDs only) | proposed: after 30 days |
| Backups | 14 nights | everywhere, after release 3 |

[TODAY] None of the person clocks run yet; they arrive with the forget function after the Sheet is retired (release 8). Until then, records stay.

## 5. Who processes it

| Who | Role | What they see | Status |
|---|---|---|---|
| **Hark**: Ari's research and drafting agent | AI processing | Prospect profile, research notes, account briefs, a prospect's replies and every message sent to them, to draft the next one | **[FILL IN: model provider and its data terms]**. The repo doesn't name it. |
| **Wren**: Owner's work assistant (Claude, by Anthropic, under Thrandvex's account) | AI processing | The daily report and exec-track handoff in the work inbox. It posts the exec-track list to Thrandvex's Slack. | Thrandvex's arrangement |
| **Supabase** | Database and hosting (Mumbai) | Everything, encrypted at rest | Processor |
| **Google** | Sheet (until release 8), encrypted backups on Drive, Gmail (read-only access to LinkedIn's emails) | Sheet: everything in it. Drive: ciphertext only. Gmail: the mailbox. | Processor. Gmail access is under Google's restricted-scope rules [check "Limited Use", because Gmail-derived text goes to an AI]. |
| **Vercel** | Serves the app's pages | No prospect data, just static files | Processor |
| **Apple, Google push services** | Deliver notifications | Generic text | Processor |
| **Outside auditor** (Claude) | Reviews code and settings | Code, schema, counts and names of settings. Never prospect rows. | n/a |

## 6. Lines the current privacy page must change (V5)

- "Ari stores only parsed fields… does not store email bodies" isn't true. Reply text from LinkedIn's emails (up to 2,000 characters) is stored and given to an AI to draft answers.
- Add: research notes, account briefs, drafts and sent text, and AI processing (section 5).
- Add: where copies live (section 3) and how long they're kept (section 4), with the [AFTER S1] items dated.
- Add: how to ask for deletion (contact Owner), and what Ari can't reach: LinkedIn itself, Owner's own Gmail, and Thrandvex's inbox and Slack.
- Put `privacy.html`, `about.html` and `terms.html` in the repo, so the page is reviewed like code.
