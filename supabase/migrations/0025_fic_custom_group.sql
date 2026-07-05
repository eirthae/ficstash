-- ============================================================================
-- FicStash — manual fic grouping. AO3 works carry multiple fandom tags, so the
-- auto "group by fandom" shelf scatters related works (Batman / Superman / DCU).
-- This adds an optional user-chosen group name that OVERRIDES the fandom when
-- grouping the Fics shelf, so the user can put e.g. all of those under "DCU".
-- Reuses the Books manual-grouping idea (series_name). Nullable; null = fall back
-- to the work's fandom. The owner already has UPDATE on works (0015), so no new
-- policy is needed — just the column.
-- ============================================================================

alter table public.works add column if not exists custom_group text;
