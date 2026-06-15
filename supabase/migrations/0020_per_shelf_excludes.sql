-- ============================================================================
-- FicStash — per-shelf discovery excludes.
--
-- Until now discovery_prefs.excluded_tags was a single flat array applied to all
-- tag discovery (and in practice only AO3). It is now scoped per Discovery shelf:
--   { "ao3": [...], "sites": [...], "books": [...] }
-- so you can exclude e.g. "litrpg" from Stories without touching AO3. Each entry
-- keeps the {name,id,kind} shape.
--
-- Migrate any existing flat-array value into the AO3 shelf (that's where the old
-- global filter actually applied), and flip the column default to an empty object.
-- The worker + app both tolerate either shape, so this is purely a cleanup.
-- ============================================================================

alter table public.discovery_prefs
  alter column excluded_tags set default '{}'::jsonb;

update public.discovery_prefs
  set excluded_tags = jsonb_build_object(
        'ao3', excluded_tags,
        'sites', '[]'::jsonb,
        'books', '[]'::jsonb)
  where jsonb_typeof(excluded_tags) = 'array';
