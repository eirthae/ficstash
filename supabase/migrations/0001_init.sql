-- ============================================================================
-- FicStash — initial schema (Phase 1)
-- Single-user private archive. The worker writes with the service_role key
-- (bypasses RLS). The app reads with the anon key, allowed by the SELECT
-- policies below. No anon writes — only the worker mutates data.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---- works -----------------------------------------------------------------
create table if not exists public.works (
  id              uuid primary key default gen_random_uuid(),
  source          text        not null default 'ao3',
  source_work_id  text        not null,
  title           text        not null,
  author          text        not null default '',
  fandom          text        not null default '',
  pairing         text        not null default '',
  summary         text        not null default '',
  tags            jsonb       not null default '[]'::jsonb,   -- [{t,k}]
  words           integer     not null default 0,
  chapters        integer     not null default 0,
  chapters_total  integer,
  status          text        not null default 'ongoing',     -- ongoing | complete
  updated_label   text,                                        -- human label e.g. "3 days ago"
  source_updated  timestamptz,                                 -- real last-updated time
  progress        real        not null default 0,
  last_chapter    integer     not null default 0,
  palette         integer     not null default 0,
  frozen          boolean     not null default false,          -- no longer on AO3
  frozen_date     text,
  unread          boolean     not null default false,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (source, source_work_id)
);

create index if not exists works_source_updated_idx on public.works (source_updated desc nulls last);

-- ---- chapters --------------------------------------------------------------
create table if not exists public.chapters (
  id          uuid primary key default gen_random_uuid(),
  work_id     uuid        not null references public.works (id) on delete cascade,
  n           integer     not null,
  title       text        not null default '',
  words       integer     not null default 0,
  content     text,                                            -- chapter body (HTML/text)
  fetched     boolean     not null default false,
  created_at  timestamptz not null default now(),
  unique (work_id, n)
);

create index if not exists chapters_work_idx on public.chapters (work_id, n);

-- ---- keep updated_at fresh -------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists works_touch on public.works;
create trigger works_touch before update on public.works
  for each row execute function public.touch_updated_at();

-- ---- row level security ----------------------------------------------------
alter table public.works    enable row level security;
alter table public.chapters enable row level security;

-- Single-user private project: allow read with the anon (and authenticated)
-- key. Writes are not granted to anon, so only the service_role worker mutates.
drop policy if exists works_read on public.works;
create policy works_read on public.works
  for select to anon, authenticated using (true);

drop policy if exists chapters_read on public.chapters;
create policy chapters_read on public.chapters
  for select to anon, authenticated using (true);
