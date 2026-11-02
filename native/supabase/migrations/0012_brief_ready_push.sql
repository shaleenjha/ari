-- v18.2.2 (Oct 16, 2026): push "Brief ready" from Ari when an account brief turns ready (Owner wants brief pings in Ari, not Hark chat).
-- Reuses kind 'research_done' so every existing subscription already accepts it. Tap opens the account page on Brief.
create or replace function public.account_briefs_notify() returns trigger
language plpgsql security definer set search_path = public as $$
declare co text;
begin
  if new.status = 'ready' and (tg_op = 'INSERT' or old.status is distinct from 'ready') then
    co := coalesce(nullif(new.company, ''), (select a.company from public.accounts a where a.id = new.account_id), 'an account');
    insert into public.notifications(kind, dedupe_key, title, body, url, account_id)
    values ('research_done', 'brief:' || new.account_id || ':' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'),
            'Brief ready: ' || co,
            coalesce(left(nullif(new.thesis, ''), 140), 'Read it and do the quick check to unlock drafts.'),
            '/ops?open=account:' || new.account_id || ':brief', new.account_id)
    on conflict (dedupe_key) do nothing;
  end if;
  return null;
end $$;
drop trigger if exists account_briefs_notify on public.account_briefs;
create trigger account_briefs_notify after insert or update of status on public.account_briefs
  for each row execute function public.account_briefs_notify();
