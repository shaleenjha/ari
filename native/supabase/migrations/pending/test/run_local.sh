#!/usr/bin/env bash
# LOCAL ONLY rehearsal of 0033..0035 against the prod schema shape, in a throwaway Postgres 17 (never staging/prod).
#   PGHOST=/tmp PGPORT=54340 PGUSER=postgres bash native/supabase/migrations/pending/test/run_local.sh
# Every migration file is sent as ONE simple-protocol query (psql -c "<whole file>"), which is how the Management API query
# endpoint runs it: explicit begin/commit blocks inside the string are separate transactions, an error stops the rest.
# Steps: Supabase-like roles + platform stubs, baseline (= prod after 0014) + 0015..0032, regenerate 0035 from that shape,
# synthetic seed, probe (before), apply 0033 / 0034 / 0035 with a probe after each, assertions, re-apply all three
# (idempotence) + probe, rollbacks 0035 / 0034 / 0033 (each twice: re-runnable), probe + schema diff, then apply again + checks.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PEND="$(dirname "$HERE")"; SB="$(cd "$PEND/../.." && pwd)"; ROOT="$(cd "$SB/../.." && pwd)"
DB="${PRODSHAPE_DB:-app2_e123_test}"; OUT="${OUT:-$HERE/out}"; mkdir -p "$OUT"
P="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
api() { python3 "$HERE/api_exec.py" "$DB" "$1"; }   # one request = one Query message, as the Management API sends it
psql -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
python3 -c "import sys; sys.path.insert(0, '$ROOT/scripts'); import db_backup; sys.stdout.write(db_backup.STUB)" | psql -X -q -d $DB >/dev/null 2>&1   # roles are cluster-wide: "already exists" is fine
$P -f "$HERE/platform_stub.sql" 2>/dev/null
$P -c "drop schema public cascade"
$P -f "$SB/baseline/prod_public_schema_2026-10-17_pre0015.sql" >/dev/null
for f in "$SB"/migrations/00{15..32}_*.sql; do $P -1 -f "$f" >/dev/null 2>&1 || { echo "FAILED $f"; $P -1 -f "$f"; }; done
echo "prod shape: baseline + 0015..0032 loaded (max version $($P -At -c 'select max(version) from supabase_migrations.schema_migrations'))"
python3 "$HERE/gen_e3.py" "$DB"
$P -1 -f "$HERE/seed.sql" >/dev/null
schema() { pg_dump -s -d "$DB" -n public -n app --no-owner | grep -v '^--' | grep -v '^$' > "$1"; $P -At -c "select tablename||' '||policyname||' '||cmd||' '||roles::text||' '||coalesce(qual,'')||' '||coalesce(with_check,'') from pg_policies order by 1" >> "$1"; }
schema "$OUT/schema_before.sql"
python3 "$HERE/probe.py" "$DB" "$OUT/probe_before.json"
M="0033_app2_e1_tenancy 0034_app2_e2_backfill 0035_app2_e3_dual_rls"
for m in $M; do api "$PEND/$m.sql"; echo "applied $m"; python3 "$HERE/probe.py" "$DB" "$OUT/probe_after_${m:0:4}.json"; done
$P -f "$HERE/checks_after_e3.sql" 2>&1 | grep -E "ok |PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
for m in $M; do api "$PEND/$m.sql"; done; echo "re-applied 0033..0035 (idempotence): no error"
python3 "$HERE/probe.py" "$DB" "$OUT/probe_after_reapply.json"
for m in 0035_app2_e3_dual_rls 0034_app2_e2_backfill 0033_app2_e1_tenancy; do
  api "$PEND/${m}_rollback.sql"; api "$PEND/${m}_rollback.sql"; echo "rolled back $m (twice)"; done
schema "$OUT/schema_after_rollback.sql"
python3 "$HERE/probe.py" "$DB" "$OUT/probe_after_rollback.json"
python3 "$HERE/compare.py" "$OUT"
for m in $M; do api "$PEND/$m.sql"; done; echo "applied 0033..0035 again after the rollback"
$P -f "$HERE/checks_after_e3.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'

# S1 releases 5 and 6 (0037, 0038) on top of 0033..0035: synthetic before-state, apply, checks, idempotence,
# rollbacks (each twice), rollback checks, apply again + checks. Added v18.17.7 (README-R5-R6.md).
# fixtures_before_0038.sql runs ONLY here, on the throwaway local/CI database. Never on staging or prod.
$P -f "$HERE/fixtures_before_0038.sql" >/dev/null
for m in 0037_members_aal2 0038_s1_release6; do api "$PEND/$m.sql"; echo "applied $m"; done
$P -f "$HERE/checks_after_0037.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
$P -f "$HERE/checks_after_0038.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
for m in 0037_members_aal2 0038_s1_release6; do api "$PEND/$m.sql"; done; echo "re-applied 0037, 0038 (idempotence): no error"
api "$PEND/0038_s1_release6_rollback.sql"; api "$PEND/0038_s1_release6_rollback.sql"; echo "rolled back 0038 (twice)"
$P -f "$HERE/checks_after_0038_rollback.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
api "$PEND/0037_members_aal2_rollback.sql"; api "$PEND/0037_members_aal2_rollback.sql"; echo "rolled back 0037 (twice)"
for m in 0037_members_aal2 0038_s1_release6; do api "$PEND/$m.sql"; done; echo "applied 0037, 0038 again after the rollback"
$P -f "$HERE/checks_after_0037.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
$P -f "$HERE/checks_after_0038.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'

