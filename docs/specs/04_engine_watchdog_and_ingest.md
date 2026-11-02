# 04 Engine watchdog and ingest

## 1. Ingest root cause

Accept emails (15 of 122 LinkedIn emails):
- `invitations@linkedin.com`, labels `UNREAD,CATEGORY_SOCIAL,INBOX`, internalDate ms.
- Subject: one variant, `<FirstName> accepted your invitation, explore their network`.
- Full name only in the preheader `See <Full Name>'s connections, experience, and more`.

Verdict: no accept email was dropped.
- 15 of 15 are in People with `accepted` set (Oct 11 to 17: 8 of 8; Person A recorded 6 min after the email).
- The "none since Oct 12" belief comes from the Log. 3 of 4 Gmail accepts on Oct 16 and 17 were logged column-swapped (`"Accepted via Gmail" | P-id`), so `event='Accepted'` sees 1 of 4, and 11 of 15 have no Log row.
- Gmail shows no basis for 32 per week or 4 on Oct 16.
- LinkedIn emails few accepts (218 connects, 8 emails since Oct 11); section 4 covers the rest.

Latent defects:
1. The cursor follows any LinkedIn email (`1792255482` = the 22:14 job alert).
2. The precheck has `maxResults: 20` and no pagination.
3. Subjects carry first names only.
4. 4 of 15 `accepted` values are UTC dates.
5. No Log event vocabulary.

