-- ============================================================================
-- FicStash — record a series' total work count.
--
-- The worker enumerates an AO3 series' full work index each sync. Storing the
-- total (including works it can't yet download — e.g. registered-users-only ones
-- that need the logged-in path) lets the Series screen show an honest
-- "X of Y works downloaded", so a gap is visible rather than silent.
-- ============================================================================

alter table public.followed_series
  add column if not exists work_count int;
