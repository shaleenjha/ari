#!/usr/bin/env bash
# LOCAL ONLY. Lock behaviour of 0033..0035 on a throwaway prod-shape database (run run_local.sh first: it leaves DB built).
#   PGHOST=/tmp PGPORT=54340 PGUSER=postgres bash native/supabase/migrations/pending/test/lock_local.sh
#  1. lock profile: the lock each statement class takes on its table (pg_locks, measured inside the transaction)
#  2. resume: a session holds ACCESS SHARE on public.people (a long read); 0033 stops on people after 5s with earlier tables done,
#     no ledger row; the read ends; the re-run finishes
#  3. backfill: 2,500 explicit-null rows in plays + 3 in people after 0033; 0034 batches 1,000 per transaction, stops asking for a
#     re-run while nulls remain, never bumps updated_at (touch_row skipped), then finishes
#  4. live traffic: app-like reads/writes as ari_worker and as the owner in a loop while 0033..0035 apply: errors counted
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; PEND="$(dirname "$HERE")"; SB="$(cd "$PEND/../.." && pwd)"; ROOT="$(cd "$SB/../.." && pwd)"
DB="${LOCK_DB:-app2_lock_test}"
P="psql -X -q -v ON_ERROR_STOP=1 -d $DB"
api() { python3 "$HERE/api_exec.py" "$DB" "$1"; }
fresh() {
  psql -X -q -d postgres -c "drop database if exists $DB" -c "create database $DB" 2>/dev/null
  python3 -c "import sys; sys.path.insert(0, '$ROOT/scripts'); import db_backup; sys.stdout.write(db_backup.STUB)" | psql -X -q -d $DB >/dev/null 2>&1
  $P -f "$HERE/platform_stub.sql" 2>/dev/null; $P -c "drop schema public cascade"
  $P -f "$SB/baseline/prod_public_schema_2026-10-17_pre0015.sql" >/dev/null
  for f in "$SB"/migrations/00{15..32}_*.sql; do $P -1 -f "$f" >/dev/null 2>&1; done
  $P -1 -f "$HERE/seed.sql" >/dev/null
}
locks() { $P -At -c "begin; set local lock_timeout='5s'; $1; select string_agg(distinct mode, ',' order by mode) from pg_locks where locktype='relation' and pid=pg_backend_pid() and relation='public.$2'::regclass; rollback;" | tail -1; }

echo "== 1. lock profile (one table, measured)"
fresh
W="'f5a1e000-0000-4000-8000-000000000001'"
printf '%-58s %s\n' "E1 add column workspace_id default const" "$(locks "alter table public.plays add column workspace_id uuid default $W::uuid" plays)"
api "$PEND/0033_app2_e1_tenancy.sql"
:
printf '%-58s %s\n' "E2-A create trigger ws_guard" "$(locks "create function pg_temp.f() returns trigger language plpgsql as 'begin return new; end'; create trigger t before insert or update of workspace_id on public.plays for each row execute function pg_temp.f()" plays)"
printf '%-58s %s\n' "E2-B lock row exclusive + backfill update" "$(locks "lock table public.plays in row exclusive mode; update public.plays set workspace_id = workspace_id where ctid = any(array(select ctid from public.plays where workspace_id is null limit 1000))" plays)"
printf '%-58s %s\n' "E2-C add check not valid" "$(locks "alter table public.plays add constraint x check (workspace_id is not null) not valid" plays)"
printf '%-58s %s\n' "E2-C add fk not valid" "$(locks "alter table public.plays add constraint y foreign key (workspace_id) references app.workspaces(id) not valid" plays)"
printf '%-58s %s\n' "E2-C add fk not valid (on app.workspaces)" "$($P -At -c "begin; alter table public.plays add constraint y foreign key (workspace_id) references app.workspaces(id) not valid; select string_agg(distinct mode, ',') from pg_locks where pid=pg_backend_pid() and relation='app.workspaces'::regclass; rollback;" | tail -1)"
$P -c "alter table public.plays add constraint x check (workspace_id is not null) not valid; alter table public.plays add constraint y foreign key (workspace_id) references app.workspaces(id) not valid" >/dev/null
printf '%-58s %s\n' "E2-D validate check" "$(locks "alter table public.plays validate constraint x" plays)"
printf '%-58s %s\n' "E2-D validate fk" "$(locks "alter table public.plays validate constraint y" plays)"
$P -c "alter table public.plays validate constraint x" >/dev/null
printf '%-58s %s\n' "E2-E set not null (validated check present)" "$(locks "alter table public.plays alter column workspace_id set not null" plays)"
printf '%-58s %s\n' "E2-E drop helper check" "$(locks "alter table public.plays drop constraint x" plays)"
printf '%-58s %s\n' "E2-F create unique index (non-concurrent)" "$(locks "create unique index z on public.plays (workspace_id, name)" plays)"
printf '%-58s %s\n' "E3 drop policy + create policy (same transaction)" "$(locks "drop policy owner_all on public.plays; create policy owner_all on public.plays for all to authenticated using (true)" plays)"
printf '%-58s %s\n' "E1-rollback drop column" "$(locks "alter table public.plays drop column workspace_id cascade" plays)"
# set not null skips the scan when the validated check proves it (PG 12+): DEBUG1 says so
$P -c "set client_min_messages = debug1; alter table public.plays alter column workspace_id set not null" 2>&1 | grep -i "proven\|existing constraints" | sed 's/^/   /' || echo "   (no DEBUG proof line)"

