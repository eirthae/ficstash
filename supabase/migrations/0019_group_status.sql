-- ============================================================================
-- FicStash — completion-status filter on tracked tag groups.
--
-- A tracked group can now restrict discovery to a completion status, alongside
-- its include/exclude tags:
--   * 'all'      → no completion filter (default; previous behaviour)
--   * 'ongoing'  → works in progress only (AO3 complete=F)
--   * 'complete' → finished works only   (AO3 complete=T)
-- The worker passes this to each source's own search so non-matching works never
-- become matches in the first place.
-- ============================================================================

alter table public.tracked_groups
  add column if not exists status text not null default 'all';
