-- Durable reading state, so "have I read this?" survives a reinstall.
--
-- The reader has always written progress to the device only (localStorage, now
-- Capacitor Preferences). Android's WebView drops localStorage between cold
-- starts — the same thing that used to reset the reader's font — so reading
-- history vanished periodically and the library's Unread sort re-listed
-- everything. Preferences fixes the cold-start case; this row-level copy is what
-- survives a reinstall, a cleared app, or a second device.
--
-- `progress` and `last_chapter` already exist on works (0001) and have never
-- been written by anything; the reader now maintains them. `read_seconds` is the
-- new signal: total ACTIVE seconds spent reading the work, accumulated across
-- sessions, which is what the Unread rule keys on.
alter table public.works
  add column if not exists read_seconds integer not null default 0;

-- No new policy: 0015 already grants the signed-in owner UPDATE on works
-- (works_update / is_owner), which is what the reader writes through. Adding an
-- anon policy here would re-open exactly what 0015 locked down.

-- The Unread sort reads these for the whole shelf on every library open.
create index if not exists works_read_seconds_idx
  on public.works (read_seconds)
  where hidden = false;
