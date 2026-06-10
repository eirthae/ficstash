-- ============================================================================
-- FicStash — flag AO3 works restricted to logged-in members.
--
-- Some AO3 works are visible only to registered (logged-in) users. FicStash
-- runs logged-out (never stores the AO3 password), so a guest session can't
-- fetch them — the download fails with 0 chapters and would otherwise retry
-- forever. We detect the members-only login redirect, set `restricted = true`,
-- stop retrying, and the app shows a "read on AO3" label instead of a stuck,
-- empty entry.
-- ============================================================================
alter table public.works
  add column if not exists restricted boolean not null default false;
