-- ============================================================================
-- FicStash — tracked tag groups + discovered matches.
-- A "group" is one or more AO3 tags matched together. match_mode = 'all' means
-- a work must have EVERY tag (the default the user wants: e.g. a pairing tag AND
-- "Soulmates AU"); 'any' means at least one. A single tracked tag is just a
-- group of one. Matching is done by the worker via AO3's own tag search, so
-- AO3's canonical-tag/synonym wrangling is respected exactly.
--
-- This is the ONE place the app writes. The user picks/edits groups in-app with
-- the anon key, so tracked_groups gets anon write policies; everything else
-- stays worker-only.
-- ============================================================================

-- ---- tracked_groups (app-writable) -----------------------------------------
create table if not exists public.tracked_groups (
  id           uuid primary key default gen_random_uuid(),
  label        text        not null default '',          -- optional display name
  -- [{ "name": "Soulmates AU", "id": "123", "kind": "freeform" }, ...]
  tags         jsonb       not null default '[]'::jsonb,
  match_mode   text        not null default 'all',        -- 'all' (AND) | 'any' (OR)
  palette      integer     not null default 0,
  last_seen_at timestamptz,                               -- when user last viewed matches
  last_checked timestamptz,                               -- when worker last searched
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---- tag_matches (worker-writable, app reads) ------------------------------
create table if not exists public.tag_matches (
  id             uuid primary key default gen_random_uuid(),
  group_id       uuid        not null references public.tracked_groups (id) on delete cascade,
  source         text        not null default 'ao3',
  source_work_id text        not null,
  title          text        not null default '',
  author         text        not null default '',
  fandom         text        not null default '',
  summary        text        not null default '',
  tags           jsonb       not null default '[]'::jsonb,
  words          integer     not null default 0,
  chapters       integer     not null default 0,
  status         text        not null default 'ongoing',
  source_updated timestamptz,
  palette        integer     not null default 0,
  seen           boolean     not null default false,      -- false = still "fresh"
  first_seen_at  timestamptz not null default now(),
  unique (group_id, source, source_work_id)
);

create index if not exists tag_matches_group_idx
  on public.tag_matches (group_id, first_seen_at desc);

-- ---- keep updated_at fresh on tracked_groups -------------------------------
drop trigger if exists tracked_groups_touch on public.tracked_groups;
create trigger tracked_groups_touch before update on public.tracked_groups
  for each row execute function public.touch_updated_at();

-- ---- row level security ----------------------------------------------------
alter table public.tracked_groups enable row level security;
alter table public.tag_matches    enable row level security;

-- tracked_groups: the app (anon) may read AND write — this is the only
-- app-writable table. Single-user private project, so full CRUD for anon here.
drop policy if exists tracked_groups_read on public.tracked_groups;
create policy tracked_groups_read on public.tracked_groups
  for select to anon, authenticated using (true);

drop policy if exists tracked_groups_insert on public.tracked_groups;
create policy tracked_groups_insert on public.tracked_groups
  for insert to anon, authenticated with check (true);

drop policy if exists tracked_groups_update on public.tracked_groups;
create policy tracked_groups_update on public.tracked_groups
  for update to anon, authenticated using (true) with check (true);

drop policy if exists tracked_groups_delete on public.tracked_groups;
create policy tracked_groups_delete on public.tracked_groups
  for delete to anon, authenticated using (true);

-- tag_matches: read-only for the app; only the worker (service_role) writes.
drop policy if exists tag_matches_read on public.tag_matches;
create policy tag_matches_read on public.tag_matches
  for select to anon, authenticated using (true);

-- App may flip the "seen" flag to clear fresh badges, nothing else.
drop policy if exists tag_matches_mark_seen on public.tag_matches;
create policy tag_matches_mark_seen on public.tag_matches
  for update to anon, authenticated using (true) with check (true);

-- ---- table privileges (Management-API-created tables need explicit grants) --
grant select, insert, update, delete on public.tracked_groups to service_role;
grant select, insert, update, delete on public.tracked_groups to anon, authenticated;
grant select, insert, update, delete on public.tag_matches    to service_role;
grant select, update                 on public.tag_matches    to anon, authenticated;