echo "== 2. resume after a lock timeout"
fresh
( $P -c "begin; lock table public.people in access share mode; select pg_sleep(9); commit;" >/dev/null ) &
sleep 1
t0=$(date +%s); if api "$PEND/0033_app2_e1_tenancy.sql" 2>/tmp/lock_err.txt; then echo "   UNEXPECTED: 0033 did not stop"; else echo "   0033 stopped after $(( $(date +%s) - t0 ))s: $(head -1 /tmp/lock_err.txt | sed 's/.*ERROR:  //')"; fi
echo "   columns added before the stop: $($P -At -c "select count(*) from information_schema.columns where table_schema='public' and column_name='workspace_id'") of 42; people has it: $($P -At -c "select count(*) from information_schema.columns where table_schema='public' and table_name='people' and column_name='workspace_id'"); ledger 0033: $($P -At -c "select count(*) from supabase_migrations.schema_migrations where version='0033'")"
wait
api "$PEND/0033_app2_e1_tenancy.sql"; echo "   re-run: columns $($P -At -c "select count(*) from information_schema.columns where table_schema='public' and column_name='workspace_id'") of 42, ledger 0033: $($P -At -c "select count(*) from supabase_migrations.schema_migrations where version='0033'")"

echo "== 3. batched backfill with explicit-null rows"
$P -c "insert into public.plays(name, workspace_id) select 'null probe ' || g, null from generate_series(1, 2500) g" >/dev/null
$P -c "update public.people set workspace_id = null where id in (select id from public.people order by id limit 3)" >/dev/null
before=$($P -At -c "select md5(string_agg(id::text || coalesce(updated_at::text, '-'), ',' order by id)) from public.people")
echo "   nulls before: plays $($P -At -c "select count(*) from public.plays where workspace_id is null"), people $($P -At -c "select count(*) from public.people where workspace_id is null")"
n=0; until api "$PEND/0034_app2_e2_backfill.sql" 2>/tmp/bf_err.txt; do n=$((n+1)); echo "   run $n stopped: $(head -1 /tmp/bf_err.txt | sed 's/.*ERROR:  //'); plays nulls left $($P -At -c "select count(*) from public.plays where workspace_id is null")"; [ $n -lt 3 ] || { echo "   GAVE UP"; break; }; done
echo "   finished after $((n+1)) run(s); nulls left: $($P -At -c "select (select count(*) from public.plays where workspace_id is null) + (select count(*) from public.people where workspace_id is null)"); ledger 0034: $($P -At -c "select count(*) from supabase_migrations.schema_migrations where version='0034'")"
after=$($P -At -c "select md5(string_agg(id::text || coalesce(updated_at::text, '-'), ',' order by id)) from public.people")
[ "$before" = "$after" ] && echo "   people.updated_at untouched by the backfill (touch_row skipped)" || echo "   WARNING: people.updated_at changed"
api "$PEND/0035_app2_e3_dual_rls.sql"; echo "   0035 applied; ledger: $($P -At -c "select string_agg(version, ',' order by version) from supabase_migrations.schema_migrations where version >= '0032'")"

echo "== 4. live traffic during the apply"
fresh
OWNER=b14d1605-c766-4684-9a5b-71ffcab6967b
traffic() {  # $1 = seconds; app-like work as owner (apply_op insert/set via authenticated) and as ari_worker; prints error count
  local end=$(( $(date +%s) + $1 )) ok=0 bad=0 i=0
  while [ "$(date +%s)" -lt "$end" ]; do i=$((i+1))
    if $P -c "set role ari_worker; select count(*) from public.people; select count(*) from public.queue; update public.accounts set company = company where id = (select id from public.accounts limit 1);" >/dev/null 2>>/tmp/traffic_err.txt \
    && $P -c "begin; set local role authenticated; select set_config('request.jwt.claims', '{\"role\":\"authenticated\",\"sub\":\"$OWNER\",\"aal\":\"aal1\"}', true), set_config('request.jwt.claim.sub', '$OWNER', true); select count(*) from public.people; select public.apply_op('live-$i-$RANDOM', 'insert', 'queue', null, jsonb_build_object('id', 'QL$i$RANDOM', 'action', 'live probe'), now(), 'test'); commit;" >/dev/null 2>>/tmp/traffic_err.txt
    then ok=$((ok+1)); else bad=$((bad+1)); fi
  done; echo "$ok ok, $bad failed"
}
: > /tmp/traffic_err.txt
traffic 40 > /tmp/traffic_res.txt &
sleep 1
for m in 0033_app2_e1_tenancy 0034_app2_e2_backfill 0035_app2_e3_dual_rls; do t0=$(date +%s%N); api "$PEND/$m.sql"; echo "   $m applied under traffic in $(( ($(date +%s%N) - t0) / 1000000 )) ms"; done
wait
echo "   traffic loop: $(cat /tmp/traffic_res.txt)"; [ -s /tmp/traffic_err.txt ] && sed 's/^/   err: /' /tmp/traffic_err.txt | sort | uniq -c | head -5 || true
echo "   new queue rows got workspace Owner: $($P -At -c "select count(*) filter (where workspace_id = 'f5a1e000-0000-4000-8000-000000000001') || ' of ' || count(*) from public.queue where action = 'live probe'")"
