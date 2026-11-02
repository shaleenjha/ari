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
t=$($P -At -c "select count(*) from pg_class where relkind = 'r' and relname like 'r7_archive_broker_%'")
[ "$g" = "0" ] && [ "$t" = "$a" ] || { echo "FAIL 0040 rollback archive grants/count (grants $g, tables $t, locked $a)"; exit 1; }
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

# 0048 push digest = Today's move total (PENDING), on top of the above. Added Oct 29 2026. checks_after_0048.sql is prod-safe:
# synthetic rows, ends in a deliberate raise ("ALL 0048 CHECKS PASSED ..."), so its psql exit is non-zero by design.
chk48() { local o; o=$($P -f "$HERE/checks_after_0048.sql" 2>&1 || true); echo "$o" | grep -E "ok |PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
  grep -q "ALL 0048 CHECKS PASSED" <<<"$o" || { echo "FAIL 0048 checks"; exit 1; }; }
api "$PEND/0048_push_moves_digest.sql"; echo "applied 0048"
chk48
api "$PEND/0048_push_moves_digest.sql"; echo "re-applied 0048 (idempotence): no error"
api "$PEND/0048_push_moves_digest_rollback.sql"; api "$PEND/0048_push_moves_digest_rollback.sql"; echo "rolled back 0048 (twice)"
n=$($P -At -c "select count(*) from pg_proc where proname in ('ari_move_total','ari_move_push_copy','ari_norm_co')")$($P -At -c "select count(*) from pg_proc where proname = 'ari_due_digest' and prosrc like '%follow-up%due tonight%'")$($P -At -c "select count(*) from supabase_migrations.schema_migrations where version = '0048'")
[ "$n" = "010" ] || { echo "FAIL 0048 rollback ($n)"; exit 1; }; echo "0048 ROLLBACK CHECK PASSED"
api "$PEND/0048_push_moves_digest.sql"; echo "applied 0048 again after the rollback"
chk48

# 0049 live Ask Kyte chat (PENDING), on top of 0041 + 0048. Added Oct 30 2026. checks_after_0049.sql is staging-safe: synthetic rows,
# ends in a deliberate raise ("ALL 0049 CHECKS PASSED ..."). Rollback restores ai_calls_task_check byte for byte.
chk49() { local o; o=$($P -f "$HERE/checks_after_0049.sql" 2>&1 || true); echo "$o" | grep -E "ok |PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
  grep -q "ALL 0049 CHECKS PASSED" <<<"$o" || { echo "FAIL 0049 checks"; exit 1; }; }
c49() { $P -At -c "select pg_get_constraintdef(oid) from pg_constraint where conname = 'ai_calls_task_check'"; }
before49=$(c49)
api "$PEND/0049_ai_chat.sql"; echo "applied 0049"
chk49
api "$PEND/0049_ai_chat.sql"; echo "re-applied 0049 (idempotence): no error"
api "$PEND/0049_ai_chat_rollback.sql"; api "$PEND/0049_ai_chat_rollback.sql"; echo "rolled back 0049 (twice)"
n=$($P -At -c "select count(*) from pg_proc where proname like 'ari_ai_chat_%'")$($P -At -c "select count(*) from pg_class where relname = 'ai_chat'")$($P -At -c "select count(*) from cron.job where jobname = 'ari-ai-chat-prune'")$($P -At -c "select count(*) from supabase_migrations.schema_migrations where version = '0049'")
[ "$n" = "0000" ] && [ "$(c49)" = "$before49" ] || { echo "FAIL 0049 rollback ($n)"; exit 1; }; echo "0049 ROLLBACK CHECK PASSED"
api "$PEND/0049_ai_chat.sql"; echo "applied 0049 again after the rollback"
chk49

# 0050 Kyte decline line (PENDING, ships with 0049), on top of the above. Added Oct 30 2026. checks_after_0050.sql is prod-safe:
# synthetic queue rows, ends in a deliberate raise ("ALL 0050 CHECKS PASSED ..."). Rollback restores the 0019 body byte for byte.
chk50() { local o; o=$($P -f "$HERE/checks_after_0050.sql" 2>&1 || true); echo "$o" | grep -E "ok |PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
  grep -q "ALL 0050 CHECKS PASSED" <<<"$o" || { echo "FAIL 0050 checks"; exit 1; }; }
