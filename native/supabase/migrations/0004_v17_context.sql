-- 0004 (v17, Oct 16 2026): People.context (personal context from the app, mirrored to the Sheet column "context"),
-- and no push for a tick Owner made himself in the app (accepted / replied / meeting marked on his phone).
alter table public.people add column if not exists context text;
CREATE OR REPLACE FUNCTION public.people_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  ins boolean := tg_op = 'INSERT';
  who text := coalesce(new.name, 'Someone');
  co text := coalesce(nullif(new.company, ''), 'their company');
  url text := '/ops?open=person:' || new.id;
  research_now boolean;
begin
  if coalesce(new.updated_by, '') like 'backfill%' then return null; end if;
  if new.review = 'personal' or new.deleted_at is not null or new.stage in ('Hold', 'Founder') then return null; end if;

  if new.accepted is not null and (ins or old.accepted is null) and coalesce(new.updated_by, '') not like 'app%' then
    perform public.ari_notify('accepted', 'accepted:' || new.id, who || ' accepted',
      co || case when coalesce(new.dm, '') <> '' then '. DM1 draft is ready.' else '. I''m on the DM1.' end, url, new.id, new.account_id);
  end if;
  if new.replied is not null and (ins or old.replied is null) and coalesce(new.updated_by, '') not like 'app%' then
    perform public.ari_notify('replied', 'replied:' || new.id, who || ' replied', co || '. Open LinkedIn, I''ll draft your answer.', url, new.id, new.account_id);
  end if;
  if new.meeting is not null and (ins or old.meeting is null) and coalesce(new.updated_by, '') not like 'app%' then
    perform public.ari_notify('meeting', 'meeting:person:' || new.id, 'Meeting set with ' || who, co || '. Log it in SFDC.', url, new.id, new.account_id);
  end if;

  research_now := coalesce(new.research, '') in ('done', 'Draft ready')
                  and not ins and coalesce(old.research, '') ilike 'research%';
  if research_now then
    perform public.ari_notify('research_done', 'research:' || new.id || ':' || to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD'),
      'Research done: ' || who,
      co || case when coalesce(new.dm, '') <> '' and new.dm1_sent is null then '. DM1 draft is ready to send.' else '.' end, url, new.id, new.account_id);
  elsif new.accepted is not null and new.dm1_sent is null and coalesce(new.dm, '') <> ''
        and (ins or coalesce(old.dm, '') = '') then
    perform public.ari_notify('draft_due', 'draft:dm1:' || new.id, 'DM1 ready for ' || who, co || '. Ready for you to send.', url, new.id, new.account_id);
  end if;
  if not ins and coalesce(new.dm2_text, '') <> '' and coalesce(old.dm2_text, '') = '' and new.dm2_sent is null and new.replied is null then
    perform public.ari_notify('draft_due', 'draft:dm2:' || new.id, 'DM2 drafted for ' || who,
      co || coalesce('. Due ' || to_char(new.dm2_due, 'Mon DD') || '.', '.'), url, new.id, new.account_id);
  end if;
  if not ins and coalesce(new.dm3_text, '') <> '' and coalesce(old.dm3_text, '') = '' and new.dm3_sent is null and new.replied is null then
    perform public.ari_notify('draft_due', 'draft:dm3:' || new.id, 'DM3 drafted for ' || who,
      co || coalesce('. Due ' || to_char(new.dm3_due, 'Mon DD') || '.', '.'), url, new.id, new.account_id);
  end if;
  return null;
end $function$;

CREATE OR REPLACE FUNCTION public.accounts_notify()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(new.updated_by, '') like 'backfill%' then return null; end if;
  if coalesce(new.updated_by, '') not like 'app%' and lower(coalesce(new.meeting_status, '')) = 'set'
     and (tg_op = 'INSERT' or lower(coalesce(old.meeting_status, '')) <> 'set') then
    perform public.ari_notify('meeting', 'meeting:account:' || new.id || ':' || coalesce(new.meeting_date, ''),
      'Meeting set: ' || new.company,
      concat_ws(' · ', nullif(new.meeting_person, ''), nullif(new.meeting_date, ''), nullif(new.meeting_ae, '')),
      '/ops?open=account:' || new.id, null, new.id);
  end if;
  return null;
end $function$;
