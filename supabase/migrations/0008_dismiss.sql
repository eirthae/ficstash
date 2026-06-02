-- ============================================================================
-- FicStash — durable "dismiss" for tag matches.
-- Dismissing a discovered work used to only flip `seen`, but viewing a group
-- already marks every match seen and the results list shows all matches, so a
-- dismissal vanished on reload. `dismissed` is a separate, sticky hide flag:
-- the app filters it out of group results and the What's New feed, and the
-- worker's upsert never writes it, so re-runs don't resurrect a hidden work.
-- ============================================================================

alter table public.tag_matches
  add column if not exists dismissed boolean not null default false;

-- Most reads want the not-dismissed rows for a group; partial index keeps it cheap.
create index if not exists tag_matches_visible_idx
  on public.tag_matches (group_id, first_seen_at desc) where dismissed = false;

-- anon already has table-wide UPDATE (granted in 0003) behind the
-- tag_matches_mark_seen policy, so it can set `dismissed` too — no new grant needed.
