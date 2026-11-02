-- Plain-SQL assertion tests for pending 0029 (synthetic data only; run inside a transaction that rolls back).
-- psql -v ON_ERROR_STOP=1 -f 0029_data_hygiene_test.sql   (needs the prod schema + 0029 applied, e.g. local Postgres)
begin;
set local session_replication_role = replica;   -- seed without app triggers
insert into public.accounts(id, company, domain, stage, stage_changed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'Exquorra.ai',  'exquorra.ai', 'Mapped', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000000a2', 'Exquorra AI',  null,         'Target', now()),
  ('00000000-0000-0000-0000-0000000000a3', 'Brennuvia Corp', 'sample.test','Engaged', now()),
  ('00000000-0000-0000-0000-0000000000a4', 'Other Labs Inc', 'www.sample.test/about', 'Target', now());
insert into public.people(id, name, company, account_id, review, stage, connect_sent, accepted, dm1_sent, dm) values
  ('PT0001', 'Alex Doe',    'Exquorra.ai', '00000000-0000-0000-0000-0000000000a1', 'lead', 'Connect sent', now() - interval '5 days', now() - interval '2 days', null, 'draft'),
  ('PT0002', 'Sam Roe',     'Exquorra AI', null,                                   'lead', 'Accepted',     null,                     now() - interval '3 days', null, null),
  ('PT0003', 'Kim Poe',     'Brennuvia Corp','00000000-0000-0000-0000-0000000000a3', 'lead', 'DM1 sent',     now() - interval '9 days', now() - interval '8 days', now() - interval '7 days', 'x'),
  ('PT0004', 'Lee Moe',     'Nowhere Co', null,                                   'personal', 'Connect queued', null, null, null, null),
  ('PT0005', 'Ash Coe',     'Brennuvia Corp','00000000-0000-0000-0000-0000000000a3', 'lead', 'Accepted',     now() - interval '2 days', now() - interval '2 hours', null, null);
set local session_replication_role = origin;

do $$ declare r jsonb; n int; begin
  r := public.ari_hygiene_scan();
  assert (r ->> 'ok')::bool, 'scan ok';
  -- accept_no_connect: only PT0002 (PT0004 personal and never accepted)
  select count(*) into n from hygiene_findings where check_key = 'accept_no_connect' and status = 'open';
  assert n = 1, 'accept_no_connect expected 1 got ' || n;
  assert exists (select 1 from hygiene_findings where check_key = 'accept_no_connect' and entity_id = 'PT0002'), 'PT0002 accept_no_connect';
  -- duplicate_account: a1/a2 by name, a3/a4 by domain
  select count(*) into n from hygiene_findings where check_key = 'duplicate_account';
  assert n = 2, 'duplicate_account expected 2 got ' || n;
  assert exists (select 1 from hygiene_findings where check_key = 'duplicate_account' and detail ->> 'matched_on' = 'domain'), 'domain match';
  -- no_account_link: PT0002 with suggestion a1 (oldest of Exquorra pair), personal PT0004 excluded
  select count(*) into n from hygiene_findings where check_key = 'no_account_link';
  assert n = 1, 'no_account_link expected 1 got ' || n;
  assert (select detail ->> 'suggested_account_id' from hygiene_findings where check_key = 'no_account_link') is not null, 'suggestion present';
  -- stale_stage: PT0001 (Connect sent but accepted) and account a1 (Mapped 40 days with a connect sent)
  assert exists (select 1 from hygiene_findings where check_key = 'stale_stage' and entity_id = 'PT0001' and detail ->> 'implied' = 'Accepted'), 'PT0001 stale';
  assert exists (select 1 from hygiene_findings where check_key = 'stale_stage' and entity_id = '00000000-0000-0000-0000-0000000000a1'), 'a1 stale';
  assert not exists (select 1 from hygiene_findings where check_key = 'stale_stage' and entity_id = 'PT0003'), 'PT0003 consistent';
  -- dm1_past_due: PT0001 (2 days) and PT0002 (3 days); PT0005 only 2 hours
  select count(*) into n from hygiene_findings where check_key = 'dm1_past_due';
  assert n = 2, 'dm1_past_due expected 2 got ' || n;
  -- scan writes findings only: no person or account row changed
  assert (select connect_sent from people where id = 'PT0002') is null, 'scan must not tick';
  assert (select account_id from people where id = 'PT0002') is null, 'scan must not link';
  -- idempotent
  r := public.ari_hygiene_scan();
  select count(*) into n from hygiene_findings where status = 'open';
  assert n = 8, 'open after rescan expected 8 got ' || n;
end $$;

-- worker role: can scan + read summary, cannot resolve, cannot read findings table directly
set local role ari_worker;
select public.ari_hygiene_scan() is not null as worker_scan_ok;
select (public.ari_worker_hygiene() -> 'open' ->> 'dm1_past_due')::int = 2 as worker_summary_ok;
do $$ begin
  begin perform public.hygiene_resolve(gen_random_uuid(), 'dismiss'); raise exception 'worker resolved!';
  exception when insufficient_privilege then null; end;
  begin perform count(*) from public.hygiene_findings; raise exception 'worker read table!';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- non-owner authenticated: hygiene_open returns nothing, resolve refused
set local role authenticated;
select set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true);
do $$ begin
  assert (select count(*) from public.hygiene_open()) = 0, 'stranger sees nothing';
  begin perform public.hygiene_resolve((select id from public.hygiene_open() limit 1), 'dismiss'); raise exception 'stranger resolved!';
  exception when raise_exception then if sqlerrm = 'stranger resolved!' then raise; end if; end;