f50() { $P -At -c "select md5(prosrc || coalesce(proacl::text, '') || prosecdef::text || coalesce(proconfig::text, '')) from pg_proc where oid = 'public.queue_block_app_change()'::regprocedure"; }
before50=$(f50)
api "$PEND/0050_kyte_decline_line.sql"; echo "applied 0050"
chk50
api "$PEND/0050_kyte_decline_line.sql"; echo "re-applied 0050 (idempotence): no error"
api "$PEND/0050_kyte_decline_line_rollback.sql"; api "$PEND/0050_kyte_decline_line_rollback.sql"; echo "rolled back 0050 (twice)"
[ "$(f50)" = "$before50" ] && [ "$($P -At -c "select count(*) from supabase_migrations.schema_migrations where version = '0050'")" = "0" ] || { echo "FAIL 0050 rollback"; exit 1; }; echo "0050 ROLLBACK CHECK PASSED"
api "$PEND/0050_kyte_decline_line.sql"; echo "applied 0050 again after the rollback"
chk50

# 0051 drafting in Ask Kyte (PENDING, staging only), on top of 0049 + 0050. Added Oct 30 2026. checks_after_0051.sql: synthetic rows,
# the ask_draft switch flipped inside the transaction, ends in a deliberate raise ("ALL 0051 CHECKS PASSED ...").
chk51() { local o; o=$($P -f "$HERE/checks_after_0051.sql" 2>&1 || true); echo "$o" | grep -E "ok |PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
  grep -q "ALL 0051 CHECKS PASSED" <<<"$o" || { echo "FAIL 0051 checks"; exit 1; }; }
o51() { $P -At -c "select (select count(*) from pg_proc where proname like 'ari_ai_chat_draft%') || '' || (select count(*) from pg_class where relname = 'ai_chat_drafts') || (select count(*) from cron.job where jobname = 'ari-ai-chat-draft-prune') || (select count(*) from supabase_migrations.schema_migrations where version = '0051')"; }
api "$PEND/0051_ai_chat_draft.sql"; echo "applied 0051"
chk51
api "$PEND/0051_ai_chat_draft.sql"; echo "re-applied 0051 (idempotence): no error"
[ "$(o51)" = "4111" ] || { echo "FAIL 0051 objects ($(o51))"; exit 1; }
api "$PEND/0051_ai_chat_draft_rollback.sql"; api "$PEND/0051_ai_chat_draft_rollback.sql"; echo "rolled back 0051 (twice)"
[ "$(o51)" = "0000" ] || { echo "FAIL 0051 rollback ($(o51))"; exit 1; }; echo "0051 ROLLBACK CHECK PASSED"
api "$PEND/0051_ai_chat_draft.sql"; echo "applied 0051 again after the rollback"
chk51

# 0052 scan controls (PENDING, staging first), on top of the above. Added Oct 30 2026. checks_after_0052.sql is staging-safe: synthetic
# 2030 run rows, settings changed inside the transaction, ends in a deliberate raise ("ALL 0052 CHECKS PASSED ...").
chk52() { local o; o=$($P -f "$HERE/checks_after_0052.sql" 2>&1 || true); echo "$o" | grep -E "ok |PASSED|FAIL|ERROR" | sed 's/^.*NOTICE:  //'
  grep -q "ALL 0052 CHECKS PASSED" <<<"$o" || { echo "FAIL 0052 checks"; exit 1; }; }
o52() { $P -At -c "select (select count(*) from pg_proc where proname like 'kyte_scan_%' or proname like 'kyte_worker_scan_%') || '' || (select count(*) from pg_class where relname in ('scan_settings', 'scan_control_runs')) || (select count(*) from supabase_migrations.schema_migrations where version = '0052')"; }
api "$PEND/0052_scan_controls.sql"; echo "applied 0052"
chk52
api "$PEND/0052_scan_controls.sql"; echo "re-applied 0052 (idempotence): no error"
[ "$(o52)" = "1121" ] || { echo "FAIL 0052 objects ($(o52))"; exit 1; }
api "$PEND/0052_scan_controls_rollback.sql"; api "$PEND/0052_scan_controls_rollback.sql"; echo "rolled back 0052 (twice)"
[ "$(o52)" = "000" ] && [ "$($P -At -c "select count(*) from pg_class where relname = 'scan_runs'")" = "1" ] || { echo "FAIL 0052 rollback ($(o52))"; exit 1; }; echo "0052 ROLLBACK CHECK PASSED"
api "$PEND/0052_scan_controls.sql"; echo "applied 0052 again after the rollback"
chk52
