-- ============================================================================
-- FicStash — "Add a work by link".
-- The app only talks to Supabase, never to a fiction site directly (CORS + the
-- politeness rule), so adding an arbitrary story URL is a request: the app
-- inserts a row here, fires the worker (trigger-sync), and the worker downloads
-- the work with FanFicFare and stores a full offline copy like any other work.
--
-- This is the second app-writable surface (after tracked_groups): the app may
-- INSERT a URL and SELECT its status; only the worker (service_role) updates a
-- request's progress.
-- ============================================================================

-- Canonical story URL for works that came from a pasted link (so the app can
-- link back out, and the worker can re-fetch). Null for AO3-sourced works.
alter table public.works
  add column if not exists source_url text;

-- ---- requested_urls (app inserts, worker processes) ------------------------
create table if not exists public.requested_urls (
  id             uuid        primary key default gen_random_uuid(),
  url            text        not null,
  status         text        not null default 'queued',  -- queued | fetching | done | error
  source         text,                                    -- detected site id, set by worker
  source_work_id text,                                    -- set when the work row is created
  title          text,                                    -- filled in once metadata is known
  error          text,                                    -- failure message when status = 'error'
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists requested_urls_status_idx
  on public.requested_urls (status) where status in ('queued', 'fetching');

drop trigger if exists requested_urls_touch on public.requested_urls;
create trigger requested_urls_touch before update on public.requested_urls
  for each row execute function public.touch_updated_at();

-- ---- row level security ----------------------------------------------------
alter table public.requested_urls enable row level security;

-- App may add a request and watch its status; the worker owns all updates.
drop policy if exists requested_urls_read on public.requested_urls;
create policy requested_urls_read on public.requested_urls
  for select to anon, authenticated using (true);

drop policy if exists requested_urls_insert on public.requested_urls;
create policy requested_urls_insert on public.requested_urls
  for insert to anon, authenticated with check (true);

-- ---- table privileges (Management-API-created tables need explicit grants) --
grant select, insert, update, delete on public.requested_urls to service_role;
grant select, insert                 on public.requested_urls to anon, authenticated;
