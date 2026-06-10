-- ============================================================================
-- FicStash — global discovery filters (user-editable, applied to tag discovery).
--
-- Until now the language allowlist lived in a worker env var (ALLOWED_LANGUAGES)
-- and tag excludes were per-group only. This adds a single, app-editable row of
-- *global* discovery preferences:
--   * languages     — only surface tag-discovery matches in these languages
--                     (empty = all languages, no filter). Each entry carries the
--                     AO3 code + the native + English spellings so the worker can
--                     match a work's language string without its own lookup table.
--   * excluded_tags — never surface a work carrying any of these tags. On AO3
--                     ratings ARE tags ("Explicit", "Mature", …), so this also
--                     powers "exclude Explicit". Same shape as tracked_groups.
--
-- Single row (id = 1). Owner-locked like every other table (migration 0015);
-- the worker reads it with service_role (bypasses RLS).
-- ============================================================================

create table if not exists public.discovery_prefs (
  id            integer     primary key default 1,
  languages     jsonb       not null default '[]'::jsonb,  -- [{code,native,english}]
  excluded_tags jsonb       not null default '[]'::jsonb,  -- [{name,id,kind}]
  updated_at    timestamptz not null default now(),
  constraint discovery_prefs_singleton check (id = 1)
);

-- Seed the single row with today's default language allowlist, so discovery
-- behaviour is unchanged until the user edits it in the app. Empty it to allow
-- every language.
insert into public.discovery_prefs (id, languages) values (
  1,
  '[{"code":"en","native":"English","english":"English"},
    {"code":"hy","native":"հայերեն","english":"Armenian"},
    {"code":"ja","native":"日本語","english":"Japanese"},
    {"code":"ru","native":"Русский","english":"Russian"}]'::jsonb
) on conflict (id) do nothing;

drop trigger if exists discovery_prefs_touch on public.discovery_prefs;
create trigger discovery_prefs_touch before update on public.discovery_prefs
  for each row execute function public.touch_updated_at();

-- ---- row level security (owner-only; worker uses service_role) --------------
alter table public.discovery_prefs enable row level security;

drop policy if exists discovery_prefs_read   on public.discovery_prefs;
drop policy if exists discovery_prefs_insert on public.discovery_prefs;
drop policy if exists discovery_prefs_update on public.discovery_prefs;

create policy discovery_prefs_read   on public.discovery_prefs for select to authenticated using (public.is_owner());
create policy discovery_prefs_insert on public.discovery_prefs for insert to authenticated with check (public.is_owner());
create policy discovery_prefs_update on public.discovery_prefs for update to authenticated using (public.is_owner()) with check (public.is_owner());

revoke all on public.discovery_prefs from anon, authenticated;
grant  select, insert, update on public.discovery_prefs to authenticated;
grant  all                    on public.discovery_prefs to service_role;