end $$;

-- owner one-tap actions
select set_config('request.jwt.claim.sub', 'b14d1605-c766-4684-9a5b-71ffcab6967b', true);
reset role;  -- functions are security definer; call as postgres with owner claims to avoid grants on helper tables in this stub
do $$ declare fid uuid; r jsonb; begin
  assert (select count(*) from public.hygiene_open()) = 8, 'owner sees 8';
  -- link PT0002 to suggested account
  select id into fid from hygiene_findings where check_key = 'no_account_link';
  r := public.hygiene_resolve(fid, 'link');
  assert (select account_id from people where id = 'PT0002') = '00000000-0000-0000-0000-0000000000a1', 'linked';
  assert (select status from hygiene_findings where id = fid) = 'fixed', 'fixed';
  -- tick connect
  select id into fid from hygiene_findings where check_key = 'accept_no_connect';
  r := public.hygiene_resolve(fid, 'tick_connect');
  assert (select connect_sent is not null from people where id = 'PT0002'), 'ticked';
  -- wrong action for a check is refused
  select id into fid from hygiene_findings where check_key = 'dm1_past_due' limit 1;
  begin r := public.hygiene_resolve(fid, 'merge', '{"keep":"00000000-0000-0000-0000-0000000000a1"}'); raise exception 'bad action accepted';
  exception when raise_exception then if sqlerrm = 'bad action accepted' then raise; end if; end;
  -- merge a2 into a1 (user tap)
  select id into fid from hygiene_findings where check_key = 'duplicate_account' and detail ->> 'matched_on' = 'name';
  r := public.hygiene_resolve(fid, 'merge', '{"keep":"00000000-0000-0000-0000-0000000000a1"}');
  assert (select deleted_at is not null from accounts where id = '00000000-0000-0000-0000-0000000000a2'), 'a2 soft-deleted';
  assert (select 'merged_into:00000000-0000-0000-0000-0000000000a1' = any(flags) from accounts where id = '00000000-0000-0000-0000-0000000000a2'), 'merge flag';
  -- dismiss stays dismissed across scans
  select id into fid from hygiene_findings where check_key = 'dm1_past_due' and entity_id = 'PT0001';
  r := public.hygiene_resolve(fid, 'dismiss');
  r := public.ari_hygiene_scan();
  assert (select status from hygiene_findings where id = fid) = 'dismissed', 'dismiss sticks';
  -- fixed problems are gone from the scan; duplicate name pair no longer open
  assert not exists (select 1 from hygiene_findings where check_key = 'duplicate_account' and detail ->> 'matched_on' = 'name' and status = 'open'), 'dup gone';
  assert not exists (select 1 from hygiene_findings where check_key = 'accept_no_connect' and status = 'open'), 'accept fixed';
end $$;
select 'ALL 0029 TESTS PASSED' as result;
rollback;
