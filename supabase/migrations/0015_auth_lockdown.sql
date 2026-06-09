-- ============================================================================
-- FicStash — privacy lockdown (require login to read/write the library).
--
-- Until now this was a "single-user private project" that nonetheless let the
-- public **anon** key read every table (works, chapters, tracked groups, …).
-- Because the anon key necessarily ships inside the APK and the public intake
-- web page, anyone who found it could read the whole reading list. That is the
-- hole this migration closes.
--
-- After this runs:
--   * the anon key can read/write NOTHING (all anon grants + policies revoked);
--   * only a logged-in session whose user id is registered in `app_owners`
--     (i.e. you) may read/write — enforced by is_owner() in every policy;
--   * the worker is UNAFFECTED: service_role bypasses RLS entirely.
--
-- No personal data (email, user id) is committed here. After applying this you
-- seed your own account once — see the SEED note at the bottom.
-- ============================================================================

-- ---- owner registry --------------------------------------------------------
-- Holds the auth user id(s) allowed to use the app. Normally exactly one row.
create table if not exists public.app_owners (
  user_id    uuid primary key,
  note       text,
  created_at timestamptz not null default now()
);

alter table public.app_owners enable row level security;
-- Only the server (service_role) and the SQL editor (postgres) touch this table.
-- No anon/authenticated grants at all → the list of owners is itself private.
revoke all on public.app_owners from anon, authenticated;
grant  all on public.app_owners to service_role;

-- True iff the current request is an authenticated owner. SECURITY DEFINER so
-- the policy can consult app_owners even though the caller can't read it.
create or replace function public.is_owner()
  returns boolean
  language sql
  stable
  security definer
  set search_path = public
as $$
  select exists (
    select 1 from public.app_owners o where o.user_id = auth.uid()
  );
$$;

revoke all on function public.is_owner() from public;
grant execute on function public.is_owner() to anon, authenticated;

-- ---- works -----------------------------------------------------------------
drop policy if exists works_read   on public.works;
drop policy if exists works_update on public.works;   -- 0009 (hide)
drop policy if exists works_insert on public.works;   -- 0012 (uploads)

create policy works_read   on public.works for select to authenticated using (public.is_owner());
create policy works_insert on public.works for insert to authenticated with check (public.is_owner());
create policy works_update on public.works for update to authenticated using (public.is_owner()) with check (public.is_owner());

revoke select, insert, update, delete on public.works from anon;
revoke select, insert, update, delete on public.works from authenticated;
grant  select, insert, update         on public.works to authenticated;

-- ---- chapters --------------------------------------------------------------
drop policy if exists chapters_read   on public.chapters;
drop policy if exists chapters_insert on public.chapters; -- 0012 (uploads)

create policy chapters_read   on public.chapters for select to authenticated using (public.is_owner());
create policy chapters_insert on public.chapters for insert to authenticated with check (public.is_owner());

revoke select, insert, update, delete on public.chapters from anon;
revoke select, insert, update, delete on public.chapters from authenticated;
grant  select, insert                 on public.chapters to authenticated;

-- ---- tracked_groups (tracked tag groups = your interests) ------------------
drop policy if exists tracked_groups_read   on public.tracked_groups;
drop policy if exists tracked_groups_insert on public.tracked_groups;
drop policy if exists tracked_groups_update on public.tracked_groups;
drop policy if exists tracked_groups_delete on public.tracked_groups;

create policy tracked_groups_read   on public.tracked_groups for select to authenticated using (public.is_owner());
create policy tracked_groups_insert on public.tracked_groups for insert to authenticated with check (public.is_owner());
create policy tracked_groups_update on public.tracked_groups for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy tracked_groups_delete on public.tracked_groups for delete to authenticated using (public.is_owner());

revoke select, insert, update, delete on public.tracked_groups from anon;
revoke select, insert, update, delete on public.tracked_groups from authenticated;
grant  select, insert, update, delete on public.tracked_groups to authenticated;

-- ---- tag_matches -----------------------------------------------------------
drop policy if exists tag_matches_read   on public.tag_matches;
drop policy if exists tag_matches_update on public.tag_matches;

create policy tag_matches_read   on public.tag_matches for select to authenticated using (public.is_owner());
create policy tag_matches_update on public.tag_matches for update to authenticated using (public.is_owner()) with check (public.is_owner());

revoke select, insert, update, delete on public.tag_matches from anon;
revoke select, insert, update, delete on public.tag_matches from authenticated;
grant  select, update                 on public.tag_matches to authenticated;

-- ---- requested_urls (your queued links) ------------------------------------
drop policy if exists requested_urls_read   on public.requested_urls;
drop policy if exists requested_urls_insert on public.requested_urls;
drop policy if exists requested_urls_delete on public.requested_urls;

create policy requested_urls_read   on public.requested_urls for select to authenticated using (public.is_owner());
create policy requested_urls_insert on public.requested_urls for insert to authenticated with check (public.is_owner());
create policy requested_urls_delete on public.requested_urls for delete to authenticated using (public.is_owner());

revoke select, insert, update, delete on public.requested_urls from anon;
revoke select, insert, update, delete on public.requested_urls from authenticated;
grant  select, insert, delete         on public.requested_urls to authenticated;

-- ---- chapter_updates (new-chapter feed) ------------------------------------
drop policy if exists chapter_updates_read   on public.chapter_updates;
drop policy if exists chapter_updates_update on public.chapter_updates;

create policy chapter_updates_read   on public.chapter_updates for select to authenticated using (public.is_owner());
create policy chapter_updates_update on public.chapter_updates for update to authenticated using (public.is_owner()) with check (public.is_owner());

revoke select, insert, update, delete on public.chapter_updates from anon;
revoke select, insert, update, delete on public.chapter_updates from authenticated;
grant  select, update                 on public.chapter_updates to authenticated;

-- ============================================================================
-- SEED (run ONCE, separately — NOT part of the committed migration so no email
-- lands in the repo). In the Supabase SQL editor, after creating your auth user:
--
--   insert into public.app_owners (user_id, note)
--   select id, 'primary' from auth.users where email = 'you@example.com'
--   on conflict (user_id) do nothing;
--
-- Verify with:  select * from public.app_owners;
-- ============================================================================
