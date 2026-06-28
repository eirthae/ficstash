-- ============================================================================
-- FicStash — let the signed-in owner (the app) write discovery + downloads.
--
-- AO3 Cloudflare-525s datacenter IPs (Supabase, the GitHub Actions worker) but
-- answers a residential device, so AO3 fetching is moving ON-DEVICE — the phone
-- runs the tag search / work download and writes the results straight to
-- Supabase, which stays the cloud store (your library still follows you to a new
-- phone). For that the owner needs a few more table privileges than the original
-- lockdown (0015) granted, where these tables were worker-only:
--
--   * tag_matches — app now INSERTs discovered matches and DELETEs them on a
--     group edit (UPDATE for seen/wanted/dismissed/later was already granted).
--   * chapters    — app now UPDATEs (a re-fetch overwrites a chapter via upsert)
--     and DELETEs (replace a work's chapters). INSERT + SELECT already granted.
--   * works already had owner INSERT + UPDATE (0015), so it needs nothing here.
--
-- All gated by is_owner(), exactly like every other policy. The worker keeps
-- using service_role, which bypasses RLS, so its behaviour is unchanged.
-- Idempotent: drop-then-create, matching 0015's pattern.
-- ============================================================================

-- ---- tag_matches: owner INSERT + DELETE ------------------------------------
drop policy if exists tag_matches_insert on public.tag_matches;
drop policy if exists tag_matches_delete on public.tag_matches;

create policy tag_matches_insert on public.tag_matches for insert to authenticated with check (public.is_owner());
create policy tag_matches_delete on public.tag_matches for delete to authenticated using (public.is_owner());

grant insert, delete on public.tag_matches to authenticated;

-- ---- chapters: owner UPDATE + DELETE ---------------------------------------
drop policy if exists chapters_update on public.chapters;
drop policy if exists chapters_delete on public.chapters;

create policy chapters_update on public.chapters for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy chapters_delete on public.chapters for delete to authenticated using (public.is_owner());

grant update, delete on public.chapters to authenticated;
