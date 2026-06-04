-- ============================================================================
-- FicStash — "New chapters" feed. When the refresh pass (worker Pass 7) appends
-- new chapters to an ongoing work it already had offline, it records one row
-- here per new chapter. The app's What's New → New chapters tab reads this (it
-- used to show bundled sample data, which was misleading: it claimed "ready to
-- read" for works that weren't actually downloaded). These are real, already-
-- downloaded chapters, so opening one reads immediately.
-- ============================================================================

create table if not exists public.chapter_updates (
  id              uuid primary key default gen_random_uuid(),
  work_id         uuid        not null references public.works (id) on delete cascade,
  source          text        not null default 'ao3',
  source_work_id  text        not null,
  chapter_n       integer     not null,
  title           text        not null default '',
  words           integer     not null default 0,
  created_at      timestamptz not null default now(),
  seen            boolean     not null default false
);

-- Feed query is newest-first; one row per (work, chapter).
create index if not exists chapter_updates_recent_idx
  on public.chapter_updates (created_at desc);
create unique index if not exists chapter_updates_work_chap_idx
  on public.chapter_updates (work_id, chapter_n);

alter table public.chapter_updates enable row level security;

-- App reads the feed and may flip `seen`; only the worker (service_role) writes.
drop policy if exists chapter_updates_read on public.chapter_updates;
create policy chapter_updates_read on public.chapter_updates
  for select to anon, authenticated using (true);
drop policy if exists chapter_updates_mark_seen on public.chapter_updates;
create policy chapter_updates_mark_seen on public.chapter_updates
  for update to anon, authenticated using (true) with check (true);

grant select, insert, update, delete on public.chapter_updates to service_role;
grant select, update                 on public.chapter_updates to anon, authenticated;
