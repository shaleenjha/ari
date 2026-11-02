-- rollback 0016 E: original is_owner() (email + user_metadata.email_verified)
create or replace function public.is_owner() returns boolean language sql stable as $function$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'owner@example.com'
     and coalesce((auth.jwt() -> 'user_metadata' ->> 'email_verified')::boolean, true)
$function$;
