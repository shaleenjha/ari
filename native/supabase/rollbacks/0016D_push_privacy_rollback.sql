-- rollback 0016 D: back to the 0015 replied-only body (trigger notifications_privacy stays; to remove it too, run 0015_rollback.sql)
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
