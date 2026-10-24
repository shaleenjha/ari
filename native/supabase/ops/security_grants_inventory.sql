-- READ-ONLY grant inventory for public + app (added with 0042, Oct 24 2026). Run on staging and prod through the Management API
-- query endpoint. Prints names and privilege flags only, never row data. Result: one json row: rels (anon_priv, auth_priv, rls, policies
-- naming anon/public, view security_invoker), fns (anon/authenticated/PUBLIC execute, SECURITY DEFINER, search_path pinned),
-- schema usage, and every default ACL that still grants anon. Pair with GET /v1/projects/<ref>/advisors/security.
with rel as (
 select c.oid, n.nspname s, c.relname t, c.relkind k, c.relrowsecurity rls, c.relforcerowsecurity frls,
   (select count(*) from pg_policy p where p.polrelid=c.oid) npol,
   (select string_agg(p.polname||'['||(select string_agg(case r when 0 then 'public' else r::regrole::text end,',') from unnest(p.polroles) r)||']',' ; ') from pg_policy p where p.polrelid=c.oid and (0 = any(p.polroles) or 'anon'::regrole = any(p.polroles))) anon_pols,
   coalesce((select string_agg(x,'') from unnest(array['select','insert','update','delete','truncate','references','trigger']) x where case when c.relkind='S' then x in ('select','update') and has_sequence_privilege('anon',c.oid,case x when 'select' then 'select' else 'update' end) else has_table_privilege('anon',c.oid,x) end),'') anon_priv,
   coalesce((select string_agg(left(x,1),'') from unnest(array['select','insert','update','delete','truncate']) x where case when c.relkind='S' then false else has_table_privilege('authenticated',c.oid,x) end),'') auth_priv,
   case when c.relkind='S' then has_sequence_privilege('anon',c.oid,'usage') end anon_seq_usage,
   (select string_agg(distinct a.attname,',') from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and a.attacl is not null and exists (select 1 from aclexplode(a.attacl) e where e.grantee='anon'::regrole)) anon_col_grants,
   case when c.relkind='v' then coalesce((select option_value from pg_options_to_table(c.reloptions) where option_name='security_invoker'),'false') end view_invoker
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','app') and c.relkind in ('r','p','v','m','S','f')
), fn as (
 select n.nspname s, p.oid::regprocedure::text sig, p.prosecdef secdef, has_function_privilege('anon',p.oid,'execute') anon_x, has_function_privilege('authenticated',p.oid,'execute') auth_x,
   exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) e where e.grantee=0) public_x,
   (select string_agg(e.grantee::regrole::text,',') from aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) e where e.grantee<>0) grantees,
   p.proconfig is not null and exists(select 1 from unnest(p.proconfig) c where c like 'search_path=%') sp_set
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','app') and p.prokind in ('f','p')
)
select json_build_object(
 'rels',(select json_agg(row_to_json(rel) order by s,t) from (select s,t,k,rls,frls,npol,anon_pols,anon_priv,auth_priv,anon_seq_usage,anon_col_grants,view_invoker from rel) rel),
 'fns',(select json_agg(row_to_json(fn) order by s,sig) from fn),
 'schema_usage',(select json_object_agg(nspname, json_build_object('anon_usage',has_schema_privilege('anon',oid,'usage'),'anon_create',has_schema_privilege('anon',oid,'create'),'auth_create',has_schema_privilege('authenticated',oid,'create'))) from pg_namespace where nspname in ('public','app')),
 'defacl_anon',(select json_agg(json_build_object('role',pg_get_userbyid(defaclrole),'ns',coalesce(defaclnamespace::regnamespace::text,'(global)'),'type',defaclobjtype)) from pg_default_acl a where exists (select 1 from aclexplode(a.defaclacl) e where e.grantee='anon'::regrole)),
 'exposed_schemas_guess',(select setting from pg_settings where name='search_path')
) r;