Patch (NOT applied; needs Owner's approval):

```diff
--- a/app/jobs/src/gmail/parse.ts
+++ b/app/jobs/src/gmail/parse.ts
-const LINKEDIN_FROM = /@([a-z0-9-]+\.)*linkedin\.com>?\s*$/i;
-const ACCEPT_SUBJ = [/^(.+?) accepted your invitation/i, /^(.+?) has accepted your invitation/i, /^You and (.+?) are now connected/i];
+const LINKEDIN_FROM = /<?\s*[^<>\s@]+@(?:[a-z0-9-]+\.)*linkedin\.com\s*>?\s*$/i;  // DKIM checked below
+export const ACCEPT_SUBJ = [
+  /^(.+?),? (?:has )?accepted your (?:LinkedIn )?(?:connection )?invitation\b/i,
+  /^You and (.+?) are now connected\b/i, /^(.+?) is now a connection\b/i,
+  /^(.+?) (?:a accepté votre invitation|hat Ihre Einladung angenommen|aceptó tu invitación)/i,
+];
+export const NOT_ACCEPT = /other people.s connections|I.d like to connect|role - \d+ connection/i;
+const FULLNAME = /See (.+?)(?:'|’|&#39;)s connections, experience/i;
@@ parseLinkedInEmail
-  let name = firstMatch(subj, ACCEPT_SUBJ);
+  let name = NOT_ACCEPT.test(subj) ? undefined : firstMatch(subj, ACCEPT_SUBJ);
   if (name) {
+    const full = decodeEntities(text + '\n' + (e.snippet ?? '')).match(FULLNAME)?.[1]?.trim();
+    if (full?.toLowerCase().startsWith(name.toLowerCase())) name = full;
--- a/scripts/worker_precheck.py
+++ b/scripts/worker_precheck.py
-    lst = gws(["gmail", "users", "messages", "list", "--params", json.dumps(
-        {"userId": "me", "q": "from:linkedin.com in:anywhere after:%d" % last, "maxResults": 20})])
-    newer = 0
-    for m in lst.get("messages", []) or []:
-        md = gws(["gmail", "users", "messages", "get", "--params", json.dumps(
-            {"userId": "me", "id": m["id"], "format": "minimal"})])
-        if int(md.get("internalDate", "0")) // 1000 > last:
-            newer += 1
+    newer = int(script("accept_ingest.py", "pending", "--since", str(last)) or 0)  # unseen accepts, all pages
```

New `scripts/accept_ingest.py` (Python regexes mirror `parse.ts`) replaces step 0 matching:
- Query `from:linkedin.com in:anywhere after:<cursor - 3600>`, `maxResults` 500, every `nextPageToken`; skip ids in `gmail_events`.
- `pending` counts unseen accepts; `scan [--since] [--backfill] [--dry]` matches by vanity, then unique full name, and records.
- Cursor: `max(internalDate)` of handled messages, frozen if any call failed.

```sql
-- 0032_accept_ingest.sql
create table if not exists public.gmail_events (msg_id text primary key, kind text not null, person_id text,
  event_at timestamptz not null, matched_by text);
alter table public.people add column if not exists accepted_source text;
create or replace function public.ari_worker_accept_record(p_msg_id text, p_person_id text, p_at timestamptz,
  p_how text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int; was timestamptz;
begin
  insert into gmail_events values (p_msg_id, 'accept', p_person_id, p_at, p_how) on conflict (msg_id) do nothing;
  get diagnostics n = row_count;
  if n = 0 or p_person_id is null then return jsonb_build_object('fresh', n > 0); end if;
  select accepted into was from people where id = p_person_id;
  update people set accepted = case when accepted is null or 'accepted' = any(ts_approx) then p_at else least(accepted, p_at) end,
    accepted_source = 'gmail', ts_approx = array_remove(ts_approx, 'accepted'),
    stage = case when coalesce(stage, '') in ('', 'Mapped', 'Connect sent') then 'Accepted' else stage end
  where id = p_person_id;
  if was is null then insert into log_entries(ts, person_id, event, detail) values (p_at, p_person_id, 'Accepted', 'gmail'); end if;
  return jsonb_build_object('fresh', true, 'new_accept', was is null);  -- push only if new_accept and not --backfill
end $$;
-- revoke from public, anon, authenticated; grant execute to ari_worker
```

## 2. Backfill (14 days)

1. `accept_ingest.py scan --since <now-14d> --backfill --dry` prints match counts.
2. Owner reviews unmatched lines.
3. Rerun without `--dry`: `msg_id` dedupes, `least()` fixes UTC dates, no push or research.
4. Rewrite Log rows where `event ~* '^accept'` or `person_id !~ '^P\d+$'` to the fixed vocabulary (`Connect sent, Accepted, DM1 sent, ... Meeting set`, source in `detail`).
5. Set `gmail_last_scan` to the max recorded `internalDate` in seconds.

## 3. Scan dead-man's switch

```sql
create table if not exists public.scan_runs (id bigserial primary key, book text not null,
  trigger text not null default 'scheduled', started_at timestamptz not null default now(), finished_at timestamptz,
  last_scan_at timestamptz, accounts_scanned_count int, error text,
  status text not null default 'running' check (status in ('running','ok','empty','error')));
-- index (book, started_at desc); RLS owner_read select, as scan_heartbeat

create or replace function public.ari_worker_scan_start(p_book text, p_trigger text) returns bigint
language sql security definer set search_path = public as $$
  insert into scan_runs(book, trigger) values (p_book, p_trigger) returning id $$;
create or replace function public.ari_worker_scan_finish(p_id bigint, p_accounts int, p_last timestamptz, p_error text)
returns void language sql security definer set search_path = public as $$
  update scan_runs set finished_at = now(), accounts_scanned_count = p_accounts, last_scan_at = p_last, error = p_error,
    status = case when p_error is not null then 'error' when p_accounts = 0 then 'empty' else 'ok' end where id = p_id $$;
-- both: revoke from public, anon, authenticated; grant execute to ari_worker

-- alert: no scheduled start for 2 slots + 5 min, or last 2 runs empty/error
create or replace function public.ari_scan_deadman() returns jsonb language sql stable security definer set search_path = public as $$
  with v as (select book,  -- 25 min = 2 x 600 s + 5 min
      max(started_at) filter (where trigger = 'scheduled') < now() - interval '25 minutes' as missed,
      (select count(*) = 2 and bool_and(status in ('empty','error')) from (select status from scan_runs r
         where r.book = b.book and finished_at is not null order by started_at desc limit 2) t) as empty2
    from scan_runs b where started_at > now() - interval '7 days' group by book)
  select coalesce(jsonb_agg(to_jsonb(v)) filter (where missed or empty2), '[]') from v $$;
```

The scheduled sync and worker step 0 call `ari_worker_scan_start` first and `ari_worker_scan_finish` in `finally`, via `ari_db.rpc()` as `ari_worker`.

Hooks:
- `ari_health()` adds `'deadman', public.ari_scan_deadman()`.
- `ari_health_alert()` (pg_cron, every 15 min): when `h->'deadman'` is non-empty, `ari_notify('ops_alert', 'ops:deadman:'||slot, ...)`.
- `health_check.py`: `if h.get('deadman'): problems['deadman'] = 'scan dead-man'` prints the Hark chat `ALERT:`.
- Needs 0026 (still PENDING) applied first.

## 4. Manual fallback loop

A Today queue Accepted tap writes `stage='Accepted'`, `accepted_source='manual'`, Log `Accepted | manual`, and `accepted` = the given time or the bare date (the 0028 trigger then sets noon IST and adds `'accepted'` to `ts_approx`).

The worker picks up (`accepted_no_dm`):

```sql
select id from people where stage = 'Accepted' and coalesce(dm, '') = '' and coalesce(review, '') in ('lead', '')
  and coalesce(research, '') not in ('Draft ready', 'No signal yet', 'Flagged, no draft') and deleted_at is null;
```

Each gets research and a DM1 draft next run, time or not.

A later parser hit finds `accepted` set: no Log row, no push, no research; exact email time replaces an approximate one.
