# Ari restore runbook (v18.6, Oct 17 2026)

Prod project: `ari` (rbkrqlzlblquvgmuohro). Staging: `ari-staging` (ljojwhnfgfreokqspobg).
Owner auth uid: b14d1605-c766-4684-9a5b-71ffcab6967b.

## What a backup is
- Nightly at **03:00 IST** pg_cron job `ari-nightly-backup` calls `public.ari_backup_kick()`, which posts to edge function `ari-backup`.
- One gzip JSON per night, `ari_<YYYYMMDD>T<HHMM>Z.json.gz`, in the **private** bucket `ari-backups` of prod (14 kept) and a copy in the private bucket `ari-backups` of ari-staging.
- Keys inside the JSON: `public.<table>` (every public table, rows as JSON), `auth.users`, `auth.identities`, `supabase_migrations.schema_migrations` (ledger with DDL statements), plus function definitions, policies and cron jobs.
- **Not in the backup**: `auth.mfa_factors` / `auth.mfa_challenges` (two-step factors), sessions and refresh tokens, storage objects, vault secrets (ari_backup_hook_secret, push keys), edge function code and env (code is in native/supabase/functions/), Vercel config.
- Every run restore-tests itself; status: `python3 scripts/backup_check.py` (exit 0 = newest run < 26 h old, verified, off-project copy written).

## Who can restore
Maintenance session only (Forge), with the Supabase Management token bound for that session. Normal Hark runs (worker, sync, backup check) cannot read the bucket: ari_worker gets 400 on storage and 403 on backup_runs, by design.

## 0. Decide the scope
| Situation | Do |
|---|---|
| A few rows wrong or deleted | Section 3 (single-table restore into prod) |
| Prod data broadly corrupted, project alive | Sections 1 to 4 into prod, after a fresh backup of the bad state |
| Prod project gone | Section 5 (new project), then 1 to 4 |
| Prod bucket gone or untrusted | Take the object from ari-staging's `ari-backups` bucket instead |

Always first: pause writers so they don't fight the restore. Pause tasks e8fbd86f (worker) and 56e17ef1 (sync) with scheduled_task update status=paused, and note the times. Leave the Sheet untouched: after the restore the sync would otherwise re-push Sheet values over restored rows; decide per incident which side is the truth.

## 1. Pick and rehearse
1. `python3 scripts/restore_drill.py` (newest object) or `python3 scripts/restore_drill.py ari_20261016T2138Z.json.gz`.
   It loads the object into a throwaway local Postgres 17 (schema from the newest pg_dump in work/backups or native/supabase/baseline) and writes `work/backups/drill_<object>.json` with counts only.
2. Proceed only if `mismatches` is `{}` and `rows_restored == rows_backup`. Last drill: 33/33 tables, 2,305/2,305 rows.
3. Snapshot the current (bad) state first: run the edge function once (`select public.ari_backup_kick();` as postgres) so the pre-restore state is itself recoverable.

## 2. Schema
- Existing prod: schema is already there; check `select max(version) from supabase_migrations.schema_migrations` matches the backup's ledger. If the backup is older than a migration, restore data into the current schema (columns added later get defaults) or roll the migration back first (native/supabase/rollbacks/).
- New project: apply native/supabase/baseline then migrations 0001 to 0024 in order, recording each in the ledger (or replay the `statements` from the backup's `supabase_migrations.schema_migrations` in version order). Then recreate role ari_worker (0018), the pg_cron jobs (from the backup's cron list) and vault secret `ari_backup_hook_secret` (0022 creates it).

## 3. Load table data
Run as postgres in one transaction per table (or one for all), with triggers and FK checks off:

```sql
begin;
set local session_replication_role = replica;   -- skips triggers (push, normalisers, app-change guard) and FK checks
truncate public.<table> restart identity cascade;   -- full restore only; for a few rows use a temp table + insert ... on conflict
insert into public.<table> (<cols>)
  overriding system value
  select <cols> from json_populate_recordset(null::public.<table>, $ari$<rows json>$ari$::json);
commit;
```

Column rules (the drill does exactly this):
- **Generated columns** (`information_schema.columns.is_generated = 'ALWAYS'`): leave them out of `<cols>`; Postgres recomputes them. Including them fails with "cannot insert a non-DEFAULT value into column".
  Build `<cols>` with: `select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema='public' and table_name='<t>' and is_generated='NEVER';`
