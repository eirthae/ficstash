-- ============================================================================
-- FicStash — store an AO3 work's "work skin" CSS.
--
-- Chat / texting / social-media fics use an author Work Skin (CSS scoped to
-- #workskin) to draw message bubbles etc. The worker captures that CSS so the
-- reader can reproduce the look — sanitized + scoped at render so it only styles
-- the author's classed blocks and never the prose typography. Empty for ordinary
-- fics. Backfills onto existing works on a full re-check.
-- ============================================================================

alter table public.works
  add column if not exists work_skin text;
