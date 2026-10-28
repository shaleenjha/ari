-- 0036 (Oct 18 2026, Otto). Tested on staging ljojwhnfgfreokqspobg 00:35 IST: fix, idempotent rerun, wrong-content refusal, unappend backfill only, anon/authenticated denied.
-- Spec docs/specs/05_log_history_repair.md. Why: ari_worker may only UPDATE log_entries(sheet_key) (0018) and cannot DELETE,
-- so the worker cannot rewrite the content of the 3 column-swapped Log rows, nor undo an appended row on rollback.
-- Two narrow SECURITY DEFINER functions, ari_worker only:
--   ari_worker_log_repair(old_key, new_key, expect, set): updates ONE row found by its old sheet_key, only when its current
--     content equals `expect` (optimistic check, minute precision on ts); sets ts/person_id/event/detail/sheet_key from `set`.
--     Idempotent: no row with old_key but a row with new_key already equal to `set` -> {"already": true}.
--   ari_worker_log_unappend(key): deletes one row, only when source = 'backfill' and it was created in the last 7 days.
-- workspace_id (0033/0034): not touched; ws_guard fires only on UPDATE OF workspace_id, inserts keep the column default.
-- Lands after 0035 (or alongside it in the same window while the PAT is live). Rollback: drop both functions.

create or replace function public.ari_worker_log_repair(p_old_key text, p_new_key text, p_expect jsonb, p_set jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.log_entries; n int;
begin
  if p_old_key is null or p_new_key is null or p_expect is null or p_set is null then raise exception 'bad args'; end if;
  if p_new_key !~ '^[0-9a-f]{20}#[0-9]+$' or p_old_key !~ '^[0-9a-f]{20}#[0-9]+$' then raise exception 'bad key'; end if;
  if coalesce(p_set->>'event', '') = '' or (p_set->>'ts') is null then raise exception 'bad set'; end if;
  perform set_config('ari.actor', 'backfill', true);
  update public.log_entries l set
      ts = case when date_trunc('minute', l.ts) = date_trunc('minute', (p_set->>'ts')::timestamptz) then l.ts
                else (p_set->>'ts')::timestamptz end,
      person_id = p_set->>'person_id', event = p_set->>'event', detail = p_set->>'detail', sheet_key = p_new_key
   where l.sheet_key = p_old_key
     and date_trunc('minute', l.ts) = date_trunc('minute', (p_expect->>'ts')::timestamptz)
     and l.person_id is not distinct from (p_expect->>'person_id')
     and l.event = (p_expect->>'event')
     and l.detail is not distinct from (p_expect->>'detail')
  returning * into r;
  get diagnostics n = row_count;
  if n = 1 then return jsonb_build_object('updated', true, 'id', r.id); end if;
  if exists (select 1 from public.log_entries l where l.sheet_key = p_new_key
              and date_trunc('minute', l.ts) = date_trunc('minute', (p_set->>'ts')::timestamptz)
              and l.person_id is not distinct from (p_set->>'person_id') and l.event = (p_set->>'event')
              and l.detail is not distinct from (p_set->>'detail')) then
    return jsonb_build_object('updated', false, 'already', true);
  end if;
  raise exception 'no log row with key % and the expected content', p_old_key;
end $$;

create or replace function public.ari_worker_log_unappend(p_key text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.log_entries where sheet_key = p_key and source = 'backfill' and created_at > now() - interval '7 days';
  get diagnostics n = row_count;
  return jsonb_build_object('deleted', n);
end $$;

revoke all on function public.ari_worker_log_repair(text, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.ari_worker_log_unappend(text) from public, anon, authenticated;
grant execute on function public.ari_worker_log_repair(text, text, jsonb, jsonb) to ari_worker;
grant execute on function public.ari_worker_log_unappend(text) to ari_worker;
notify pgrst, 'reload schema';