- **Identity columns** (`GENERATED ALWAYS AS IDENTITY`): keep the backed-up ids with `OVERRIDING SYSTEM VALUE` so foreign keys and app ids (P###, Q###) still line up.
- **Sequences after load**: reset every serial/identity sequence past the max id, or the next insert collides:
  `select setval(pg_get_serial_sequence('public.<t>','id'), coalesce(max(id),1), max(id) is not null) from public.<t>;`
- **Partial restore**: load into `create temp table x (like public.<t>)`, compare, then `insert into public.<t> select * from x where id in (...) on conflict (id) do update set ...`.
- Strip the dollar-quote tag from the JSON first (`$ari$` must not appear in the data).
- Order does not matter while `session_replication_role = replica`; it does if you run without it (parents first: accounts, people, then queue, log_entries, replies...).

## 4. Auth, owner and two-step factors
- `auth.users` and `auth.identities` are in the backup. In a new project, restore them as postgres with the same ids so the owner uid stays **b14d1605-c766-4684-9a5b-71ffcab6967b** (is_owner() and every RLS policy pin that uid). If the uid changes, is_owner() returns false and the app shows nothing: update 0016E/0024 `is_owner()` to the new uid as a migration.
- Re-enable Google as the only provider, keep email signup and password login off (signup 422, password 422 as before).
- **Two-step factors are not backed up.** After a restore into a new project (or if mfa_factors was lost), the owner has 0 verified factors, so is_owner() falls back to aal1 and Google-only works. Owner must then re-enrol:
  1. Open Ari > Settings > Authenticator code > Set up.
  2. Delete the old "Ari" entry from the authenticator app, scan the new QR (or type the key), enter the 6-digit code.
  3. Confirm the row reads "On" and a reload asks for the code (aal2 gate).
- If prod still holds a factor but Owner lost the authenticator: maintenance session `delete from auth.mfa_factors where user_id = 'b14d1605-c766-4684-9a5b-71ffcab6967b';` then re-enrol as above. Emergency fallback: native/supabase/rollbacks/0024_rollback.sql.
- Sessions and refresh tokens are not restored: every device signs in again with Google.

## 5. New project extras
- Deploy edge functions ari-push and ari-backup (Verify JWT off for ari-backup) and set env: STAGING_URL, STAGING_SECRET_KEY, push keys.
- Update `ari_backup_kick()` URL to the new ref; re-mint the ari_worker JWT for the new JWT secret, save it to the vault, rebind it (connect_service, same service name); update REF in scripts/ari_db.py, restore_drill.py, sync and the web app config, then redeploy the web app.

## 6. Verify, then resume
1. Counts: compare `select count(*)` per table with the backup's `counts` (or re-run the drill against prod data).
2. Owner path: as authenticated + owner uid, is_owner true, people/accounts/queue counts match; stranger uid sees 0 rows.
3. Worker path: least-privilege suite via the proxy (work/v185 suite) still passes; anon still 401 everywhere.
4. `python3 scripts/backup_check.py` after the next 03:00 IST run.
5. Unpause sync 56e17ef1 and worker e8fbd86f; watch two runs each exit 0.
6. Log the restore (object name, scope, counts, times) in the day's fixlog.

## Offsite copy on Google Drive (v18.7, second vendor)
- Where: private folder "Ari backups" in the Google Drive of ops@example.com, newest 14 files `ari_*.json.gz.cms` (full export) or `ari_w_*.json.gz.cms` (worker-scope export, until migration 0025).
- Written nightly by task d497bf61 step 2 (scripts/offsite_drive.py). Encrypted with openssl CMS (AES-256-CBC, key wrapped to EC P-384 certificate native/supabase/offsite/ari-offsite-recipient.pem, sha256 fingerprint 89:F0:82:D8:...:CD:77). The job holds only the public certificate.
- Private key: Hark vault, "Ari offsite backup private key (EC P-384, PKCS8 PEM...)". No other copy exists.
- Decrypt: download the file from Drive, put the key in key.pem (chmod 600), then
  `openssl cms -decrypt -binary -inform DER -in FILE.cms -inkey key.pem -recip ari-offsite-recipient.pem -out FILE.json.gz`, then gunzip.
  Shred key.pem afterwards. Round trip verified Oct 17 2026 04:1x IST (counts matched, 14 tables, 2,748 rows).
