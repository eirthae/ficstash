-- ============================================================================
-- FicStash — client-side uploads (Phase B).
-- Until now only the worker (service_role) ever wrote `works`/`chapters`; the
-- app had SELECT plus an UPDATE policy for `hidden` (0009). The revamp lets the
-- user upload a file (EPUB/HTML/TXT) that's parsed *in the app* and inserted
-- directly with the anon key — no worker round-trip, since there's no URL to
-- fetch. That needs INSERT on both tables for anon.
--
-- Single-user private project, so table-wide INSERT policies are fine (mirrors
-- the table-wide UPDATE policy added in 0009). The worker still owns everything
-- it always did; this only opens the one new path the upload UI uses.
-- ============================================================================

-- ---- works: anon may insert an uploaded work -------------------------------
drop policy if exists works_insert on public.works;
create policy works_insert on public.works
  for insert to anon, authenticated with check (true);

-- ---- chapters: anon may insert the uploaded chapters -----------------------
drop policy if exists chapters_insert on public.chapters;
create policy chapters_insert on public.chapters
  for insert to anon, authenticated with check (true);

-- ---- table privileges ------------------------------------------------------
grant insert on public.works    to anon, authenticated;
grant insert on public.chapters to anon, authenticated;
