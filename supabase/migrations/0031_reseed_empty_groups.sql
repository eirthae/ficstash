-- Re-seed tracked groups that were marked "checked" but never got any matches.
--
-- The app stamped tracked_groups.last_checked after an on-device discovery even
-- when that discovery had FAILED — searchTags returned [] for both "AO3 says no
-- works" and "AO3 was unreadable", so a Cloudflare 525 looked like an empty tag.
-- A brand-new group therefore lost its all-time back-catalogue seed and dropped
-- to a one-day incremental window, so it sat at 0 matches indefinitely.
--
-- Clearing last_checked puts the group back to "never checked", which the worker
-- treats as a first run and seeds all-time. Only groups with NO matches at all
-- are touched, so nothing that has ever worked is re-fetched. Idempotent: once a
-- group has matches it stops qualifying.
update public.tracked_groups g
   set last_checked = null
 where g.last_checked is not null
   and not exists (select 1 from public.tag_matches m where m.group_id = g.id);
