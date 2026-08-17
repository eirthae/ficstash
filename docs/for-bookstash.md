# FicStash → BookStash: a month of changes worth porting

**Period covered:** 11 July – 11 August 2026 (v0.8.47 → v0.8.62, 16 releases)

FicStash's AO3 fetching was originally adapted *from* BookStash
(`docs/tag-discovery-and-fetch.md`), so the two apps still share shape: an
on-device fetcher, a scheduled worker, a discovery feed, a library, a reader.
This maps what changed on the FicStash side, why, and how — so BookStash can take
what applies.

Grouped by theme rather than by date, because the useful unit is "this problem and
everything it turned out to touch". Each item notes the release it shipped in, and
where a change later needed fixing, the fix sits with it rather than in date order.

**Storage/Supabase-specific work is deliberately excluded** — see the last section
for what was left out, in case any of it turns out to matter.

---

## 1. Fetching from Cloudflare-fronted sources

The single biggest architectural theme. Both AO3 and Scribble Hub sit behind
Cloudflare and refuse datacenter IPs while answering a phone.

- **Scribble Hub downloads moved on-device** *(v0.8.50)*
  - **Why:** every Scribble Hub save silently failed. SH returns
    `403 / Cf-Mitigated: challenge` to the worker's datacenter IP — the same wall
    AO3 puts up. Nothing was wrong with the save logic; the request never landed.
  - **How:** ported FanFicFare's SH adapter to `lib/sources/scribblehub.js` —
    series-page metadata, the `admin-ajax` chapter-list POST
    (`wi_getreleases_pagination`), and `#chp_raw` chapter text — returning the same
    parsed shape as the AO3 fetcher. Needed a new `fetchHtmlPost` (native form POST)
    in `lib/fetch.js`.
  - The on-device engine became **source-aware** throughout (`downloadWork`,
    `saveMatchNow`, the save queue, `downloadWanted`, `refetchWork`), with AO3 as
    the default so the existing path was untouched.
  - **Recovery mattered:** a single pull-to-refresh re-downloaded everything that
    had been stuck, because those works had been unreachable from the worker
    entirely.

- **romance.io went the other way — onto the worker** *(v0.8.52)*
  - **Why:** the general rule isn't "on-device is better". romance.io *does* answer
    a datacenter IP, and putting its discovery only on-device made it unreliable
    (the phone isn't always awake). Source placement should follow who will actually
    answer the request.
  - **How:** registered `RomanceIoSource` server-side. The app still tries on-device
    for instant results; both write identical rows, so the worker is a dependable
    fallback rather than a competing implementation.

- **Members-only works need the logged-in worker** *(v0.8.52)*
  - **Why:** the on-device fetch is logged-out and can *never* see restricted works,
    so retrying one on-device just failed again, forever.
  - **How:** retry routes restricted works to the worker, which logs in with real
    credentials. Non-restricted retries stay on-device.
  - **Takeaway:** "retry" is not one operation. It has to route by *why* it failed.

**Portable lesson:** decide per-source, per-operation where a request runs, and make
the fetcher shape identical on both sides so either can be the fallback.

---

## 2. Save / download reliability

A cluster of bugs with one shared root: **firing one network request per user
action**, with no coordination between them.

- **Rapid saves silently dropped** *(v0.8.49)*
  - **Why:** each tapped Save fired its own AO3 fetch immediately. Rapid taps hit
    AO3 concurrently, AO3 rate-limits bursts, most fetches returned empty, and those
    works were never downloaded — while still showing as "wanted". Silent failure.
  - **How:** a **serial, spaced queue** — one fetch at a time.
  - **Second bug in the same report:** pull-to-refresh didn't rescue them, because
    the on-device sync ran the heavy tag-discovery sweep *first* and hammered AO3
    before retrying pending downloads. Reordered so sync **downloads pending links +
    saves first, then discovers**.

- **Batched link imports stuck "queued"** *(v0.8.55)* — the same bug, different
  entry point
  - **Why:** each add fired its own fetch; a batch hit AO3 concurrently and got
    throttled, then sat `queued` until the far-off nightly run.
  - **How:** `processAo3Links` became **single-flight** — a burst of adds coalesces
    onto one run that works through the queue serially. Plus a **guarded, one-shot**
    kick to the worker's fast lane to mop up whatever the device couldn't finish.

- **Saves stuck "pending" forever** *(v0.8.56)*
  - **Why:** a work a logged-out fetch can't read (members-only, or adult content
    that returns empty without being flagged restricted) stayed `wanted` with no
    worker fallback. Six were stuck, some for six days.
  - **How:** `syncNow` escalates anything the device couldn't get to the logged-in
    worker **once, guarded**.

