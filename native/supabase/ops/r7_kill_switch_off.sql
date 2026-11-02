-- R7 KILL SWITCH OFF: the exact undo of r7_kill_switch_on.sql. Re-runnable.
begin;
grant ari_worker to authenticator;
update public.ari_broker_state set enabled = true, updated_at = now() where id = 1;
update auth.users set banned_until = null where role = 'ari_worker';
commit;
select (select count(*) from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member
         where r.rolname = 'ari_worker' and u.rolname = 'authenticator') as authenticator_has_ari_worker,   -- expect 1
       (select enabled from public.ari_broker_state where id = 1) as broker_enabled,                           -- expect true
       (select banned_until from auth.users where role = 'ari_worker') as banned_until;
