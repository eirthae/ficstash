-- Rotate the new-chapter check, so no ongoing work goes permanently unchecked.
--
-- fetch_ongoing_offline_works ordered by source_updated DESC — newest activity
-- first — with nothing tracking what had actually been re-checked. That is fine
-- while the pass completes, but it stopped completing: the 2026-10-19 nightly
-- had 498 ongoing works and the time budget cut the pass after ~174. Because
-- the order never varied, it was the SAME newest 174 every night and the other
-- ~324 were never checked for new chapters at all. Worse, it is
-- self-reinforcing: a work that misses a check keeps sliding down the ordering.
--
-- Same bug class as tracked_groups having no ORDER BY (v0.8.66). The cure is the
-- same — stamp when we last looked, then take the stalest first, so truncation
-- rotates instead of cutting at the same place forever.
alter table public.works
  add column if not exists last_refreshed timestamptz;

-- The refresh pass reads this for every ongoing work on every run.
create index if not exists works_last_refreshed_idx
  on public.works (last_refreshed nulls first)
  where offline = true and hidden = false and status <> 'complete';