**Portable lesson:** any per-tap network action needs (a) a serial queue,
(b) single-flight coalescing, and (c) an escalation path that fires *once*. All
three failures above look different in the UI and are the same bug underneath.

---

## 3. Failure handling — nothing fails silently

- **"Failed" stash in Discover** *(v0.8.51)*
  - **Why:** before this, a save that could never succeed either failed silently or
    retried forever. Both are bad, and they need opposite treatment.
  - **How:** the key distinction is **definitive vs transient**:
    - *Definitive* (404 / "cannot find" / members-only) → flagged failed, shown in
      the stash with its reason and **Retry** / **Dismiss**.
    - *Transient* (throttling, network) → **not** flagged; stays queued and keeps
      auto-retrying on pull-to-refresh.
  - Classification lives in a pure, unit-tested `isDefinitiveFailure`.
  - Failed matches drop out of the group feed, tile counts, and What's New.

- **Failed link imports joined the same stash** *(v0.8.53)*
  - **Why:** they were a separate, invisible failure mode cluttering the Library's
    pending-links list.
  - **How:** same stash, same Retry/Dismiss, plus a **"Retry all links with my
    account"** batch action that routes through the logged-in worker.

- **Counts on the Later / Failed buttons** *(v0.8.52)* — e.g. "Failed · 5", so a
  backlog is visible without opening the stash.

**Portable lesson:** a failure taxonomy (definitive vs transient) is worth building
before the retry UI, because it decides the whole shape of the feature.

---

## 4. Discovery ordering and dates

This one is a good case study in a bug that looked cosmetic and wasn't.

- **The feed wasn't showing newest first** *(v0.8.59)*
  - **Why:** it ordered by `first_seen_at` — *when we inserted the row*, not when
    the work was posted or updated. On a tag's first seed every row lands within the
    same second, so the order inside that batch was effectively arbitrary: a
    five-month-old fic could sit at the top of a "newest" feed.
  - **Three separate gaps meant no real date was even available:**
    - the on-device row builder hardcoded `source_updated: null` — and on-device is
      the *primary* discovery path, so most rows had no date at all;
    - neither blurb parser (app or worker) read `p.datetime`, the one date a search
      listing actually carries;
    - the row→card mapper didn't pass the field through, so the card couldn't have
      shown it anyway.
  - **How:** parse the blurb date on both paths, store it, order by it, with
    insertion time only breaking ties.

- **Fetching in one order, displaying in another** *(same release)*
  - **Why:** searches asked AO3 to sort by `created_at` (Date Posted) while the
    incremental window filtered on `revised_at` (Date Updated). On a tag with more
    results than we fetch, *which* works we kept was decided by posted date, but the
    top of the feed was whichever of them happened to be updated most recently.
    Incoherent.
  - **How:** one sort key end to end (`revised_at`), matching the filter, the stored
    date, and the displayed date.
  - **Constraint worth knowing:** an AO3 search blurb exposes only **one** date, the
    updated date. True posted date lives on the work page, so getting it would cost
    one fetch per discovered work — not viable for a feed.

- **Sort control + dates on cards** *(v0.8.59)* — Newest / Oldest / Longest /
  Shortest, and the date rendered on each card. Rows discovered before dates were
  captured omit the date and sort last **in both directions** (floating undated rows
  to the top of "Oldest" would bury the genuinely old works the sort exists to find).

**Portable lesson:** "sort by newest" is three separate decisions — what you fetch,
what you store, what you order by — and they have to agree. Check all three.

---

## 5. Discovery ↔ library overlap

