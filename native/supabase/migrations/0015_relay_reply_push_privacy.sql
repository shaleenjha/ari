-- 0015 Relay: generic lock-screen text for EVERY reply push (board fix #9, security/SDR compromise). NOT APPLIED (Oct 16 2026).
-- Why not applied: it adds a BEFORE INSERT trigger on the existing notifications table, which changes the text of pushes
-- written by the existing people_notify trigger. That is a behavior change, not a purely additive one. Apply after Owner/Forge OK.
-- What it closes: 0014's reply_ingest.py already sends generic text for replies it finds. A reply that reaches Supabase another
-- way (worker step 0 writes People.replied in the Sheet, the 10-minute sync copies it, people_notify fires "<Name> replied /
-- <Company>") still shows the name on the lock screen. This guard rewrites title/body of kind 'replied' pushes unless
-- ari_prefs.push_show_names is true. Payload url keeps the person id (not shown on the lock screen) so the tap still opens them.
-- Depends on 0014 (ari_prefs, ari_pref). Rollback: drop trigger notifications_privacy on public.notifications;
--   drop function public.notifications_privacy();

create or replace function public.notifications_privacy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind = 'replied' and coalesce((public.ari_pref('push_show_names', 'false'::jsonb) #>> '{}')::boolean, false) = false then
    new.title := 'New reply on LinkedIn';
    new.body := 'Someone you messaged wrote back. Open Ari to answer.';
  end if;
  return new;
end $$;
revoke all on function public.notifications_privacy() from public, anon, authenticated;

drop trigger if exists notifications_privacy on public.notifications;
create trigger notifications_privacy before insert on public.notifications
  for each row execute function public.notifications_privacy();
