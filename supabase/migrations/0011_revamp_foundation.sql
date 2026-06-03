-- ============================================================================
-- FicStash — revamp foundation: curated multi-source reader.
-- The app is moving away from mirroring an AO3 account (auto-importing bookmarks
-- and subscriptions) toward a reader you curate from several sources. This
-- migration adds the columns that pivot makes necessary, without touching the
-- data that's already there.
--
--   1. tag_matches.later — the new "Later" swipe lane. A discovered match
--      already has sticky flags for the other lanes: `wanted`/`saved` (the Save
--      button → download) and `dismissed` (removed forever, kept as a tombstone
--      so re-runs don't resurrect it — see 0008). The revamp's swipe gestures map
--      onto them: swipe RIGHT = dismiss, Save button = wanted. The only lane with
--      no flag yet is swipe LEFT = "keep the blurb/tags but don't download" — a
--      maybe-pile the user can revisit. That's this boolean.
--   2. tracked_groups.source + backfill_cursor — a group can track a tag on any
--      source, not just AO3; the cursor lets discovery page newest-first and
--      backfill older works cheaply over later runs.
--   3. works.origin + follow — where a work entered the library ('bookmark' from
--      the old account import, 'link' from add-by-link, 'tag' from discovery,
--      'upload' from a file), and whether the user wants new chapters auto-fetched.
-- ============================================================================

-- ---- tag_matches: "Later" maybe-pile ---------------------------------------
-- Swipe LEFT keeps a match's metadata around without downloading it. Distinct
-- from `saved` (full offline copy queued) and `dismissed` (gone forever).
alter table public.tag_matches
  add column if not exists later boolean not null default false;

-- The Later stash query filters on this; partial index keeps it cheap.
create index if not exists tag_matches_later_idx
  on public.tag_matches (first_seen_at desc) where later = true;

-- anon already has table-wide UPDATE on tag_matches (0003), so flipping `later`
-- needs no new grant.

-- ---- tracked_groups: source + backfill cursor ------------------------------
alter table public.tracked_groups
  add column if not exists source text not null default 'ao3';
-- How far back discovery has paged for this group (source-defined: an AO3 search
-- page number, a date, etc.). NULL = only the newest page fetched so far.
alter table public.tracked_groups
  add column if not exists backfill_cursor text;
alter table public.tracked_groups
  add column if not exists backfill_done boolean not null default false;

-- ---- works: origin + follow ------------------------------------------------
-- 'bookmark' (legacy account import) | 'link' (add-by-link) | 'tag' (discovery
-- Save) | 'upload' (user file). The default suits the legacy AO3 rows (all from
-- the bookmark import); below we correct the link rows, which aren't AO3.
alter table public.works
  add column if not exists origin text not null default 'bookmark';
-- Anything not from AO3 was added by pasting a URL — mark it 'link'. (AO3 rows
-- stay 'bookmark'; tag-saved AO3 works can't be told apart retroactively, but
-- the worker stamps origin='tag' on new ones going forward.)
update public.works set origin = 'link' where source <> 'ao3' and origin = 'bookmark';

-- The user wants new chapters of ongoing works pulled automatically.
alter table public.works
  add column if not exists follow boolean not null default false;

create index if not exists works_origin_idx on public.works (origin);
create index if not exists works_follow_idx on public.works (follow) where follow = true;

-- ---- app write access for the new flags ------------------------------------
-- The app already has table-wide UPDATE on tag_matches (0003) and works (0009),
-- so flipping later/origin/follow needs no new grant. tracked_groups is fully
-- app-writable (0003), so source/backfill_cursor are covered too. Nothing more
-- to grant here — this block is a note, not a no-op to forget later.
