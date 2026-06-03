-- ============================================================================
-- FicStash — let the app remove its own link requests.
-- The "Add a work by link" flow (0007) lets the app INSERT a URL and SELECT its
-- status, but only the worker (service_role) could ever clean rows up. Failed or
-- stuck requests then pile up in the library's "Other" tab with no way to
-- dismiss them. Allow the app (anon) to DELETE requested_urls rows so the user
-- can clear out failures themselves.
-- ============================================================================

drop policy if exists requested_urls_delete on public.requested_urls;
create policy requested_urls_delete on public.requested_urls
  for delete to anon, authenticated using (true);

grant delete on public.requested_urls to anon, authenticated;
