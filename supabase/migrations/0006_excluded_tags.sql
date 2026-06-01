-- ============================================================================
-- FicStash — let a tracked group EXCLUDE tags, not just include them.
-- excluded_tags mirrors the `tags` shape ([{ "name", "id", "kind" }, ...]). The
-- worker passes these to AO3's own search as excluded_tag_names, so AO3 drops
-- any work carrying an excluded tag before it ever becomes a match.
-- ============================================================================

alter table public.tracked_groups
  add column if not exists excluded_tags jsonb not null default '[]'::jsonb;
