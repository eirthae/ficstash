-- ============================================================================
-- FicStash — remember WHEN the user last read each history work.
-- AO3's reading-history page exposes a "last visited" date per work; we store
-- it so the app can build an archive shelf (e.g. "completed works I read in
-- 2024-25"). This stays metadata-only — history works are never downloaded in
-- full unless the user explicitly saves them.
-- Note: AO3 does NOT expose which history works the user left kudos on, so a
-- kudos filter isn't possible here.
-- ============================================================================

alter table public.works add column if not exists history_read_at timestamptz;
