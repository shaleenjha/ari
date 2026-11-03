# Nightly backup check + offsite copy (03:20 IST)

Checks that the in-database nightly backup (03:00 IST, edge function `ari-backup` started by pg_cron) finished and restore-tested itself, then copies the already-encrypted file to a private Google Drive folder and keeps the newest 14.

| | |
|---|---|
| Schedule type | `daily` |
| Schedule config | `{"time": "03:20", "timezone": "Asia/Kolkata"}` |
| Timezone | Asia/Kolkata (IST) |
| Credentials it uses | The worker database binding (no credentials parameter in the first call); the ops Google account that owns the Drive folder. |
| State at the sunset (Nov 3 2026) | paused |

## The prompt (scrubbed)

Copy this into the task, replace the `{...}` placeholders, and keep the rest as written.

```text
Silent maintenance run: nightly check of the SDR's Ari database backup (Supabase project "ari", ref {PROD_PROJECT_REF}), then the second-vendor offsite copy to Google Drive.

Since Oct 17 2026 (v18.6) the backup itself runs inside Supabase every night at 03:00 IST (edge function ari-backup started by a database cron job): every table, the sign-in users, and the migration history go to a private storage bucket, a copy goes to the separate staging project, and each run restore-tests itself. Since v18.7.1 the same function also writes an already-encrypted copy (public-key encryption; nobody but the SDR's vault key can open it) to a separate private bucket, which is the only one the restricted worker key can read. This task checks the result and copies that encrypted file to a private Google Drive folder. It needs no Supabase management access; the restricted worker key is injected by the existing proxy binding.

Step 1. Run exactly this once in the shell (no credentials parameter):
cd {PROJECT_DIR} && python3 scripts/backup_check.py
Success = exit 0 and {"ok": true ...}.

Step 2 (always, even if step 1 failed). Run exactly this once in the shell with credentials [{"provider":"google","email":"{OPS_GOOGLE_ACCOUNT}"}]:
cd {PROJECT_DIR}/work && python3 ../scripts/offsite_drive.py
It takes the newest already-encrypted full backup, checks its checksum against the backup record, uploads it to the private Drive folder "Ari backups" of {OPS_GOOGLE_ACCOUNT}, re-downloads it to check the checksum, and keeps the newest 14. Success = exit 0 and {"ok": true ...} with "source": "ari-offsite". A "source" starting "worker-scope" means the encrypted copy was not readable; it still uploads a smaller fallback, but count it as a failure of step 2 for the rules below.

Do not run scripts/db_backup.py or scripts/restore_drill.py (maintenance only; they need access this run does not have) and never call api.supabase.com. Never decrypt, download to elsewhere, share, or commit backups; never change the Drive folder's sharing.

If a step fails, retry that step once after 2 minutes. If it still fails, keep a count per step in this task's note (scheduled_task action note, e.g. "backup consecutive_failures: 2, offsite consecutive_failures: 0, last error: ...") and post ONE short line in chat only on a step's 2nd consecutive failure (which step failed and the "problems" text or FAIL line), then not again until that step succeeds (reset its count on success). Otherwise stay completely silent. Never message anyone.
```