- **Discovery kept suggesting fics already in the library** *(v0.8.61)*
  - **Why:** the "saved" flag on a match row was only ever set when a work was saved
    *through discovery*. A work that reached the library any other way — a bookmark
    sync, a pasted link, a series bulk-download — left every match row untouched, so
    it resurfaced forever. Popular tags overlap heavily, so the same work reappeared
    under several tracked tags with nothing to say you owned it.
  - **How — and the design call:** cross-reference at *read* time and **label** it
    ("In library"), rather than back-filling the flag and hiding it. Hiding removes
    the signal along with the noise; the user wanted to *see* the overlap and know
    not to save twice. Tapping the label opens the library copy, not the suggestion
    preview.
  - Keyed on **(source, id) together** — ids are only unique within a source, so
    keying on the id alone cross-labels works between sources.
  - Best-effort: a failed lookup yields an unlabelled feed, never an empty one.

- **Follow-up** *(v0.8.62)*: a work already in the library drops "Save for later"
  entirely — there's nothing to set aside — and the "In library" button takes the
  full row.

### Who owns a "save for later" stash?

Audited after the fact, and it turned out three separate paths could empty the
stash without the user having deleted or downloaded anything. Worth checking the
equivalent in BookStash, because none of them were deliberate:

- **Editing the tag group deleted its stashed items.** The edit path dropped every
  match row for the group before re-discovering under the new criteria. The intent
  was to clear *stale, un-reviewed suggestions*; it took the user's curated picks
  with them. Fixed by excluding stashed rows from that delete.
- **Deleting the tag group cascaded them away**, because the rows were foreign-keyed
  to the group with `on delete cascade`. This is the real design question: **is the
  stash owned by the group that surfaced the item, or by the user?** We settled on
  the user — the rows are now detached (`group_id` nullable, set to null before the
  group is dropped) so they outlive the group. A detached row has no feed to be
  "sent back" to, so that action becomes "Remove" instead, and a partial unique
  index keeps detached rows one-per-work so the stash can't list a story twice.
- **A cross-source id collision silently removed items.** The dismissal-propagation
  pass matched on the bare work id with no source filter, so dismissing work
  `12345` on one source also marked a *different* story with id `12345` on another
  source dismissed — and dismissed rows drop out of the stash. Same class of bug as
  the library cross-reference above, in a function two definitions away from one
  that had always keyed on `(source, id)` correctly.

**Portable lesson:** anything the user deliberately curated needs an explicit
lifecycle rule — "leaves only when they delete or download it" — and then every
delete path in the codebase has to be checked against it. Bulk deletes scoped by a
parent id are the ones to look at first.

---

## 6. Scheduled-job concurrency (GitHub Actions)

Not app code, but it caused a week of "the app stopped finding anything", so it's
worth knowing about.

- **The "fast lane" wasn't a separate lane** *(v0.8.57)*
  - **Why:** the workflow chose its concurrency group with
    `github.event.inputs.saves_only == 'true'` — but that input is a **boolean**, and
    GitHub compares mismatched types numerically, so the check was *always false*.
    Every quick save landed in the same group as the nightly sweep. Saves queued
    behind each other and behind the sweep, and when a third run arrived GitHub
    cancelled whichever was pending.
  - **Consequence:** the nightly sweep was cancelled partway through, *before* the
    discovery pass — which is the only thing that surfaces new works. Hence "no new
    matches for days".
  - **How:** key on `inputs.saves_only` directly.

- **A real-time save re-enumerated everything** *(same release)*
  - **Why:** the saves-only pass walked all 94 followed series at 6s spacing — ~50
    minutes per save. That's what kept the lane permanently full.
  - **How:** the fast lane now only enumerates what the user is waiting on
    (one-shot bulk-download requests, and never-checked follows). Established
    follows are left to the nightly sweep that already refreshes them.
  - **Result:** saves-only runs went **52 minutes → 45 seconds**, and a save now
    genuinely runs in parallel with a sweep.

