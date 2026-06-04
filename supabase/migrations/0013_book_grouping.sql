-- ============================================================================
-- FicStash — Books shelf: rename, manual series grouping, external links (J2).
-- Uploaded books (origin='upload') often have messy EPUB titles and belong to a
-- series whose order isn't in the metadata. These columns let the app:
--   * custom_title  — override the display title (e.g. add "1", "2", "3")
--   * series_name   — group books into a named series/collection
--   * series_index  — reading order within that series
--   * external_url  — a user-set "open at source" link (Goodreads / a series page)
-- All are app-editable: works already has a table-wide UPDATE policy + grant for
-- anon (0009), so no new policy/grant is needed here.
-- ============================================================================

alter table public.works
  add column if not exists custom_title text,
  add column if not exists series_name  text,
  add column if not exists series_index real,
  add column if not exists external_url text;

-- Browsing a series in reading order is the common Books-shelf query.
create index if not exists works_series_idx
  on public.works (series_name, series_index) where series_name is not null;
