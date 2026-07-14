-- ============================================================================
-- FicStash — keys-only "dismissed" tombstone.
--
-- Dismissing a discovery suggestion now HARD-DELETEs its tag_matches row (frees the
-- metadata that was quietly filling the DB; see docs/supabase-storage.md). A deleted
-- row can't carry a 'dismissed' flag across a later tag search, so the work would
-- re-surface. This tiny table remembers just the KEYS of dismissed works — a few
-- bytes each vs a full metadata row — and discovery (worker + on-device) skips them
-- on upsert, so a dismissed work is never re-added.
-- ============================================================================

create table if not exists public.dismissed_matches (
  id             bigint generated always as identity primary key,
  source         text        not null default 'ao3',
  source_work_id text        not null,
  created_at     timestamptz not null default now(),
  unique (source, source_work_id)
);

create index if not exists dismissed_matches_key_idx
  on public.dismissed_matches (source, source_work_id);

alter table public.dismissed_matches enable row level security;

-- Single-user private project: the app (anon) fully owns this table, like
-- tracked_groups. The worker (service_role) reads it to skip dismissed works.
drop policy if exists dismissed_matches_all on public.dismissed_matches;
create policy dismissed_matches_all on public.dismissed_matches
  for all to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on public.dismissed_matches to service_role;
grant select, insert, update, delete on public.dismissed_matches to anon, authenticated;