- **A no-op loop found while verifying** *(v0.8.58)*
  - **Why:** a self-heal pass un-flagged works that looked "downloaded but empty",
    while the backfill queue that was meant to pick them up filtered out *removed*
    works. Removed works get their chapter text purged, so they looked empty
    forever: every run re-flagged the same rows and the backfill immediately dropped
    them. Logged `Re-queued 19 work(s)` followed by `0 work(s) need offline copies`,
    every single run.
  - **How:** align the two queries' scope. Small waste, but the misleading count
    would have masked a genuine re-queue.

**Portable lesson:** in GitHub Actions, `inputs.<bool> == 'true'` is always false.
And when a scheduled job "sometimes doesn't finish", check whether something else is
holding its concurrency group.

---

## 7. Reader — author-styled content

- **Chatfics unreadable on dark author-styled blocks** *(v0.8.59)*
  - **Why:** the work-skin sanitizer deliberately drops rules targeting bare
    elements, to protect the reader's own typography. But that's exactly where
    authors put the text colour that goes *with* their bubble background. So the
    dark background was kept and the light text discarded, leaving the reader's
    theme colour: near-black on a light/grey theme, fine on dark. That's why it
    looked theme-dependent.
  - **The non-obvious part:** colouring the bubble isn't enough. The reader sets
    colour **directly** on `p`, and a directly-applied declaration beats an
    inherited one at *any* specificity. The fix has to name the descendants —
    and only the ones the reader itself colours directly (`p`, `strong`, `b`,
    `blockquote`, `h1–h3`); everything else inherits fine, and naming it would
    widen the chance of overriding real author intent.
  - **How:** at sanitize time — not runtime — a rule that paints an **opaque**
    background and sets no colour of its own gets a WCAG-luminance-matched text
    colour. Chosen over runtime DOM luminance detection because it's a pure,
    unit-testable function, needs no re-run on theme or chapter change, and costs
    nothing per render. Gradients, images and semi-transparent backgrounds are left
    alone rather than guessed at.
  - Author intent always wins — including when the colour is declared in a
    *separate* rule from the background.
  - Verified across all five reader themes; ordinary prose still follows the theme.

---

## 8. UI consistency

A run of small things that were each one-line fixes but shared a cause: the same
control implemented independently in several places.

- **Discovery cards now read like Library cards** *(v0.8.61)*
  - **Why:** discovery put status/words at the *bottom* of the card while the
    Library put them under the byline, so the same work read differently depending
    on the screen. In discovery the meta line also shared a row with the buttons, so
    the word count wrapped onto two lines.
  - **How:** same markup and order in both — `status · date · words` directly under
    the byline. Actions stay at the bottom.

- **The blank cavern above every summary** *(v0.8.62)* — the best bug of the month
  - **Why:** it looked like a broken margin, and it wasn't. Summaries render with
    `white-space: pre-line` so authors' paragraph breaks survive — and the worker
    stores the source's summary **verbatim**, leading newlines and all. Those
    rendered literally as blank lines.
  - **Why it hid:** the sample/demo data is single-line strings, so it never
    reproduced in the browser preview. It only appeared on a real library, which
    made it look like a device-specific bug.
  - **How:** a pure `tidySummary` at render — trim the ends, strip per-line trailing
    spaces, cap runs of blank lines at one, **keep deliberate paragraph breaks**.
    Measured: 188px → 75px, 113px of dead space. Running it at render repairs every
    already-stored row with no migration.
  - **Still latent:** the on-device parser collapses *all* whitespace (losing
    paragraph breaks) while the worker keeps everything. The two paths still store
    different-looking text for the same work; the render-time fix papers over it.

- **Touch targets and icon sizing** *(v0.8.59 → v0.8.60)*
  - Removable chips had an 18px × holding a 14px glyph — well under a thumb-sized
    target. Fixed in the Library first, then it turned out the tag, genre, subject
    and topic pickers each carried **their own copy** of the same button. All moved
    to one shared style with a 26px control.
  - **Found by measuring, not reading:** an icon inside an icon button is a flex
    item with nothing stopping it collapsing, so on any button narrower than the
    default the glyph rendered **non-square** — a 20px icon coming out 16×20. Fixed
    globally with `flex:none`, which also repaired the shared search field's clear
    button, squashed that way for as long as it had existed.

