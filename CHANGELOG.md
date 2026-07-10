# Changelog

All notable changes to FicStash are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). The app has no numeric version
scheme yet, so entries are dated and reference the commit that shipped them.

## 2026-07-11 — romance.io Books discovery + unified include/exclude picker

Commit `0dfa58e` (branch `main`).

### Added

- **romance.io as a Books-shelf discovery source (`romanceio`).** Book discovery
  by romance.io's own topic tree — steam level, time period, genre, relationship
  tropes, themes, content warnings, hero/heroine traits, format — with native
  **include AND exclude**. Like AO3, it fetches **on-device** (residential IP,
  `CapacitorHttp`) and uses Supabase only as the store; romance.io's Cloudflare
  front 525s datacenter IPs but answers the phone.
  - `app/src/data/romanceioTopics.js` — the extracted tree: 9 categories, 311
    topics with slugs / display names / live book counts.
  - `app/src/lib/sources/romanceio.js` — the books API client
    (`GET /json/topics/books/<include>/best/<offset>/20[/<exclude>]`; slugs are
    percent-encoded and comma-joined; page size 20), plus `slugsForNames()` which
    maps the Books shelf's global excluded tags onto romance.io slugs.
  - `discoverRomanceGroup` in `app/src/lib/ondevice.js` — queries the include
    topics, hides the group's excludes + the shelf's global excludes + the
    permanent default-exclude list, and upserts metadata-only `tag_matches`.
    Runs on group create, on edit, and on pull-to-refresh (`discoverAll`).
- **Metadata-only book cards.** romance.io (and Goodreads) matches are notify-only:
  no download, the card links out to `romance.io/books/<id>` (the id alone redirects
  to the full page). Detail shows "Find on Romance.io"; you buy the EPUB and add it
  via the upload path.
- **Permanent non-binary-MC exclusion.** `ROMANCEIO_DEFAULT_EXCLUDE` (46 nbi /
  non-binary slugs) is stripped from the picker AND always appended to every query's
  hide list, so those books never surface and the tags never appear.

### Changed

- **Unified the include/exclude UX across every non-AO3 source.** Royal Road,
  Scribble Hub and Goodreads now use the same collapsible-category, **three-state
  tap-cycle** tree as romance.io: tap a row once to **include** (check), again to
  **exclude** (no-entry icon), once more to clear. One control replaces the old
  separate include picker + exclude picker. Categories collapse, a flat search
  spans everything, and counts render when the source provides them.
  - **AO3 is intentionally untouched** — its tag space is too large and freeform to
    structure as a fixed tree, so it keeps its live-search picker with a separate
    exclude field.
  - The global Discovery-filters sheet (per-shelf "never show" tags) is unchanged.
- **What's New "Saved" feed clears after 24h.** The feed shows only the last day of
  saves so it doesn't clutter; works stay in the library permanently (display window
  only). Matches the New-chapters window.
- `fetch.fetchJson` now accepts object JSON (romance.io returns `{success, books}`),
  not only top-level arrays; AO3 autocomplete (arrays) is unaffected.
- `library.fetchWorks` pages past PostgREST's 1000-row cap with a stable secondary
  sort, and `fetchWorkById` re-reads a single work after a re-fetch.

### Notes

- On-device fetching (romance.io + AO3) does not run in the browser preview
  (`CapacitorHttp` is native-only); the API contract was verified directly.
- Legacy Goodreads (`books`) groups still work and remain on the Books shelf; new
  book groups are created against romance.io. Pure row/filter logic is covered by
  `node --test` (`ondevice-pure.test.js`, incl. `bookMatchRow` + slug ids).
