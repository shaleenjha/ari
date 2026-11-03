# How Kyte got built, and how it ended

Written Nov 3 2026, the day I shut it down. All times IST. Numbers are totals only, no people.

A note on names before anything else. This public repo runs every file through a scrub, so a couple of real names never show up here: my employer comes out as **Thrandvex** and one of Kyte's old product names comes out as **Kelvarrow**. If you see those in code or older docs, they're placeholders. I left them out of these pages on purpose.

## The short version

I'm an SDR. LinkedIn outbound was the part of my job where I kept dropping the ball, mostly follow-ups. So I built a system with Hark (my AI agent) that does all the prep: finds the accounts and people, drafts the messages, tracks who accepted and who replied, and tells me what to send tonight. I do the sending on LinkedIn myself, every single time. That was the rule from day one and it never changed.

It took about three weeks, Oct 13 to Nov 3 2026. It went through four names: Den, Ari, a bird name for a day, then Kyte. On Nov 3 I moved my LinkedIn work into the Claude setup I already use at work and shut Kyte down.

## Timeline

### Before v1: Outbound HQ (Oct 13 to Oct 15)
- **Oct 13, 14:07.** "I'd rather like an app." Open it, see what to do, do it from the phone, close it. Hark is the brain, the app is the face, a Google Sheet called Outbound HQ is the storage.
- **Oct 13.** Outbound HQ v1 was an Apps Script web app (Today, People, Accounts, Queue, Report). v2 the same evening moved to Vercel with Google sign-in.
- **Oct 13 to 14.** Mockups, a "Notion but fun" prototype, a dark dossier version. None of it felt like an app.
- **Oct 15, early morning.** Decided on no AI keys at all for now: Hark is the brain and chat answers come back in minutes, not seconds. First visuals got rejected for looking "webby". I asked for elite motion and elite typography. A house-with-rooms idea came and went within the hour.
- **Oct 15, 05:11.** Named it **Den**. A 13 question taste questionnaire set the rules: calm and precise, auto dark in US hours, numbers then a list, one accent colour, and padding that's actually correct (I'm a bit OCD about it).

### Oct 15: v1 to v16.2, seventeen builds in one day
Seventeen prototype builds went live between 05:58 and 20:29. The ones that mattered:
- **v1 to v2.** The calm instrument from the questionnaire. Then themes and a chat tab.
- **v3.** Den got a face: a dark pebble with eyes that changed as it worked. Full sentences instead of clipped lines.
- **v5.** The queue grouped by US send windows (Eastern, Central, Pacific mornings and afternoons).
- **v10.** Equal gutters, glass tab bar, three themes. Renamed **Ari** at 13:19.
- **v11 to v15.** Character and motion: one Ari component everywhere, a swipeable card stack, a real character design (ivory pebble, half-lidded eyes, a listening ring), one motion token system, a mouth "tongue and all", findable tricks, a What's new tour per build.
- **v16 (18:55).** "Ari is real." Installable PWA on real Sheet data, every tap writes to the Sheet, LinkedIn links open the Android app, offline outbox, Google sign-in.
- **v16.1 / v16.2.** Lead review (Lead or Personal), DM1 due the day someone accepts, idempotent writes, a passkey lock, iPhone parity.

### Oct 16: a real backend (v17 to v18.2.3)
- **v17 (08:25).** Supabase became the source of truth, with realtime updates, an outbox, web push, and a two-way sync that kept the Sheet as a mirror.
- **v17.1 to v17.5.** Polish pass, account pages, Undo everywhere. Account stages (Target to Opportunity, plus Hold, Customer, Closed lost, Not a fit) that Ari moves itself from events, with my own move always winning.
- **v18.** A real Report: one reporting layer, filters by period, AE and stage, tap any number to see exactly who's behind it.
- **v18.1.** Ari down to three faces (calm, working, done). I found the others annoying.
- **v18.2 "War room".** Account pages open on a brief to read (thesis, why now, where sensitive data moves, buying committee, angle), a quick check before you see drafts, one review card per account, every sent DM keeps its text.

### Oct 16 to 17: hardening and the team
- **v18.3.** Apps Script endpoint removed from the bundle, paging past the 1,000 row cap, honest loading states.
- **v18.5.** The worker stopped using the service key and got its own restricted role, `ari_worker`.
- **v18.6 / v18.7.** Nightly backup moved inside Supabase, encrypted offsite copy, health alerts, data hygiene checks.
- **v18.9 / v18.10.** Exec track: C-suite at bigger accounts get a note from my company's exec instead of my DM. Edit drafts in the app, with every edit kept for learning.
- **v18.11.** Ari's pick plus a one-tap switch on every draft. My product rule: whenever Ari decides something for me, show the next best option I can switch to.
- **v18.12.** Today became a send queue with a focus mode. Cold DM1 in 3 taps.
- **v18.12.1 (Oct 17, 22:25).** Last normal change to `web/ops.html`. After this the file was **frozen**: data-loss and security fixes only, each with a written reason and an md5 in `plans/base-lock.json`. New front end was supposed to go into `app/`.

