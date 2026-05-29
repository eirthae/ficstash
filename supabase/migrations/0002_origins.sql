-- ============================================================================
-- FicStash — track where a work comes from on AO3.
-- A work can be bookmarked, subscribed, and/or seen in reading history at once.
--   * offline    = we have the chapter bodies stored (full saved copy).
--   * bookmarked = it's in the user's AO3 bookmarks.
--   * subscribed = the user follows it for new chapters.
--   * in_history = the user has opened it (all-time AO3 usage).
-- Only bookmarked works get full offline copies; history/subscriptions are
-- tracked metadata-only to stay polite to AO3 and keep storage small.
-- ============================================================================

alter table public.works add column if not exists offline    boolean not null default false;
alter table public.works add column if not exists bookmarked boolean not null default false;
alter table public.works add column if not exists subscribed boolean not null default false;
alter table public.works add column if not exists in_history boolean not null default false;

-- Existing rows were all imported from bookmarks with full content.
update public.works set bookmarked = true, offline = true
  where source = 'ao3' and bookmarked = false and offline = false;
