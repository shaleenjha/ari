-- Rollback for 0021_drop_hark_query_time.sql: recreate hark_query and hark_time exactly as in prod (captured Oct 17 03:05 IST).
CREATE OR REPLACE FUNCTION public.hark_query(sql text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$ declare r jsonb; begin
  perform set_config('transaction_read_only', 'on', true);
  perform set_config('statement_timeout', '20s', true);
  execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (' || sql || ') t' into r; return r; end $function$;
CREATE OR REPLACE FUNCTION public.hark_time(sql text, n integer DEFAULT 3)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'extensions'
AS $function$
declare t0 timestamptz; r jsonb := '[]'; i int; x jsonb;
begin perform set_config('transaction_read_only', 'on', true); perform set_config('statement_timeout', '20s', true);
  for i in 1..least(n, 5) loop t0 := clock_timestamp(); execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (' || sql || ') t' into x; r := r || to_jsonb(round(extract(epoch from clock_timestamp()-t0)*1000)); end loop; return r; end $function$;
revoke all on function public.hark_query(text) from public, anon, authenticated;
grant execute on function public.hark_query(text) to service_role;
revoke all on function public.hark_time(text, integer) from public, anon, authenticated;
grant execute on function public.hark_time(text, integer) to service_role;
delete from supabase_migrations.schema_migrations where version = '0021';