### The team model
Hark ran this like a small company, with me as CEO and Hark as chief of staff. Agents were named roles, spawned per job.
- **Builders (FOLK ART):** Fuji (sourcing), Otto (inbox and alerts), Luca (release), Kavi (copy), Albert (docs and housekeeping), Raya (reporting), Tony (platform lead, the only one allowed to touch the front end).
- **Council:** review seats that never build. It started at 12 (product, security, design, motion, tests, platform, SDR reality, AE value, brand, investor, AI, critic). After an audit on Oct 17 it shrank to 5 permanent seats (security and RLS, platform, AI and attribution, SDR ergonomics, a critic who speaks last) plus one Craft seat for design, motion and copy. Tests became CI instead of a seat.
- **The standing rule (Oct 17):** the team builds Kyte, it never does Kyte's job. No hand-cleaning data, no hand-drafting prospect DMs. If the data needs fixing, build a check or a job that Kyte runs.
- **Outside auditor.** First Victor, a Gemini Flash agent, who pushed the freeze and the stage plan. On Oct 19 I scrapped Victor and made my personal Claude the auditor: read access to GitHub, Supabase (read-only) and Vercel, never writes. On Oct 24 that became automatic: a GitHub workflow filed a "Claude review" issue with PASS, FIX or BLOCK on every risky push, and Hark had to read it before deploying. By the end there were 80+ of those reviews.
- **Budget.** Hark's token pool was shared with everything else I use Hark for, so the Council set caps on Oct 17. The biggest win was the worker precheck: an idle 10-minute run became one shell call instead of six to eight.

### Oct 18 to 24: stages, CI and going public
- **Release stages.** Plain version numbers: 0.9 (the live `/ops`, locked), 1.0 (a rebuild in `app/`, read-only), 2.0 (writes move to the rebuild), 2.1 (jobs ported to TypeScript). The infra release train ran under "S1" and pushed its own build numbers (v18.15 to v18.17), so commit versions and app versions overlap. Sorry about that.
- **S1 releases R1 to R6** shipped: auth, deploy provenance gate, two-recipient encrypted backups, a Book prune guard, members needing a second factor, workspaces and dual RLS (0033 to 0038). **R7** (a token broker so the worker gets 1-hour tokens instead of a long-lived one) was built and tested but never went to prod.
- **CI.** Typecheck, unit, SQL tests on a prod-shaped database with every pending migration applied and rolled back twice, edge function tests, a design lint at 360/390/412 px on Chromium and WebKit, an anti-slop copy check, and a repo leak scan.
- **Oct 24.** The repo went public as a scrubbed export, after a firm rule: no prospect, employer, customer or private data in anything git tracks. The export allow-list, the scrub map and the leak scan came out of that.
- **Oct 24.** Security hardening on prod (0042, 0043): new tables closed to the public key by default, daily row counts with a drop alert, caller checks on definer functions.
- **The rebuild (`app/`).** A React PWA built beside the live app, on demo data, with its own design system. It went through a few looks (a warm "Lamp and Dawn" palette, then a "B+" shell on Oct 24).

### Oct 26 to 27: LinkedIn reads and point-first copy
- **Oct 26.** I approved two read-only scheduled passes over my own LinkedIn lists (connections daily, sent invitations weekly) to catch accepts and missed ticks. Nothing clicked, nothing opened.
- **Oct 27.** Profile scan before DM1: view one accepted person's profile, redraft DM1 from what they actually own. One at a time, five per batch, then rest.
- **Oct 27, point-first copy.** My complaint was that drafts hovered above the point and asked open questions. New rule: say the point as a statement (their workflow, the exact data, where it bites), what we do in under 10 words, one closed ask. DM2 is a real follow-up, DM3 is the close, then done. `copy_check.py` enforces it and a regen job rewrote every unsent draft that failed.

### Oct 28: direction reset
- I demoed Kyte to one of my AEs on a screen share. He loved the proactive part (signal scans on his accounts, tasks created) and asked how soon he could use it.
- My call afterwards: the live `/ops` design works and looks good, the `app/` redesign was a side step. **app2 work stopped.** Fix `/ops`'s flaws, make it feel like mature software without losing the character. The freeze got lifted build by build with my written OK each time.
- Same day: Report rebuilt with Day/Week/Month/Range and an AE picker, a quick find palette, plain-language labels (First message, Follow-up, Last note instead of DM1/2/3), and the bird-name rename shipped as v18.13.5. I found it hard to say. At 23:10 the same night it became **Kyte** ("like kite").

