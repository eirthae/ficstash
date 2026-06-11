-- ============================================================================
-- FicStash — AO3 series support.
--
-- An AO3 work can be "Part N of <Series>". We capture that on the work so the
-- library can auto-group a series together (like Books group by series), and we
-- add a `followed_series` queue that powers two actions from a work's detail:
--   * "Download all works in this series" → a one-shot row (follow = false);
--   * "Follow series"                     → a standing row (follow = true) the
--     worker re-checks each sync, pulling any newly-added works.
-- The worker enumerates the series from AO3's public /series/<id> page and
-- downloads each work via the normal (logged-out, rate-limited) AO3 path.
-- ============================================================================

-- ---- per-work series tagging (auto-grouping) -------------------------------
alter table public.works
  add column if not exists ao3_series_id    text,
  add column if not exists ao3_series_name  text,
  add column if not exists ao3_series_index real;

create index if not exists works_ao3_series_idx
  on public.works (ao3_series_id) where ao3_series_id is not null;

-- ---- followed / requested series queue -------------------------------------
create table if not exists public.followed_series (
  id           uuid primary key default gen_random_uuid(),
  series_id    text not null unique,          -- AO3 series id
  series_name  text not null default '',
  follow       boolean not null default false, -- true = keep watching for new works
  last_checked timestamptz,                    -- last time the worker enumerated it
  created_at   timestamptz not null default now()
);

alter table public.followed_series enable row level security;

drop policy if exists followed_series_read   on public.followed_series;
drop policy if exists followed_series_insert on public.followed_series;
drop policy if exists followed_series_update on public.followed_series;
drop policy if exists followed_series_delete on public.followed_series;

create policy followed_series_read   on public.followed_series for select to authenticated using (public.is_owner());
create policy followed_series_insert on public.followed_series for insert to authenticated with check (public.is_owner());
create policy followed_series_update on public.followed_series for update to authenticated using (public.is_owner()) with check (public.is_owner());
create policy followed_series_delete on public.followed_series for delete to authenticated using (public.is_owner());

revoke select, insert, update, delete on public.followed_series from anon;
revoke select, insert, update, delete on public.followed_series from authenticated;
grant  select, insert, update, delete on public.followed_series to authenticated;
grant  all on public.followed_series to service_role;
