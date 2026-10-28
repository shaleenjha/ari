-- Rollback for 0023_meeting_source_report.sql (stored meeting_source values stay as normalised; they are plain text).
drop trigger if exists accounts_meeting_source_norm on public.accounts;
drop function if exists public.accounts_meeting_source_norm();
drop function if exists public.report_attribution(text, date, date, text, text, text);
drop function if exists public.ari_meeting_source_norm(text);
delete from supabase_migrations.schema_migrations where version = '0023';