# S1 release 7 (0040 broker guardrails + kill switch files), on top of 0037/0038. Added Oct 21 2026 (work/r7/runbook.md).
api "$PEND/0040_s1_release7_broker.sql"; echo "applied 0040"
$P -f "$HERE/checks_after_0040.sql" 2>&1 | grep -E "ok |PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
api "$PEND/0040_s1_release7_broker.sql"; echo "re-applied 0040 (idempotence): no error"
api "$PEND/0040_s1_release7_broker_rollback.sql"; api "$PEND/0040_s1_release7_broker_rollback.sql"; echo "rolled back 0040 (twice)"
n=$($P -At -c "select count(*) from pg_proc where proname like 'ari_broker_%' or proname = 'ari_worker_whoami'")$($P -At -c "select count(*) from pg_class where relname like 'ari_broker_%'")$($P -At -c "select count(*) from pg_proc where proname = 'notifications_privacy' and prosrc like '%ops_alert%'")
[ "$n" = "000" ] || { echo "FAIL 0040 rollback left objects ($n)"; exit 1; }; echo "0040 ROLLBACK CHECK PASSED"
a=$($P -At -c "select count(*) from pg_class where relname like 'r7_archive_broker_%' and relrowsecurity and not has_table_privilege('anon', oid, 'select') and not has_table_privilege('authenticated', oid, 'select') and (not exists (select 1 from pg_roles where rolname = 'service_role') or not has_table_privilege('service_role', oid, 'select'))")
[ "$a" -ge 2 ] || { echo "FAIL 0040 rollback archive missing or readable ($a)"; exit 1; }; g=$($P -At -c "select count(*) from information_schema.role_table_grants t join pg_class c on c.relname = t.table_name and c.relnamespace = 'public'::regnamespace where t.table_schema = 'public' and t.table_name like 'r7_archive_broker_%' and t.grantee <> pg_get_userbyid(c.relowner)")
[ "$g" = "0" ] || { echo "FAIL 0040 rollback archive has non-owner grants ($g)"; exit 1; }
echo "0040 ROLLBACK ARCHIVE CHECK PASSED"
api "$PEND/0040_s1_release7_broker.sql"; echo "applied 0040 again after the rollback"
$P -f "$HERE/checks_after_0040.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
# 0040 parallel cap (R7 review): 12 concurrent gate calls in a fresh hour -> exactly 3 allowed (the advisory lock holds it)
$P -c "delete from public.ari_broker_mints" -c "update public.ari_broker_state set enabled = true, windows = '[{\"dow\":[0,1,2,3,4,5,6],\"from\":\"00:00\",\"to\":\"23:59\"}]' where id = 1"
for i in $(seq 1 12); do $P -At -c "select public.ari_broker_gate('par$i')" >/dev/null & done; wait
n=$($P -At -c "select count(*) from public.ari_broker_mints where request_id like 'par%' and outcome = 'allowed'")
[ "$n" = "3" ] || { echo "FAIL 0040 parallel cap: $n allowed"; exit 1; }; echo "0040 PARALLEL CAP PASSED"

# Live AI layer (0041, PENDING), on top of 0040. Added Oct 23 2026. Synthetic data only (checks_after_0041.sql).
api "$PEND/0041_ai_layer.sql"; echo "applied 0041"
$P -f "$HERE/checks_after_0041.sql" 2>&1 | grep -E "ok |PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
api "$PEND/0041_ai_layer.sql"; echo "re-applied 0041 (idempotence): no error"
api "$PEND/0041_ai_layer_rollback.sql"; api "$PEND/0041_ai_layer_rollback.sql"; echo "rolled back 0041 (twice)"
n=$($P -At -c "select count(*) from pg_proc where proname like 'ari_ai_%' or proname like 'ari_gmail_watch_%' or proname = 'ari_gmail_push_config'")$($P -At -c "select count(*) from pg_class where relname in ('ai_budget','ai_calls','ai_jobs','ai_triggers','gmail_watch')")$($P -At -c "select count(*) from cron.job where jobname like 'ari-ai-%' or jobname = 'ari-gmail-watch-renew'")$($P -At -c "select count(*) from information_schema.columns where table_name = 'replies' and column_name = 'ai_triage'")
[ "$n" = "0000" ] || { echo "FAIL 0041 rollback left objects ($n)"; exit 1; }; echo "0041 ROLLBACK CHECK PASSED"
api "$PEND/0041_ai_layer.sql"; echo "applied 0041 again after the rollback"
$P -f "$HERE/checks_after_0041.sql" 2>&1 | grep -E "PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
