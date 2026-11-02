-- Rollback for 0020_drop_hark_exec.sql: recreate hark_exec exactly as it was (prod definition and ACL captured Oct 17 02:00 IST).
create or replace function public.hark_exec(sql text) returns void language plpgsql security definer
  set search_path to 'public', 'extensions' as $function$ begin execute sql; end $function$;
revoke all on function public.hark_exec(text) from public, anon, authenticated;
grant execute on function public.hark_exec(text) to service_role;
