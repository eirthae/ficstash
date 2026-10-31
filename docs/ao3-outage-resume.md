# Resuming after the AO3 outage

_Paused: **2026-10-30** (code switch). Workflow disabled at GitHub:
**2026-11-01**. AO3 announced 2–4 weeks of downtime from ~2026-10-29._

**Nothing of ours reaches AO3 while this holds** — with one exception: the app
on your phone. `SYNC_PAUSED` and the disabled workflow govern the worker only.
Pull-to-refresh (Library / Discover / What's New) and a group's Sync buttons
still fetch from AO3 on-device. Opening the app does not; it talks to Supabase
only. So: don't pull-to-refresh and don't tap Sync until AO3 is back.

Sync is stopped at the switch, not broken. This is what to do when AO3 is back,
what to check, and what is still unproven because it needs a live AO3.

---

## 1. Resume

**Two switches, both must be flipped.** The workflow was disabled at GitHub on
2026-11-01 as well as paused in code, so clearing the variable alone leaves the
schedule dead and nothing will run.

```bash
gh workflow enable sync.yml           # 1. let GitHub fire the schedule again
gh variable delete SYNC_PAUSED        # 2. let the worker actually do work
```

Confirm both took:

```bash
gh workflow list --all                # Sync should read "active", not "disabled_manually"
gh variable list                      # SYNC_PAUSED should be gone
```

Then start one run by hand rather than waiting for a schedule slot, so the first
one can be watched:

```bash
gh workflow run sync.yml -f series_sweep=skip
```

**Do not unpause until AO3 genuinely serves a search.** The homepage comes back
before search does — it is static and cached, so "archiveofourown.org loads" is
not the test. The test:

```bash
curl -s -o /dev/null -m 45 -w '%{http_code}\n' \
  -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' \
  'https://archiveofourown.org/works/search?work_search%5Bother_tag_names%5D=Fluff&work_search%5Bsort_column%5D=revised_at'
```

`200` is back. `525` / `503` / a hang is not.

---

## 2. Check these, in this order

Each one is a thing that has failed silently before, so check the output rather
than assuming.

### a. The four queued saves land

`Très Bien`, `It's ok not to be ok`, `Keeping Score`, `Maybe More` — all
`wanted=true, failed=false` at pause time, none marked failed by the outage.
They go out in Pass 2 of the first real run.

```sql
select title, wanted, saved, failed from tag_matches where wanted and not saved;
```

Expect: empty, and those four titles present in `works`.

### b. The blank-metadata repair finds a real number

504 works have `title = ''` with real chapter text — readable, but you cannot
tell what you are reading. The pass that fixes them was reporting `0 work(s)
with blank metadata to repair` every run because its selector matched nothing
(fixed in `2ad7a3d`, but **never yet run against a live AO3**).

Expect in the log:

```
== Repair blank metadata ==
NNN work(s) with blank metadata to repair.      <-- a real number, not 0
```

Capped at 100 per run, so ~5 full runs to clear 504. If it still says `0`, the
fix did not work and the selector needs looking at again.

```sql
select count(*) from works where hidden=false and (title='' or title is null or author='');
```

Expect: falling run over run from 506.

### c. The schedule-skip check actually fires

Three slots a day (09:37, 13:47, 17:23 UTC). The first to land does the work;
the rest should exit in seconds. **This has never been observed working** — its
first version threw `TypeError` and was swallowed, so every slot did a full
sweep.

Expect in a later slot's log, one of:

```
Discovery last advanced 4.2h ago (< 10h) — another slot already covered this. Nothing to do.
Discovery last advanced 12.0h ago (>= 10h) — running.
```

If you see `Freshness check skipped (TypeError...)` again, it is still broken.

### d. The Friday series sweep still runs

`19 0 * * 5`. It must NOT be suppressed by the skip — a discovery-freshness
check has no business cancelling the only pass that enumerates series follows.
Excluded in code; verify on the first Friday after resuming.

Expect: `== Series-only run: follows swept; leaving tags + chapters to the nightly. ==`

### e. On-device discovery keeps writing

The four-month bug (`chapters: null` into a NOT NULL column) is fixed and
**proven** — the phone wrote 83 rows on 2026-10-23 with zero defects. Confirm it
still holds after the outage by tapping a group's **Check for new works** and
looking for rows written WITHOUT a `last_checked` bump (only the worker stamps
that):

```sql
select coalesce(nullif(g.label,''),(g.tags->0->>'name')) nm, count(*)
from tag_matches m join tracked_groups g on g.id=m.group_id
where m.first_seen_at > g.last_checked + interval '5 seconds'
group by 1;
```

### f. The two never-checked groups get seeded

`Jango Fett/Obi-Wan Kenobi` and `Bad Parent Qui-Gon Jinn` have `last_checked =
NULL` and **zero** matches. They sort first (`fetch_tracked_groups` orders
stalest-first), so the first successful run should seed them all-time.

---

## 3. Shipped but NOT verified against a live AO3

Everything here is tested in isolation and unproven end to end. Treat with
suspicion.

| What | Where | Why unproven |
|---|---|---|
| Blank-metadata repair selector | `2ad7a3d` | Needs AO3 to re-fetch metadata |
| Schedule-skip check | `1bf6e4b`, `4da524d` | Never observed firing |
| Prune freshness gate | `4da524d` | Needs a stale-then-fresh transition |
| One-group worker run (`ONLY_GROUP`) | v0.8.75 | Ran, but AO3 refused every search |
| Patient retry ladder + 45s timeout | v0.8.73 | AO3 never answered to exercise it |

---

## 4. Still to build

- **Fire-and-forget sync button.** It currently holds a spinner up to 4 minutes
  on the worker fallback, and GitHub runs can queue 20+ minutes. Should dispatch,
  say "results will appear when it lands", and refresh on return. Deferred
  because the buttons work and were not worth disturbing.
- **`discoverAll` is dead code** — exported from `ondevice.js`, zero callers
  since v0.8.66.

- **Four anon-writable policies, and the anon key is public.** Found 2026-10-30
  while ideating a public catalogue site; unrelated to that idea and worth
  fixing regardless.

  | table | cmd | `USING` / `WITH CHECK` |
  |---|---|---|
  | `works` | UPDATE | `true` / `true` |
  | `tag_matches` | UPDATE | `true` / `true` |
  | `chapter_updates` | UPDATE | `true` / `true` |
  | `dismissed_matches` | **ALL** | `true` / `true` |

  RLS cannot restrict columns, so `works_mark_hidden` permits updating *any*
  field on *any* work, not just `hidden`. And the key is already out: the repo
  is public, the APK is a public Release asset, and Vite inlines
  `VITE_SUPABASE_ANON_KEY` into the bundle — unzip the APK, grep the key.

  Exposure today: **vandalism, not theft.** Someone could hide the whole library
  or scramble match flags. They cannot read anything (no anon `SELECT` policies
  exist) and cannot delete works or chapters.

  Fix: scope each policy to the column it exists for (trigger guard or
  `SECURITY DEFINER` function), or drop `anon` from them and let the app use the
  authenticated session it already holds. Check nothing in the app relies on
  anon writes before dropping — `markGroupSeen` and the hide path are the ones
  to look at.

---

## 5. State at pause (2026-10-30)

| | |
|---|---|
| tag_matches | 6,520 |
| tracked groups | 45 (2 never checked) |
| works (visible) | 3,258 |
| works with blank metadata | 506 |
| queued saves | 4 |
| newest `last_checked` | 2026-10-29 17:21 UTC |
| prunable matches | **0** |

Re-check these on resume rather than trusting them — four weeks is long enough
for the picture to drift.

**Correction worth recording:** during the pause work I reported that ~640
matches would be deleted unrecoverably by the retention prune during the outage.
That was wrong — I counted rows past the 90-day cutoff without excluding
saved/Later/wanted/failed ones. Every old row is protected, so the real exposure
is **zero**. The prune gate added in `4da524d` is a cheap safeguard, not a
rescue.

---

## 6. Three bugs of the same shape

Worth remembering, because the next one will look like this too. All three
failed **silently**, and all three had either no test or a test asserting the
wrong thing:

1. `chapters: null` into a NOT NULL column — every on-device write rejected for
   four months. A test asserted the null was correct.
2. `max()` over `last_checked` including NULLs — `TypeError`, swallowed by a
   defensive `except`, so the skip never fired and printed nothing.
3. `.or_("title.is.null,title.eq.")` — matched nothing, so the repair pass
   reported `0 to repair` for 504 broken works.

The pattern: **a query or write that silently matches/affects nothing reads
exactly like "there is nothing to do".** When a pass reports zero work, that is
worth confirming against the database, not believing.
