# 05 Ingest labels (spec, Oct 27 2026)

Status: SPEC ONLY. No code, no migration, no deploy. Owner said "Go on" Oct 27 2026 20:40 IST to speccing this first.
Idea: label every outreach event once, when it comes in, so later readers (the outcome loop, a shared agent harness, a
read-only MCP for Owner's work Claude "Wren") read small labels instead of re-reading raw rows and message text
(plans/competitors/airspeed.md).

## 1. What changes, in one paragraph
One new append-only table, `app.events`. Every time something happens to a person (connect sent, accept, DM sent, reply,
meeting, withdraw, profile scan, signal found), the script that already records it also writes one event row with a
small `labels` object. Most labels are computed by code from data we already have. Only replies need judgement, and that
uses one cheap model call with a confidence score and a "needs review" flag. Existing tables and the app keep working
unchanged; events are written beside them.

## 2. Events and their labels
Every row has: `event_type, person_id, account_id, ae, occurred_at, approx, source, source_ref, labels, label_version,
labeled_by, confidence, needs_review`. `approx = true` when the time is a date-only or repaired value (same rule as
`people.ts_approx`, 0028). `persona` (title bucket, same rules as `retro_stats.py pers()`), `play` and `tier` are copied
into labels on every event so any slice works without a join.

| event_type | Written by (today) | Labels (all by code unless marked) |
|---|---|---|
| `connect_sent` | app tap, `li_list_ingest.py sent` | `with_note` bool, `note_tag_id` (draft_tags id), `weekday`, `hour_local` |
| `accept` | app tap (primary), `accept_ingest.py`, `li_list_ingest.py connections` | `days_to_accept` (accept minus connect_sent), `accept_via` tap / gmail / list |
| `dm_sent` | app Sent tap (sent_messages, 0031) | `step` 1 / 2 / 3, `draft_tag_id`, `structure`, `hook_kind`, `edited` bool, `words_changed`, `switched` bool (sent Ari's alternative, copy_switch), `asset` bool, `days_since_prev` (accept or previous DM), `late_days` vs dm2_due / dm3_due, `profile_scanned` bool |
| `reply` | `reply_ingest.py` (Gmail), paste in app | code: `reply_to_step` (last send before it), `credited_tag_id`, `days_since_touch`, `text_available` bool. Judged: `intent`, `objection_type`, `sentiment`, `next_step` |
| `meeting_booked` | app tap, account meeting fields | `touches_before`, `days_from_first_touch`, `credited_step`, `credited_tag_id`, `meeting_via` reply / ae / calendar |
| `withdraw` | app tap, follow-ups block | `days_pending`, `reason` auto_stale / manual |
| `profile_scan_done` | `profile_scan.py done / skip` | `outcome` scanned / unavailable, `recent_post`, `role_change`, `owns_problem` (bools), `dm1_redrafted` bool |
| `signal_found` | research and signal runs | `hook_kind` (draft_tags vocabulary), `signal_age_days`, `source_domain`, `used_in_draft` (set later by the draft tag) |

Reply vocabulary (extends the 0041 `TriageClassOut` enums so there is one list, not two):
- `intent`: interested, meeting, question, referral, not_now, objection, not_interested, unsubscribe, unknown.
  "Positive" in reports = interested + meeting + question + referral.
- `objection_type` (only when intent = objection or not_interested): has_vendor, build_in_house, no_need, timing, budget,
  security_review, wrong_person, other.
- `sentiment`: positive, neutral, negative. `next_step`: book, answer, send_asset, follow_up_later, route_referral, stop.

## 3. Who labels
- Code (deterministic): every label above except the four judged reply labels. `labeled_by = 'code'`, `confidence = 1`.
- Replies: one Haiku-class call returning the four judged labels plus `confidence` 0 to 1. Until migration 0041 is live,
  the worker labels the reply in the run where it already reads it to write the three reply drafts
  (`labeled_by = 'worker'`). When 0041 is live, its `triage_reply` step 1 returns the same fields (`labeled_by = 'haiku'`);
  no second call.
- needs_review: set when confidence is under 0.7, intent is unknown, or `text_available` is false (LinkedIn digest emails
  carry no text; the app already asks Owner to paste it). A paste re-labels the same row. A correction by Owner sets
  `labeled_by = 'shal'`, `confidence = 1`, `needs_review = false`, and is never overwritten by a model.

## 4. Where it is stored
One table, not new columns on people. Reasons: one place for every reader, labels can grow without a migration, and the
rebuild already plans one fact table (`app.metric_facts`) that this replaces.

```
app.events (workspace_id uuid, id bigint identity, event_type text check (8 values), person_id text, account_id uuid,
            ae text, occurred_at timestamptz, approx bool, source text, source_ref text, labels jsonb,
            label_version int, labeled_by text check (code|worker|haiku|shal), confidence numeric,
            needs_review bool, created_at, labeled_at;
            primary key (workspace_id, id); unique (workspace_id, event_type, dedupe_key))
```
- Lives in schema `app` in prod (the schema exists since E1, 0033), so the rebuild inherits it with no copy step. Same RLS
  shape as 0035: `is_owner() OR app.is_member(workspace_id)`; `ari_worker` writes only through one SECURITY DEFINER RPC,
  `ari_worker_event_record(...)`, which validates labels against the vocabulary for that event_type and rejects unknown
  keys and any string over 40 characters.
- `person_id` is the current text id (P-id). The rebuild maps it with the same legacy map as people (migration-map.md).
- Hot keys get expression indexes only when a report needs them (`labels->>'structure'`, `labels->>'intent'`).
- Rebuild file: `app/db/migrations/0006_events.sql`. Prod file: `native/supabase/migrations/pending/0044_event_labels.sql`
  plus rollback and `test/checks_after_0044.sql` (0039 to 0041 are still pending; 0044 does not depend on them).

## 5. Idempotency and backfill
- `dedupe_key` is the source's natural key: Gmail message id (accept, reply), `sent_messages.id` (dm_sent),
  `log_entries.id`, or `person_id:event_type:step` for one-per-person events (accept, withdraw, meeting). Re-running any
  ingest writes nothing new. Re-labeling updates `labels`, `label_version`, `labeled_at` in place.
- `label_version` starts at 1 and bumps when a vocabulary changes; a re-label job upgrades old rows in batches.
- Backfill (one idempotent script, `--dry` first, counts and P-ids only in output): people timestamps (connect_sent to
  withdrawn, with ts_approx as `approx`), `log_entries` (the Log, repaired Oct 18), `sent_messages` + `draft_tags` +
  `draft_edits` (step, tag, edited, switched), `gmail_events` (accept_via), `replies` (+ `ai_triage` where present),
  `signals/log.csv`, profile scan state. Queue rows are tasks, not outcomes, and are not backfilled. Where two sources
  disagree, the earlier non-approx time wins and the row is marked approx.
- Event writes are fail-soft: if the event RPC fails, the ingest still succeeds and a nightly reconcile (people
  timestamps vs events) writes what is missing.

## 6. What it feeds
- Outcome loop: one read-only view `app.event_outcomes`: each dm_sent with `replied_14d` and `positive_14d`, credited to
  the last send before the reply. Reply rate by structure, hook_kind, step, AE, persona, play, edited vs as-is, switched.
  Any slice under 20 sends shows "too few to call". The weekly copy read (`draft_tag.py stats`) moves onto it once its
  numbers match today's within one send.
- Accept rate by persona / note / weekday from `connect_sent` + `accept`.
- Future read-only MCP for Wren: a handful of RPCs over events only (outcomes_by, person_timeline, needs_review list),
  labels and ids, no names, no message text, read scope per member. Separate spec.

## 7. Privacy
Events hold enums, numbers, ids, dates and a source domain. Never message text, names, emails or LinkedIn URLs; the
validator enforces it. Reply text stays where it is today (`replies`), and the 0041 summary stays in `replies.ai_triage`.
Nothing new leaves the database; the model call reads only reply text that is already stored.

## 8. Cost
Code labels: free. About 40 to 80 events a day (roughly 35 connects, plus accepts, DMs, scans). Model labels: 1 to 5
replies a day at about 1,500 tokens in and 150 out; on Haiku 5.5 prices (router.ts) that is under $0.001 a reply, under
$0.10 a month. Backfill of past replies with text: under $0.10 once. Worker labeling before 0041 adds about 2k tokens per
reply to a run that already reads it. Storage: a few thousand rows a year.

## 9. Rollout (each step stops for Owner where marked)
1. Label code as pure Python functions (`scripts/event_labels.py`) with tests on synthetic data, and the backfill in
   `--dry` mode printing counts per event_type and per fault. No writes. **Owner's go to build.**
2. Migration 0044 + rollback + checks, rehearsed on the throwaway database and staging. **Prod needs a short-lived token
   (PAT) from Owner**, a fresh verified backup, then: stop the worker, migrate, run checks, start the worker.
3. Writers: each ingest script calls the event RPC after its existing write. Backfill for real. Reconcile job on.
4. Reply labeling in the worker run; needs_review rows listed by the worker. An app card for review is a separate UI
   build (Rook, Craft) with its own go.
5. `event_outcomes` view (a second small migration, same PAT routine) and the copy read switched over after a parity check.
6. Later: 0041 Haiku takes over reply labels; MCP spec.

## 10. Decisions for Owner
1. Reply labels before 0041 is live: worker labels them now (recommended) or wait for the Haiku path.
2. Table home: `app.events` in prod now so the rebuild inherits it (recommended) or a `public` table moved later.
3. Backfill depth: all history, older rows marked approx (recommended) or only from Oct 16 2026 when Gmail ingest started.