- **Filter row overflowed a 375px screen by 10px** *(v0.8.61)* — a long label plus
  three controls pushed the sort button off the edge, partly unreachable. The label
  truncates now; the controls never shrink.

- **Card actions** *(v0.8.62)* — both actions became labelled buttons of equal width
  across the card's full row, instead of an unlabelled icon beside a wide primary.
  The secondary action steps down to a dimmer token so it stops competing with the
  primary; its icon inherits `currentColor` and dims with the label.

- **Sticky track button** *(v0.8.48)* — the save button in the discovery builder
  became a sticky footer, so it's reachable without scrolling past long topic trees.

**Portable lesson:** measure rendered geometry rather than trusting declared sizes.
Two of these (the squashed glyphs, the 10px overflow) were invisible in code review
and obvious the moment anything got measured in a real viewport.

---

## 9. Discovery sources and pickers

- **romance.io as a Books-shelf source** *(v0.8.47)*
  - Discovery by romance.io's own topic tree — 9 categories, 311 topics with slugs,
    names and live counts — with native include **and** exclude.
  - **Metadata-only cards:** book matches are notify-only. No download; the card
    links out, and you add the EPUB via the upload path. Worth having a card variant
    that offers no download at all.
  - A permanent exclude list is stripped from the picker *and* appended to every
    query, so unwanted topics never surface and their tags never appear.

- **Unified include/exclude picker** *(v0.8.47)*
  - **Why:** every non-AO3 source had its own separate include picker plus exclude
    picker.
  - **How:** one collapsible-category tree with a **three-state tap cycle** —
    tap to include, again to exclude, again to clear. One control replaces two.
  - **AO3 deliberately excluded** from this: its tag space is too large and freeform
    to model as a fixed tree, so it keeps a live-search picker with a separate
    exclude field. Worth copying the *judgement*, not just the control.

---

## 10. Performance

- **Discover tab slow to open** *(v0.8.48)*
  - **Why:** counting matches per tile paged through *every* match row, 1000 at a
    time, on each open. Fine at small scale; once book discovery added thousands of
    rows it meant dozens of round-trips.
  - **How:** parallel server-side counts, no rows transferred.
  - **Portable lesson:** client-side counting scales exactly as badly as the feature
    that fills the table.

- **Saved works missing from the activity feed** *(v0.8.48)*
  - **Why:** the feed's window was 24h, but non-AO3 works only download via the
    daily worker sweep (1–3h per run) — so they aged out, or hadn't downloaded yet,
    before they could appear. Only ~20% showed.
  - **How:** widened to 5 days to match the other feed. Display window only.
  - **Portable lesson:** a display window has to be longer than the worst-case
    latency of the pipeline that fills it.

---

## Deliberately excluded

Left out per the brief, since it's backend-specific rather than product behaviour:

- Storage-quota work: base64 image-inlining caps, chapter purging for removed
  works, stale-suggestion pruning, seed-limit reductions
- The storage measurement/cleanup workflow and its diagnostics
- PostgREST-specific quirks (row caps, bulk-upsert key matching, paging)
- Schema migrations as such

Two of those have a portable *idea* behind them even if the implementation doesn't
travel, so flagging them in case they're wanted:

- **Inlining images as base64 was the single biggest storage driver** (~231 MB
  across 196 chapters before it was capped). If BookStash inlines anything, cap it
  early.
- **Dismissing a suggestion needs a keys-only tombstone.** Soft-flagging keeps full
  metadata forever; hard-deleting means the next search re-adds it. A tiny
  keys-only record of what was dismissed, checked on insert, is what actually makes
  "dismissed" stick.

---

## Test posture, for reference

Pure logic was pulled out into dependency-free modules specifically so it could be
tested without a browser or a device — parsers, row builders, sort comparators,
failure classification, CSS sanitizing, summary tidying. Over the month the suites
went from ~85 to **121 app tests** and **118 worker tests**.

The habit that paid off most: after writing a fix, **revert it and confirm the new
tests actually fail**. That caught one set of tests that would have passed against
the broken code.
