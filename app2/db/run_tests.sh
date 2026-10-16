#!/usr/bin/env bash
# app2 SQL tests: fresh database, local bootstrap (Supabase-like roles), every migration in order, then every test file.
# Local:  PGHOST=/tmp PGPORT=54340 PGUSER=postgres bash app2/db/run_tests.sh
# CI:     Postgres 17 service container (see .github/workflows/ci.yml)
set -euo pipefail
cd "$(dirname "$0")"
DB="${APP2_TEST_DB:-app2_test}"
psql -v ON_ERROR_STOP=1 -q -d postgres -c "drop database if exists $DB" -c "create database $DB"
P="psql -v ON_ERROR_STOP=1 -q -X -d $DB"
$P -f bootstrap_local.sql
for f in migrations/*.sql; do echo "migrate $f"; $P -f "$f"; done
pass=0
for t in tests/*.sql; do echo "test $t"; out=$($P -At -f "$t"); echo "$out" | grep -E "^(ok|PASS)" || true; pass=$((pass+1)); done
echo "SQL TESTS PASSED: $pass files"
