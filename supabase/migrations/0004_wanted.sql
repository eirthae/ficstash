-- ============================================================================
-- FicStash — "Save to library" for tag matches.
-- The app can't fetch a work itself (it only talks to Supabase, never AO3), so
-- saving a discovered match is a request: the app flips `wanted` true, and the
-- worker fetches the full offline copy on its next run, then flips `saved` true
-- (and `wanted` false). The app shows Save → Queued → In library from these.
-- ============================================================================

alter table public.tag_matches
  add column if not exists wanted boolean not null default false;
alter table public.tag_matches
  add column if not exists saved  boolean not null default false;

-- Worker reads pending requests by this; index keeps it cheap.
create index if not exists tag_matches_wanted_idx
  on public.tag_matches (wanted) where wanted = true;

-- anon already has table-wide UPDATE (granted in 0003) behind the
-- tag_matches_mark_seen policy, so it can set `wanted` too — no new grant needed.
