-- Ari v17.1.2 (Oct 16, 2026): scan heartbeat for the header hourglass.
-- One row (id = 1), written by scripts/sync_sheet_supabase.py with the service role:
--   at the start of a real sync run: running = true, last_started_at = now()
--   at the end:                       running = false, last_scan_at = now(), next_scan_at, changes
-- The scheduled sync (task 56e17ef1) fires every 600 s on a fixed grid from anchor_at; the worker (e8fbd86f)
-- also runs the same sync after runs that changed the Sheet, so next_scan_at is the next grid slot, not
-- last_scan_at + 600. The app reads it (owner-only RLS) and follows it over realtime. Nothing in the app writes it.

create table if not exists public.scan_heartbeat (
  id int primary key default 1 check (id = 1),
  last_scan_at timestamptz,             -- end of the newest completed sync (any trigger)
  last_started_at timestamptz,          -- start of the newest sync run
  running boolean not null default false,
  interval_sec int not null default 600,
  anchor_at timestamptz,                -- a slot of the scheduled 10-minute grid
  next_scan_at timestamptz,             -- next scheduled slot after last_scan_at
  trigger text,                         -- 'scheduled' | 'worker' | 'manual' (best effort, from the run time)
  changes jsonb not null default '{}'::jsonb,  -- {to_app, to_sheet, log, book, seconds}
  checks text[] not null default '{linkedin_emails,drafts,research,sheet}',
  updated_at timestamptz not null default now()
);

insert into public.scan_heartbeat(id, anchor_at, interval_sec)
values (1, '2026-10-16T03:03:00Z', 600)
on conflict (id) do nothing;

alter table public.scan_heartbeat enable row level security;
drop policy if exists owner_read on public.scan_heartbeat;
create policy owner_read on public.scan_heartbeat for select to authenticated using (public.is_owner());
revoke all on public.scan_heartbeat from anon;
revoke insert, update, delete, truncate on public.scan_heartbeat from authenticated;
grant select on public.scan_heartbeat to authenticated;

do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'scan_heartbeat') then
    alter publication supabase_realtime add table public.scan_heartbeat;
  end if;
end $$;
