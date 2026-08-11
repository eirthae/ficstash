# Changelog

All notable changes to FicStash are recorded here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/). The app has no numeric version
scheme yet, so entries are dated and reference the commit that shipped them.

## 2026-08-11 — Discovery feed ordering + dates, readable chatfics (v0.8.59)

### Fixed

- **The discovery feed wasn't showing newest first.** It ordered by
  `first_seen_at` — when *we* inserted the row, not when the work was posted or
  updated. On a tag's first seed every row lands in the same second, so within
  that batch the order was effectively arbitrary: a five-month-old fic could sit
  at the top. Three things kept any real date from being available:
  - `matchRow` hardcoded `source_updated: null`, so the on-device path — the
    *primary* discovery path — stored no date at all.
  - Neither AO3 blurb parser read `p.datetime`, the one date a search listing
    carries (the work's last-updated date, same as AO3 shows).
  - `mapMatch` didn't pass `source_updated` through, so the card couldn't show it.

  All three fixed; the feed now orders by the work's own date, with
  `first_seen_at` only breaking ties.
- **Discovery fetched in one order and displayed in another.** Searches asked AO3
  to sort by `created_at` (Date Posted) while the incremental window filtered on
  `revised_at` (Date Updated) and the feed now sorts by the same. On a tag with
  more results than we fetch, that meant *which* works we kept was decided by
  posted date, but the top of the feed was whichever of them happened to be
  updated most recently. Both paths now sort by `revised_at` end to end.
- **Chatfics were unreadable on author-styled dark blocks.** The work-skin
  sanitizer drops rules on bare elements to protect prose typography — which is
  also where authors put the text colour that goes with their bubble background.
  We kept the dark background and discarded the light text, so the reader's own
  colour applied: near-black on a light or grey theme, fine on the dark one,
  which is why it looked theme-dependent. A surviving rule that paints an opaque
  background and sets no colour of its own now gets a WCAG-luminance-matched text
  colour. Author intent still wins whenever they expressed one — including in a
  separate rule. Verified across all five reader themes; ordinary prose still
  follows the theme exactly.
- **The tag-filter chip's × was an 18px speck** holding a 14px glyph, well under a
  thumb-sized target. Removable chips now use a shared `.chip.removable` style
  with a real 26px control.

- **Discovery kept suggesting fics you already own.** `tag_matches.saved` is only
  flipped when a work is saved *through discovery* (the app's save path and the
  worker's Pass 2). A work that reached your library any other way — an AO3
  bookmark sync, a pasted link, a series "download all" — left every match row
  for it untouched, so it kept resurfacing. Popular tags overlap heavily, so the
  same fic reappeared under several tracked tags with nothing to say you had it.

### Added

- **"In library" on discovery cards.** Matches are cross-referenced against the
  library on load and labelled; tapping one opens *your* copy rather than the
  suggestion preview. Deliberately a label, not a filter — you still see the
  overlap, you just know not to save it twice. Applies to the Later stash too.
- Sort control on a tracked group's feed: **Newest / Oldest / Longest / Shortest**,
  reusing the same `SortDropdown` the Library shelves use (lifted into `ui.jsx`
  rather than duplicated).
- The last-updated date now shows on each discovery card. Rows discovered before
  we captured dates simply omit it and sort last, in both directions.

### Notes

- Existing `tag_matches` rows have no date until their tag is next discovered;
  they sort after dated rows in the meantime. No migration or backfill needed.
- The "In library" check costs one extra query per group open (keyed on source +
  source_work_id, since ids are only unique within a source) and never hides a
  match — if the lookup fails you get an unlabelled feed, not an empty one.
- Discover's own tag-picker chips still use the old 18px × — say the word and
  they can move to `.chip.removable` too.

## 2026-08-08 — Fix: removed works re-queued for download on every sync (v0.8.58)

### Fixed

- **The offline self-heal and the backfill queue disagreed about removed works.**
  `reset_empty_offline` un-flagged any work marked offline with no stored chapter
  text, but didn't filter on `hidden` — while `fetch_non_offline_works` only ever
  queues `hidden = false`. Reclaiming storage purges a removed work's chapter rows,
  so those works read as "offline but empty" forever: the 2026-08-07 sweep logged
  `Re-queued 19 work(s) flagged offline but missing text` immediately followed by
  `0 work(s) need offline copies`, and would have done so every run. A wasted write
  each sync, and a re-queue count noisy enough to hide a work you actually wanted.
  `reset_empty_offline` now skips hidden works, matching its sibling
  `fetch_stale_offline_works`, which already did.

### Added

- `worker/tests/test_reset_empty_offline.py` — a fake client that records `update()`
  payloads, so the pass is checked on what it *writes*, not just what it returns.
  Four of the seven tests fail against the old query.

## 2026-08-07 — Fix: Save runs blocked the nightly sweep, so no new discoveries (v0.8.57)

### Fixed

- **The saves-only "fast lane" wasn't a separate lane at all.** `sync.yml` picked its
  concurrency group with `github.event.inputs.saves_only == 'true'`, but that input is
  a *boolean* — GitHub compares mismatched types numerically, so the check was always
  false and every Save landed in the `ficstash-sync` group. Saves queued behind each
  other and behind the nightly sweep (run 1584 sat pending 52 minutes), and whenever a
  third run arrived GitHub cancelled the one left pending. Now keyed on
  `inputs.saves_only` directly.
- **A real-time Save re-enumerated all 94 followed series.** At 6s spacing that alone
  is ~50 minutes per Save — which is what filled the lane above. The saves-only pass
  now only enumerates series that need attention *now*: one-shot "download all" taps
  and never-checked follows. Existing follows are left to the nightly sweep, which is
  the only thing that was ever refreshing them anyway.

### Added

- `worker/tests/test_series_fast_lane.py` — covers `_series_due_in_fast_lane`, including
  the case that made the old cap leaky: a one-shot "download all" stays due after a
  previous check, because a capped run leaves works behind.

### Context

The 2026-08-06 nightly sweep (run 1580) was cancelled 82 minutes in, during metadata
repair and before the tracked-tag discovery pass, so no new What's New matches landed.
The two runs before it (1578/1579) died in GitHub's own "Failed to resolve action
download info — Service Unavailable" outage; nothing to fix on our side for those.

## 2026-07-14 — Fix: discovery saves stuck "pending" when on-device can't read them (v0.8.56)

### Fixed

- **Saved discovery works could sit "pending" forever.** An AO3 work a logged-out
  on-device fetch can't read (members-only / adult that returns empty, without being
  flagged restricted) stayed `wanted` with no worker fallback — so it never
  downloaded and refreshing didn't help (6 were stuck, some since 07-08). Now a
  pull-to-refresh (`syncNow`) escalates any saves the device couldn't get to the
  logged-in worker ONCE (guarded), so it fetches them with your AO3 account.

## 2026-07-14 — Fix: batches of AO3 link imports stuck "queued" (v0.8.55)

### Fixed

- **Importing several AO3 works by link at once left them stuck "queued to
  download."** Each add fired its own on-device fetch, so a batch hit AO3
  concurrently, got rate-limited, and fell back to `queued` with no worker fallback
  until the far-off nightly run. Now:
  - `processAo3Links` is **single-flight** — a burst of adds coalesces onto one run
    that fetches the queue one at a time, spaced (no concurrent AO3 hammering).
  - If the on-device pass can't finish some, `requestUrl` kicks the worker's fast
    lane **once (guarded)** — the logged-in worker mops up whatever's left `queued`,
    instead of it waiting hours for the scheduled sync.

## 2026-07-14 — Storage: image cap, stale-match prune, dismissed tombstone (v0.8.54)

The remaining durable fixes from docs/supabase-storage.md.

### Fixed (Supabase storage)

- **Image inlining capped hard.** Inlining chatfic/social images as base64 was the
  #1 storage driver (~231 MB across 196 chapters). The per-image cap dropped from
  2 MB → ~50 KB and the per-work/chapter budget with it (worker + on-device), so only
  tiny decorative images inline; bigger ones become the reader's placeholder. New
  worker env `INLINE_IMAGES=0` disables inlining entirely.
- **Stale discovery suggestions are pruned.** The worker now deletes unsaved / not-
  Later / not-Failed / not-queued `tag_matches` older than 30 days
  (`MATCH_RETENTION_DAYS`) each full sweep, so browsed-and-ignored suggestions don't
  pile up.
- **Dismissed works stay gone (tombstone).** New `dismissed_matches` keys-only table
  records what you dismiss; discovery — worker *and* on-device (AO3 + romance.io) —
  skips those keys on upsert, so a hard-deleted (dismissed) suggestion never
  re-surfaces on a later tag search. Migration `0027_dismissed_matches.sql`.

### Tests

- App 86 green; worker 99 green (adds `test_dismissed_tombstone`). Existing
  image-inline tests still pass at the lower cap.

## 2026-07-14 — Failed link imports, storage fixes (v0.8.53)

### Added

- **Failed link imports now appear in Discover → Failed.** An added-by-link AO3 work
  that failed — usually because it's members-only to a logged-out fetch — now shows
  in the Failed stash alongside failed discovery saves, with **Retry** and **Dismiss**.
  Retry re-queues it and kicks the WORKER, which logs in with your AO3 account, so
  registered-users-only works actually download (and then follow for updates). A
  **"Retry all links with my account"** button retries a whole batch at once. Failed
  links no longer clutter the Library's pending-links list.

### Fixed (Supabase storage — see docs/supabase-storage.md)

- **"Remove from library" now frees the offline text.** Removed (hidden) works kept
  all their chapter rows forever — the bulk of the DB. The worker now purges chapters
  for hidden works each full sweep (`delete_chapters_for_hidden_works`), keeping the
  lightweight tombstone so they're never re-added.
- **Dismissing a discovery suggestion hard-deletes it** instead of flagging
  `dismissed=true` and keeping the full metadata forever (which also wasn't sticking).
- **Lowered `TAG_SEED_LIMIT` 300 → 150** so each tracked tag stores fewer unsaved
  suggestion rows.

Deferred (next batch): cap/stop base64 image inlining; prune stale unsaved matches;
a keys-only dismissed tombstone so hard-deleted works don't re-surface.

## 2026-07-11 — Restricted-retry via account, stash counts, romance.io on worker, labeled filters (v0.8.52)

### Fixed

- **Retrying a restricted (members-only) save now uses your AO3 account.** The
  on-device fetch is logged-out and can never see restricted works, so retrying one
  from Failed just failed again. Retry now routes restricted works to the WORKER,
  which logs in with `AO3_USERNAME`/`AO3_PASSWORD` — so it actually downloads and
  then follows the work for updates. (Non-restricted retries stay on-device.)
- **romance.io discovery now runs on the worker** (`RomanceIoSource`), not just
  on-device. romance.io — unlike AO3/Scribble Hub — answers a datacenter IP, so its
  discovery belongs server-side like Goodreads; putting it only on-device was
  unreliable. Registered in the worker, mapped to the Books shelf for global
  excludes. The app still tries on-device for instant results; both write the same
  rows, so the worker is the dependable fallback. (Verified with a live fetch:
  multi-tag AND + excludes work.)

### Added

- **Counts on the Later and Failed buttons** in Discover (e.g. "Failed · 5"), so you
  can see how many are waiting without opening them.
- **Labels on the Ongoing / Completed filter toggles** in a tag group's results —
  the top-right icons now read "Ongoing" and "Completed" instead of bare icons.

### Tests

- App: 86 (unchanged, all green). Worker: 96 total incl. new `test_romanceio`
  (URL building, spaced-slug encoding, default-exclude, JSON parsing).

## 2026-07-11 — "Failed" stash: retry / dismiss saves that couldn't download (v0.8.51)

### Added

- **A "Failed" section in Discover** (alongside Later). A tapped Save that fails
  DEFINITIVELY — the work was removed at the source (404 / "cannot find"), or it's
  members-only/restricted — now lands here with its reason shown, and a **Retry**
  (re-queues the download) or **Dismiss** button. Nothing fails silently or retries
  forever anymore.
- Transient failures (throttling, network) are NOT flagged — they stay queued and
  keep auto-retrying on pull-to-refresh, exactly as before.

### Details

- Migration `0026_failed_matches.sql`: `failed` + `fail_reason` on `tag_matches`
  (idempotent), plus a partial index for the stash read.
- `ondevice.saveMatchNow` flags a match failed on a definitive miss (a 404 /
  restricted result), classified by `isDefinitiveFailure` (unit-tested). Failed
  matches drop out of the group feed, tile counts, and What's New.
- `tags.fetchFailedMatches` + `retryMatch` (retry re-queues on-device for AO3 /
  Scribble Hub, or the worker otherwise). `FailedScreen` mirrors the Later stash.
- Tests: 86 total, all green (adds `isDefinitiveFailure` coverage).

## 2026-07-11 — Scribble Hub downloads move on-device (v0.8.50)

### Fixed

- **Saved Scribble Hub stories never downloaded.** Scribble Hub is Cloudflare-fronted
  and returns `403 / Cf-Mitigated: challenge` to the worker's datacenter IP — the
  exact same wall as AO3 — so every SH save silently failed at the worker. SH now
  downloads **on-device** (residential IP), like AO3:
  - `lib/sources/scribblehub.js` — ported from FanFicFare's SH adapter: series page
    metadata, the `admin-ajax` chapter-list POST (`wi_getreleases_pagination`), and
    `#chp_raw` chapter text. Returns the same parsed shape as the AO3 fetcher.
  - `lib/fetch.js` — `fetchHtmlPost` (native form POST) for the chapter-list call.
  - The on-device engine (`downloadWork`, `saveMatchNow`, the serial save queue,
    `downloadWanted`, `refetchWork`) is now source-aware (AO3 + Scribble Hub).
    `requestSave` routes SH saves to the on-device queue instead of the worker.
  - **Recovery:** a single pull-to-refresh now re-downloads SH saves that were stuck
    (they were unreachable from the worker entirely).

### Tests / audit

- Audited every call site of the source-aware refactor (`downloadWork`,
  `saveMatchNow`, `markMatchesSaved`, the save queue, `downloadWanted`,
  `refetchWork`, `requestSave`) — all pass `source` correctly; AO3 remains the
  default, so the existing AO3 path is unchanged.
- Added unit tests (node `--test`, 85 total, all green): `workRow` source-awareness
  (AO3 default + Scribble Hub), and the Scribble Hub parsers via linkedom — id/URL
  extraction, series metadata, TOC, and chapter-body cleaning. `linkedom` added as a
  dev-only dependency (not bundled into the app).

### Notes

- Verified by build + faithful port + unit tests; the live SH fetch itself can only
  be confirmed on a real device (this build environment hits the same Cloudflare 403).
- Next up (agreed): a "Failed" stash (like Later) for works that fail definitively —
  a deleted work, or repeated failures — with Retry + Dismiss, so nothing fails silently.

## 2026-07-11 — Fix: rapid AO3 saves silently dropped (v0.8.49)

### Fixed

- **Saving several AO3 works in a row only saved the first one.** Each tapped Save
  fired its own on-device AO3 fetch immediately, so rapid taps hit AO3 concurrently;
  AO3 rate-limits bursts, so most fetches came back empty and those works were never
  downloaded or added to the library (they stayed silently "wanted"). Tapped saves
  now go through a **serial, spaced queue** — one fetch at a time — so a burst of
  saves all download instead of throttling each other.
- **Pull-to-refresh didn't rescue the dropped saves.** The on-device sync ran the
  heavy tag-discovery sweep *first*, hammering AO3 before it retried pending
  downloads — so the retry hit an already-throttled AO3. Sync now **downloads
  pending links + saves first**, then runs discovery. A single pull-to-refresh now
  recovers works stuck from earlier bursts.

## 2026-07-11 — Discover perf, Saved-feed window, sticky track button (v0.8.48)

### Fixed

- **Discover tab was slow to open.** `fetchTrackedGroups` was paging through
  *every* `tag_matches` row (1000 at a time) on each open to count matches per
  tile — fine before, but romance.io discovery adds thousands of book matches, so
  a big library meant dozens of round-trips. Now uses parallel server-side `COUNT`
  per group (`head:true`, no rows transferred).
- **Saved stories were missing from What's New (only ~20% showed).** The "Saved"
  feed's clear window was 24h, but non-AO3 stories only download via the daily
  worker sweep (1–3h per run), so they aged out — or hadn't downloaded yet — before
  appearing. Widened to **5 days**, matching the New-chapters feed
  (`DEFAULT_WHATS_NEW_DAYS = 5`). Display window only; the library is unaffected.
  (AO3 fics were unaffected because they download instantly on-device.)

### Changed

- **The track/save button in the Discover builder is now a sticky footer** — always
  reachable without scrolling to the bottom of the long Books/Stories topic trees.

## 2026-07-11 — romance.io Books discovery + unified include/exclude picker (v0.8.47)

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
