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