### Oct 29 to 30: Kyte
- **v18.14.2 (Oct 29).** Kyte by default for everyone: a folded kite K mark, the calmer pages look on by default, new icons and manifest.
- **v18.14.3 to v18.14.7.** A phone-first redesign behind a switch, default-path bug fixes from my phone check, push notification copy in plain words.
- **v18.14.8.** Retired the auto "withdraw old invites" feature.
- **v18.14.9.** One continuous chat that grows out of the search field, a stitched kite loader, a Fold icon set, menus removed. Deployed Oct 30.
- **AI layer.** A real model layer (edge function `kyte-ai`, Anthropic models, Parallel for fact checks) got built and stress tested on staging: 27/27 chat probes, 33/33 red team turns, about 3 seconds to first token, under a cent per answer. Migration 0041 went to prod with the budget switch **off**. The instant chat (0049 to 0051) never reached prod.
- **v18.14.10 (Oct 30).** New rule: Kyte never names Ari, Den, Hark or any vendor behind it. The decline line is exactly "I can't help with that here." This was the last version that went live.

### Oct 30 to Nov 2: the last builds
- **v18.14.11** (cross-device catch-up fix, and the "how I was made" story removed) and **v18.14.12** (Remove actually clears a reply from Today, no list redraw on names with apostrophes) were built, tested and committed, never deployed. v18.14.12 was blocked because the Claude review job started failing when my Claude subscription lapsed, then I said hold.
- **Nov 2.** Egress fix on the worker sync: delta reads, a local cache and gzip took one sync from about 4 MB to about 65 KB.

### Nov 3: sunset
Early morning I asked for Kyte to move in-house at work. The plan settled on no hosting at all: one spreadsheet as shared memory, run by the Claude I already use at work, LinkedIn reads by hand. By the afternoon I decided to shut Kyte down instead of maintaining two systems. Details in [sunset.md](sunset.md).

## Results (totals only)

- **By Oct 20 (all time):** 144 invites tracked, 72 accepts, 54 first messages, 36 follow-ups, 2 replies, 0 meetings.
- **Final handover, Nov 3 (work leads only):** 554 people. Where they stood: 370 invited and waiting, 32 not invited yet, 24 accepted and waiting on a first message, 15 at first message, 11 at follow-up, 32 at the last note, 8 replied, 62 stopped.
- **Events logged by then:** 581 sends (invites and DMs), 98 accepts, 9 replies, 1 decline.
- **Accounts:** about 1,300 accounts across three AE books, swept by nightly signal scans.
- **Meetings:** Kyte's own count stayed tiny (1 logged in week one). The real ones got tracked in my work tools, so there's no clean number here.

## What worked
- **The core loop.** A proactive find (a dated reason to reach out) plus one tap from the drafted message into LinkedIn. That combo is what sold the AE in the demo.
- **Follow-up timing.** DM1 the day they accept, DM2 about 4 days later, DM3 a week after DM2, then stop. Code owns the dates (`cadence.py`), not the model. Models drift on date math.
- **Code checks on copy.** `copy_check.py` caught way more than any prompt rule did.
- **Silent-by-default tasks with one precheck.** Cheap when idle, fast when there was work.
- **Locks that live in code** (`worker_lock.py`) instead of the model reading its own run history.
- **The leak gate.** Allow-list, scrub map, name scan, CI repo scan. Nothing real ever landed in the repo.
- **Backups that restore-test themselves**, every night, with an encrypted second-vendor copy.

## What didn't
- **Too many builds, too fast.** 17 builds in a day is fun but phones cached old shells and I kept seeing stale versions.
- **The freeze plus the rebuild.** Freezing `/ops` and building a parallel `app/` split the effort. A week later I went back to `/ops` anyway.
- **Process weight.** Council seats, relays to the outside auditor, stage gates. Useful for a team, heavy for one SDR.
- **Shared token pool.** Kyte's scheduled tasks ate into the same pool as everything else I do with Hark.
- **The 10-minute floor.** Chat answers through the worker took up to 10 minutes. The instant AI chat that would fix it never went live.
- **LinkedIn itself.** Its terms bar automated access, so the honest version depends on notification emails and me ticking things. Accept detection from email missed some.
- **Two systems.** I already had a Claude setup at work. Keeping a personal system for one channel didn't make sense long term.

## Lessons
- Write the rule once, in code, where the model can't skip it.
- One owner per file. Two agents on one object is how things get done twice.
- Show the pick and the next best option. It made trusting the drafts easy.
- Keep data out of the repo from the first commit, not after.
- Decide the boring stuff early: names, version numbers, where state lives.
- If a system needs me to approve everything anyway, make the approval one tap.
