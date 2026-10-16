-- rollback 0016 A: restore Supabase's stock default grants for objects postgres creates in public
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated;
alter default privileges for role postgres grant execute on functions to public;
