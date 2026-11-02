-- Rollback of 0031 (v18.10.1). Restores the 0011/0012/0016 function bodies and drops what 0031 added.
-- Data note: draft_tags and draft_edits rows are dropped with their tables; copy_guidance rows stay (draft_edit_id column dropped).
begin;
drop trigger if exists queue_rescan_notify on public.queue;
drop function if exists public.queue_rescan_notify();
create or replace function public.people_sent_snapshot() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; ts_new timestamptz; ts_old timestamptz; b text;
begin
  foreach k in array array['dm1','dm2','dm3'] loop
    ts_new := case k when 'dm1' then new.dm1_sent when 'dm2' then new.dm2_sent else new.dm3_sent end;
    ts_old := case when tg_op = 'INSERT' then null else case k when 'dm1' then old.dm1_sent when 'dm2' then old.dm2_sent else old.dm3_sent end end;
    b := case k when 'dm1' then new.dm when 'dm2' then new.dm2_text else new.dm3_text end;
    if ts_new is not null and ts_old is null then
      insert into public.sent_messages(person_id, account_id, kind, body, sent_at, source)
      values (new.id, new.account_id, k, nullif(btrim(coalesce(b, '')), ''), ts_new, 'tick')
      on conflict (person_id, kind) where kind in ('dm1','dm2','dm3') do nothing;
    elsif ts_new is null and ts_old is not null then
      -- undo: the message did not go; keep a record Owner corrected by hand
      delete from public.sent_messages where person_id = new.id and kind = k and source in ('tick','backfill');
    end if;
  end loop;
  return null;
end $$;
create or replace function public.people_copy_guidance() returns trigger
language plpgsql security definer set search_path = public as $$
declare k text; o text; n text; sent timestamptz; ae text;
begin
  if coalesce(new.updated_by, '') not like 'app%' then return null; end if;
  select a.ae into ae from public.accounts a where a.id = new.account_id;
  foreach k in array array['dm1','dm2','dm3'] loop
    o := case k when 'dm1' then old.dm when 'dm2' then old.dm2_text else old.dm3_text end;
    n := case k when 'dm1' then new.dm when 'dm2' then new.dm2_text else new.dm3_text end;
    sent := case k when 'dm1' then old.dm1_sent when 'dm2' then old.dm2_sent else old.dm3_sent end;
    if sent is null and nullif(btrim(coalesce(o, '')), '') is not null and nullif(btrim(coalesce(n, '')), '') is not null and o is distinct from n then
      insert into public.copy_guidance(account_id, company, person_id, ae, kind, before, after, note)
      values (new.account_id, new.company, new.id, coalesce(ae, split_part(coalesce(new.owner, ''), ' ', 1)), k, o, n, 'Owner edited Ari''s draft in the app');
    end if;
  end loop;
  return null;
end $$;
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
create or replace function public.notifications_privacy() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.kind in ('test', 'digest') or coalesce(new.dedupe_key, '') like 'digest:%' then return new; end if;
  if coalesce((public.ari_pref('push_show_names', 'false'::jsonb) #>> '{}')::boolean, false) then return new; end if;
  case new.kind
    when 'replied' then new.title := 'New reply on LinkedIn'; new.body := 'Someone you messaged wrote back. Open Ari to answer.';
    when 'accepted' then new.title := 'New connection accepted'; new.body := 'Their DM1 draft is ready in Ari.';
    when 'meeting' then new.title := 'Meeting set'; new.body := 'Open Ari to see the details.';
    when 'research_done' then new.title := 'Brief ready'; new.body := 'A new account brief is waiting in Ari.';
    when 'draft_due' then
      new.title := case when new.dedupe_key like 'draft:dm1:%' then 'DM1 ready'
                        when new.dedupe_key like 'draft:dm2:%' then 'DM2 drafted'
                        when new.dedupe_key like 'draft:dm3:%' then 'DM3 drafted'
                        else 'Draft ready' end;
      new.body := 'Ready for your review in Ari.';
    else new.title := 'Ari update'; new.body := 'Open Ari to see what changed.';
  end case;
  return new;
end $$;
revoke all on function public.notifications_privacy() from public, anon, authenticated;
drop function if exists public.ari_worker_copy_stats(date, date);
drop function if exists public.ari_worker_untagged_drafts(int);
drop function if exists public.ari_sent_enrich(bigint);
drop function if exists public.ari_worker_draft_tag(text, text, text, jsonb);
drop function if exists public.ari_tags_for(text, text, text);
do $$ begin if exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'draft_edits') then alter publication supabase_realtime drop table public.draft_edits; end if; end $$;
drop table if exists public.draft_edits;
drop table if exists public.draft_tags;
drop index if exists public.copy_guidance_edit;
alter table public.copy_guidance drop column if exists draft_edit_id;
alter table public.sent_messages drop column if exists tags, drop column if exists draft_tag_id, drop column if exists draft_edit_id, drop column if exists ari_original, drop column if exists edit_diff;
drop function if exists public.ari_word_diff(text, text);
drop function if exists public.ari_draft_md5(text);
delete from supabase_migrations.schema_migrations where version = '0031';
commit;
