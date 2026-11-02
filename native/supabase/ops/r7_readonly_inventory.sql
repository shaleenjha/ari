-- R7 step a: READ-ONLY live inventory (Management API query, read-only scoped PAT). Prints names and counts only, never
-- a secret value. Run on staging and on prod; paste the result into work/r7/inventory.md "Live (PAT) results".
select 'cron' as what, jobname as name,
       (command ~ 'eyJ[A-Za-z0-9_-]{10,}') as has_jwt_literal,
       (command ~ 'sb_secret_') as has_secret_key_literal,
       (command ~* 'service_role|anon') as mentions_legacy_role,
       (command ~* 'authorization') as sends_authorization
  from cron.job
union all
select 'vault', name, (decrypted_secret ~ '^eyJ'), (decrypted_secret ~ '^sb_secret_'), null, null from vault.decrypted_secrets
union all
select 'fn_net_post', p.proname, (pg_get_functiondef(p.oid) ~ 'eyJ[A-Za-z0-9_-]{10,}'), (pg_get_functiondef(p.oid) ~ 'sb_secret_'),
       (pg_get_functiondef(p.oid) ~* 'service_role_key|anon_key'), (pg_get_functiondef(p.oid) ~* 'authorization')
  from pg_proc p where p.pronamespace = 'public'::regnamespace and pg_get_functiondef(p.oid) ~ 'net\.http_post'
union all
select 'auth_users_with_password', coalesce(email, id::text), (encrypted_password is not null and encrypted_password <> ''), null,
       (role is distinct from 'authenticated'), null from auth.users
union all
select 'authenticator_member_of', r.rolname, null, null, null, null
  from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = 'authenticator'
order by 1, 2;
