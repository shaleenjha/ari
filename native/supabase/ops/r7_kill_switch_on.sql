-- R7 KILL SWITCH ON (maintenance session, Management API query with Owner's short-lived PAT; staging first when testing).
-- Stops every worker credential at once, the static HS256 token included:
--   1. PostgREST can switch only to roles granted to authenticator, so revoking ari_worker from it refuses every
--      ari_worker token on the next request (undoes 0018 line 17).
--   2. The broker refuses new mints (gate answers 'disabled', one generic alert per hour).
--   3. The worker Auth user (the only Auth user whose role is ari_worker) is banned, so even a direct password sign-in fails.
-- Undo: r7_kill_switch_off.sql. Also set the function secret ARI_BROKER_DISABLED=1 if the broker itself is suspect.
begin;
revoke ari_worker from authenticator;
update public.ari_broker_state set enabled = false, updated_at = now() where id = 1;
update auth.users set banned_until = now() + interval '100 years' where role = 'ari_worker';   -- finite, like Auth's own ban (R7 F2)
commit;
select (select count(*) from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
         where r.rolname = 'ari_worker' and u.rolname = 'authenticator') as authenticator_has_ari_worker,   -- expect 0
       (select enabled from public.ari_broker_state where id = 1) as broker_enabled,                           -- expect false
       (select banned_until from auth.users where role = 'ari_worker') as banned_until;
