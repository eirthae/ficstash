-- ============================================================================
-- FicStash — remove a work from the app without un-bookmarking it on AO3.
-- The user may bookmark something on AO3 but not want it cluttering the app.
-- A hard delete wouldn't stick: the next sync re-adds it from the bookmark list.
-- So "remove" sets a durable `hidden` flag instead — the app filters hidden
-- works out, and the worker skips re-adding / re-downloading them.
-- ============================================================================

alter table public.works
  add column if not exists hidden boolean not null default false;

-- App reads filter on this; partial index keeps the visible-works query cheap.
create index if not exists works_visible_idx
  on public.works (source_updated desc nulls last) where hidden = false;

-- The app (anon) may flip `hidden` to remove a work. Single-user private
-- project, so a table-wide update policy is fine — mirrors tracked_groups.
drop policy if exists works_mark_hidden on public.works;
create policy works_mark_hidden on public.works
  for update to anon, authenticated using (true) with check (true);

grant update on public.works to anon, authenticated;
