-- ============================================================================
-- FicStash — let the signed-in owner (the app) insert chapter_updates.
--
-- The on-device refresh pass now re-checks followed ongoing AO3 works on the
-- phone and, when it pulls new chapters, records one row per new chapter in the
-- "New chapters" feed (chapter_updates) — the job the worker's Pass 7 used to do
-- alone. 0015 left this table owner select+update only (the worker, via
-- service_role, did the inserts). Grant the owner INSERT so the on-device pass can
-- write the feed. is_owner()-gated like every other policy; worker unaffected.
-- Idempotent (drop-then-create), matching 0015/0023.
-- ============================================================================

drop policy if exists chapter_updates_insert on public.chapter_updates;
create policy chapter_updates_insert on public.chapter_updates for insert to authenticated with check (public.is_owner());

grant insert on public.chapter_updates to authenticated;
