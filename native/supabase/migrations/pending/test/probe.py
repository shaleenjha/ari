#!/usr/bin/env python3
"""Access probe for the prod-shape test database (LOCAL ONLY).
For each role (owner, stranger, ari_worker, anon) it reads every public table and view and calls every public function the
role may execute (generic arguments for required parameters), each call undone afterwards. Writes one JSON object:
  {"<role>|T|<relation>": "<count>|<md5 of rows without workspace_id>" or "ERR <sqlstate>",
   "<role>|F|<function>": "OK <md5 of normalised result>" or "ERR <sqlstate> <message>"}
Results are normalised so the 0033-0035 column (workspace_id) and run-dependent values (timestamps, generated ids) do not
count as differences. usage: probe.py <db> <out.json>"""
import json, os, re, subprocess, sys

DB, OUT = sys.argv[1], sys.argv[2]
OWNER = 'b14d1605-c766-4684-9a5b-71ffcab6967b'
STRANGER = 'c0000000-0000-4000-8000-00000000000c'
ROLES = {
    'owner': ('authenticated', {'role': 'authenticated', 'sub': OWNER, 'aal': 'aal1'}),
    'stranger': ('authenticated', {'role': 'authenticated', 'sub': STRANGER, 'aal': 'aal1'}),
    'ari_worker': ('ari_worker', {'role': 'ari_worker'}),
    'anon': ('anon', {'role': 'anon'}),
}
BODY = r"""
do $probe$
declare r text; rel record; f record; args text; call text; t text;
begin
  for rel in select c.relname, c.relkind from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v') order by 1 loop
    begin
      execute format($q$select count(*)::text || '|' || coalesce(md5(string_agg(j, '|' order by j)), '-')
                       from (select (to_jsonb(x) - 'workspace_id')::text j from public.%I x) s$q$, rel.relname) into r;
    exception when others then r := 'ERR ' || sqlstate;
    end;
    raise notice 'PROBE|T|%|%', rel.relname, r;
  end loop;
  for f in select p.oid, p.proname, p.oid::regprocedure::text sig, p.proretset, p.pronargs, p.pronargdefaults, p.proargtypes
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
             and p.prorettype <> 'trigger'::regtype and has_function_privilege(p.oid, 'execute') order by 3 loop
    select coalesce(string_agg(case format_type(ty, null)
             when 'uuid' then quote_literal('00000000-0000-4000-8000-0000000000a1') || '::uuid'
             when 'text' then quote_literal('PA9001')
             when 'integer' then '1' when 'bigint' then '1' when 'smallint' then '1' when 'numeric' then '1'
             when 'boolean' then 'false' when 'jsonb' then quote_literal('{}') || '::jsonb' when 'json' then quote_literal('{}') || '::json'
             when 'date' then quote_literal('2026-10-15') || '::date'
             when 'timestamp with time zone' then quote_literal('2026-10-15T10:00:00Z') || '::timestamptz'
             else 'null::' || format_type(ty, null) end, ', ' order by i), '')
      into args
      from unnest(f.proargtypes::oid[]) with ordinality u(ty, i) where i <= f.pronargs - f.pronargdefaults;
    call := format('%s(%s)', f.oid::regproc::text, args);
    if f.proretset then t := format('select string_agg(x::text, %L order by x::text) from %s x', '|', call);
    else t := format('select (%s)::text', call); end if;
    begin
      execute t into r;
      raise exception using errcode = 'P0001', message = '__probe_ok__' || coalesce(r, '<null>');
    exception when others then
      if sqlerrm like '__probe_ok__%' then
        r := substr(sqlerrm, 13);
        r := regexp_replace(r, '"workspace_id": "f5a1e000-0000-4000-8000-000000000001"(, )?', '', 'g');
        r := regexp_replace(r, ',f5a1e000-0000-4000-8000-000000000001\)', ')', 'g');
        r := regexp_replace(r, '\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(\.\d+)?([+-]\d\d(:\d\d)?|Z)?', 'TS', 'g');
        r := regexp_replace(r, '"(id|op_id|log_id|event_id|reply_id|sent_id|history_id|notification_id)": \d+', '"\1": N', 'g');
        r := regexp_replace(r, '"(age_h|hours|age_hours|mins|minutes|age_min|seconds|ms|took_ms|elapsed_ms)": [\d.]+', '"\1": N', 'g');
        r := regexp_replace(regexp_replace(regexp_replace(r, '\(\w+,workspace_id\)', '', 'g'), '\|{2,}', '|', 'g'), '^\||\|$', '', 'g');                 -- ari_worker_columns() lists the new column
        r := regexp_replace(r, '^([0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f]{32,64}|\d+)$', 'GENERATED');  -- new ids, tokens, counters
        raise notice 'PROBE|F|%|OK %', f.sig, md5(r);
        raise notice 'PROBEVAL|%|%', f.sig, left(r, 20000);
      else
        raise notice 'PROBE|F|%|ERR % %', f.sig, sqlstate, left(regexp_replace(sqlerrm, '\d+', 'N', 'g'), 120);
      end if;
    end;
  end loop;
end $probe$;
"""

def run_role(name):
    role, claims = ROLES[name]
    sql = ("begin;\n" f"set local role {role};\n"
           f"select set_config('request.jwt.claims', '{json.dumps(claims)}', true), set_config('request.jwt.claim.sub', '{claims.get('sub', '')}', true),"
           f" set_config('request.jwt.claim.role', '{claims['role']}', true);\n" + BODY + "rollback;\n")
    p = subprocess.run(['psql', '-X', '-q', '-d', DB, '-v', 'ON_ERROR_STOP=1'], input=sql, capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit(f'probe {name} failed: {p.stderr[-500:]}')
    out, vals = {}, {}
    for line in p.stderr.splitlines():
        m = re.search(r'NOTICE:  PROBE\|([TF])\|([^|]+)\|(.*)$', line)
        if m: out[f'{name}|{m.group(1)}|{m.group(2)}'] = m.group(3)
        m = re.search(r'NOTICE:  PROBEVAL\|([^|]+)\|(.*)$', line)
        if m: vals[f'{name}|F|{m.group(1)}'] = m.group(2)
    return out, vals

res, vals = {}, {}
for n in ROLES:
    o, v = run_role(n); res.update(o); vals.update(v)
json.dump(res, open(OUT, 'w'), indent=1, sort_keys=True)
json.dump(vals, open(OUT.replace('.json', '.values.json'), 'w'), indent=1, sort_keys=True)
ok = sum(1 for k, v in res.items() if '|F|' in k and v.startswith('OK'))
print(f'{OUT}: {sum(1 for k in res if "|T|" in k)} relation reads, {sum(1 for k in res if "|F|" in k)} function calls ({ok} OK)')
