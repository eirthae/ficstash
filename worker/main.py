"""FicStash worker entry point.

Reads secrets from the environment ONLY. Never hard-code or print credential
values. The service_role key lives here (server-side) and never ships in the
app, which uses the anon key behind Row Level Security.

FicStash no longer logs in to AO3. It's a curated reader now, not an account
mirror: works enter the library by add-by-link, by tapping Save on a discovered
tag match, or (later) by file upload — never by auto-importing someone's
bookmarks or subscriptions. Everything AO3 needs (public work metadata, chapter
bodies, tag/language search) works logged-out, which also keeps us off AO3's
session machinery entirely.

Required environment variables:
  SUPABASE_URL                 Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY    server-side key (NEVER in the app/repo)

Optional:
  REPAIR_MAX                   how many blank-metadata works to re-fetch per run
                               (default 100; "all"/0 = no cap). Repairs works
                               that older builds stored without a title/author.
  OFFLINE_BACKFILL_MAX         how many not-yet-offline works to fully download
                               per run (default 25; "all"/0 = no cap). Keeps the
                               offline backfill gradual and polite to AO3.
  REFLOW_MAX                   how many legacy plain-text works to re-download
                               with formatting intact per run (default no cap;
                               "all"/0 = no cap). One-off cleanup of works whose
                               chapter bodies older builds stored as plain text.

Flow: the user-initiated "requested" passes run first so a freshly pasted link
or tapped Save downloads right away, instead of waiting behind the slower
discovery/backfill sweeps:
  1. Requested links → full offline copies of works added by pasted URL
     (Royal Road, Scribble Hub, FFN, …) via FanFicFare.
  2. Requested saves → full offline copies for in-app Save requests.
  3. Repair blank metadata → re-fetch title/author for works older builds left blank.
  4. Tracked tag groups → discover matches new since the group's last sync
     (first run anchors to when the group was created), not its back-catalogue.
  5. Offline backfill → download full chapter text for any work that isn't a
     full offline copy yet, capped per run. The app is offline-first: every
     work should become readable offline by default.
  6. Reflow legacy plain-text chapters → re-download AO3 works whose chapter
     bodies older builds stored as markup-stripped plain text, so the reader
     shows real paragraph spacing again.
Upserts omit reader-state columns so progress survives re-syncs, and unchanged
works are never re-downloaded.
"""

from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime, timezone

from dotenv import load_dotenv

from ficstash_worker.lang import allowed_language_set, language_allowed
from ficstash_worker.saves import fetch_work_chapters
from ficstash_worker.util import is_phantom_link_error, status_matches
from ficstash_worker.sources import TAG_SEARCH, get_source
from ficstash_worker.sources.ao3 import RateLimitError
from ficstash_worker.supabase_io import (
    age_out_saved_matches,
    clear_series_requests,
    delete_request,
    delete_series_follow,
    expire_chapter_updates,
    fetch_all_offline_works,
    fetch_followed_series,
    fetch_non_offline_works,
    fetch_discovery_prefs,
    fetch_offline_ao3_ids,
    fetch_ongoing_offline_works,
    fetch_plaintext_chapter_works,
    fetch_requested_urls,
    fetch_tracked_groups,
    fetch_untitled_works,
    fetch_wanted_matches_all,
    make_client,
    mark_flag,
    mark_group_checked,
    mark_matches_saved,
    mark_request,
    mark_series_checked,
    record_chapter_updates,
    reset_empty_offline,
    set_work_series,
    upsert_chapters,
    upsert_tag_matches,
    upsert_work,
)

REQUIRED_ENV = (
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
)

# AO3 is a volunteer nonprofit — stay polite. Space requests apart and back off
# (with growing waits) whenever AO3 signals it's being hit too hard.
RATE_LIMIT_SECONDS = 6
BACKOFF_SECONDS = (30, 60, 120)
DEFAULT_REPAIR_MAX = 100
# Per-run cap on how many not-yet-offline works to fully download. Default is
# unbounded so the library fully populates (no half-empty works); requests are
# still spaced RATE_LIMIT_SECONDS apart and only missing works are fetched, so
# AO3 stays polite. Set OFFLINE_BACKFILL_MAX to a number to re-cap a run.
DEFAULT_OFFLINE_BACKFILL_MAX = None
# Per-run cap on how many legacy plain-text works to re-download with formatting
# intact. Unbounded by default (requests stay RATE_LIMIT_SECONDS apart); set
# REFLOW_MAX to a number to re-cap a run.
DEFAULT_REFLOW_MAX = None
# Per-run cap on how many ongoing (not-complete) offline works to re-check for
# new chapters. Unbounded by default (requests stay RATE_LIMIT_SECONDS apart and
# only NEW chapters are fetched); set REFRESH_ONGOING_MAX to a number to re-cap.
DEFAULT_REFRESH_ONGOING_MAX = None
# How many days an item stays in What's New before it ages out (it remains in the
# library either way). Override with WHATS_NEW_DAYS.
DEFAULT_WHATS_NEW_DAYS = 5


def check_env() -> None:
    """Verify required secrets are present without printing their values."""
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        print("Missing required environment variables:", ", ".join(missing))
        sys.exit(1)
    print("Environment OK — all required secrets present.")


def _maybe_login_ao3(ao3) -> None:
    """Log in to AO3 when AO3_USERNAME + AO3_PASSWORD are set, so members-only /
    registered-users-only works the account can access become fetchable (e.g. the
    series works a guest session can't download). Entirely optional: with no creds
    the worker runs logged-out on AO3's public pages exactly as before. The
    password is read from the env, used only to mint the session, and never stored
    or printed. Politeness is unchanged (requests stay RATE_LIMIT_SECONDS apart)."""
    user = os.environ.get("AO3_USERNAME", "").strip()
    pw = os.environ.get("AO3_PASSWORD", "")
    if not user or not pw:
        print("AO3: running logged-out (no AO3_USERNAME/AO3_PASSWORD set).")
        return
    try:
        name = ao3.authenticate(user, pw)
        print(f"AO3: logged in as {name} — members-only works are fetchable.")
    except Exception as exc:  # noqa: BLE001
        print(f"AO3: login failed ({type(exc).__name__}) — continuing logged-out.")


def _with_backoff(fn, *, what: str, broad: bool = False):
    """Run fn(), retrying with growing waits.

    Always retries RateLimitError. With broad=True, also retries any other
    exception — used for tag/language search listing pages, where AO3
    occasionally returns a malformed page under load that ao3-api surfaces as an
    AttributeError rather than a clean 429.
    """
    for attempt, wait in enumerate((0, *BACKOFF_SECONDS)):
        if wait:
            print(f"  retrying {what} after {wait}s…")
            time.sleep(wait)
        try:
            return fn()
        except RateLimitError:
            if attempt >= len(BACKOFF_SECONDS):
                raise
        except Exception:  # noqa: BLE001
            if not broad or attempt >= len(BACKOFF_SECONDS):
                raise
    raise RuntimeError(f"gave up on {what} after backoff")


def _repair_max() -> int | None:
    raw = os.environ.get("REPAIR_MAX", "").strip()
    if not raw:
        return DEFAULT_REPAIR_MAX
    if raw.lower() in ("0", "all", "none"):
        return None  # repair every blank work this run
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_REPAIR_MAX


def _offline_backfill_max() -> int | None:
    raw = os.environ.get("OFFLINE_BACKFILL_MAX", "").strip()
    if not raw:
        return DEFAULT_OFFLINE_BACKFILL_MAX
    if raw.lower() in ("0", "all", "none"):
        return None  # download every pending work this run
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_OFFLINE_BACKFILL_MAX


def _link_error_message(exc: Exception) -> str:
    """Turn a FanFicFare download failure into a message worth showing the user.

    Some sites (notably fanfiction.net) sit behind Cloudflare and return HTTP
    403 to datacenter IPs like GitHub Actions. There's no polite server-side way
    around that — it needs a real browser solving the challenge — so we surface
    an honest, actionable message instead of a raw "HTTPError: 403".
    """
    text = f"{type(exc).__name__}: {exc}"
    low = text.lower()
    if "403" in low or "cloudflare" in low or "forbidden" in low:
        return (
            "This site blocks automated downloads (HTTP 403 / Cloudflare). "
            "fanfiction.net in particular can't be archived from the server — "
            "try a Royal Road, Scribble Hub, SpaceBattles or AO3 link instead."
        )
    if "404" in low or "not found" in low:
        return "Story not found (404) — check the URL is correct and public."
    return text


def _should_drop_link_error(exc: Exception) -> bool:
    """Whether a failed link is a phantom (made-up / non-existent work) to delete
    rather than leave as a red error. Delegates to the pure, unit-tested helper."""
    return is_phantom_link_error(type(exc).__name__, str(exc))


def _handle_empty_ao3_link(db, rid, ao3, wid) -> bool:
    """Resolve an AO3 link request whose fetch returned no chapters.

    This is a REAL work (a fake id would have raised InvalidIdError, handled as a
    phantom drop), so we never silently delete it — that left the user staring at
    "Downloading…" forever with no work and no error. AO3's adult / age gate
    routinely parses as zero chapters, so we mirror the saves pass:

      * members-only (is_restricted) → terminal 'error' with a "read on AO3"
        message, since no logged-out fetch can ever get it. Returns True.
      * otherwise transient (gate / rate-limit / hiccup) → put the request back to
        'queued' so the next sync retries it. Returns False.
    """
    if ao3.is_restricted(wid):
        # Terminal: even the authenticated session can't read it (the account
        # isn't a member / can't access). 'restricted' is excluded from retries.
        mark_request(db, rid, status="restricted", error="Restricted to AO3 members — open it on AO3.")
        print("    restricted to AO3 members.")
        return True
    mark_request(db, rid, status="queued")
    print("    AO3 returned no chapters (likely adult gate / rate-limit) — re-queued to retry.")
    return False


def _reflow_max() -> int | None:
    raw = os.environ.get("REFLOW_MAX", "").strip()
    if not raw:
        return DEFAULT_REFLOW_MAX
    if raw.lower() in ("0", "all", "none"):
        return None  # re-download every legacy plain-text work this run
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_REFLOW_MAX


def _refresh_ongoing_max() -> int | None:
    raw = os.environ.get("REFRESH_ONGOING_MAX", "").strip()
    if not raw:
        return DEFAULT_REFRESH_ONGOING_MAX
    if raw.lower() in ("0", "all", "none"):
        return None  # re-check every ongoing work this run
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_REFRESH_ONGOING_MAX


def _full_refresh() -> bool:
    """True when this run should re-check EVERY work, not just ongoing ones."""
    return os.environ.get("FULL_REFRESH", "").strip().lower() in ("1", "true", "yes", "on")


def _saves_only() -> bool:
    """Fast path: fetch ONLY user-requested links + saves, then stop. Triggered
    when the app's Save button wants a work pulled in right now, so it doesn't
    wait behind the full library sweep (discovery, repair, refresh-all)."""
    return os.environ.get("SAVES_ONLY", "").strip().lower() in ("1", "true", "yes", "on")


def _reseed_tags() -> bool:
    """One-shot: re-run discovery ALL-TIME for every tracked group (ignore each
    group's last_checked) so existing matches get refreshed metadata — e.g. a
    backfilled Scribble Hub description — via the upsert. Safe: upsert_tag_matches
    leaves seen/saved/dismissed/later untouched, so nothing you've acted on is
    lost. Triggered by the manual run's 're-fetch discover tags' toggle."""
    return os.environ.get("RESEED_TAGS", "").strip().lower() in ("1", "true", "yes", "on")


def _full_refresh_max() -> int | None:
    """Cap for a full refresh (None = every work; the run may need to repeat for
    a very large library since there's no resume cursor)."""
    raw = os.environ.get("FULL_REFRESH_MAX", "").strip()
    if not raw or raw.lower() in ("0", "all", "none"):
        return None
    try:
        return max(1, int(raw))
    except ValueError:
        return None


def _series_max() -> int:
    """Max NEW works to download per followed series per run (politeness cap)."""
    raw = os.environ.get("SERIES_MAX", "").strip()
    try:
        return max(1, int(raw)) if raw else 12
    except ValueError:
        return 12


def _parse_ts(value) -> datetime | None:
    """Parse a Supabase ISO timestamp into an aware datetime, or None.

    Tolerates a trailing 'Z' and over-long fractional seconds (Postgres can emit
    more than the 6 digits datetime.fromisoformat accepts on older Pythons).
    """
    if not value:
        return None
    s = str(value).strip().replace("Z", "+00:00")
    # Clamp fractional seconds to 6 digits so fromisoformat doesn't choke.
    s = re.sub(r"(\.\d{6})\d+", r"\1", s)
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def run_ao3_series_pass(db, ao3, space, backoff) -> None:
    """Download works for followed / "download all" AO3 series (capped per run).

    Runs in the FAST saves-only lane too — not just the nightly full sweep — so a
    "Download all works" tap starts fetching now, like a Save does. Rows in
    followed_series are "download all" (follow=false, one-shot) or "follow"
    (follow=true, kept). Enumerates each series from AO3's public index, downloads
    any work not already offline (tagging it with its series + part), and drops a
    one-shot row once it's fully pulled.
    """
    print("\n== AO3 series ==")
    followed = fetch_followed_series(db)
    print(f"{len(followed)} followed/requested series.")
    if not followed:
        return
    offline_ids = fetch_offline_ao3_ids(db)
    series_cap = _series_max()
    for srow in followed:
        sid = (srow.get("series_id") or "").strip()
        if not sid:
            continue
        sname = srow.get("series_name") or ""
        try:
            space()
            works = backoff(lambda: ao3.series_works(sid), what=f"series {sid}", broad=True)
        except Exception as exc:  # noqa: BLE001
            print(f"    series {sid} skipped ({type(exc).__name__}: {exc})")
            continue
        got = 0
        hit_cap = False
        for index, (wid, _t) in enumerate(works, start=1):
            if wid in offline_ids:
                # Already downloaded — make sure it's tagged with this series.
                try:
                    set_work_series(db, wid, sid, sname, float(index))
                except Exception:  # noqa: BLE001
                    pass
                continue
            if got >= series_cap:
                hit_cap = True
                break
            try:
                meta, chapters = fetch_work_chapters(ao3, wid, space=space, backoff=backoff)
                if not chapters:  # restricted/gated — skip, don't loop forever
                    continue
                meta.series_id = sid
                meta.series_name = sname or meta.series_name
                meta.series_index = float(index)
                work_uuid = upsert_work(db, meta, origin="series")
                upsert_chapters(db, work_uuid, chapters)
                mark_flag(db, [wid], "offline")
                offline_ids.add(wid)
                got += 1
            except Exception as exc:  # noqa: BLE001
                print(f"    series work {wid} skipped ({type(exc).__name__}: {exc})")
        mark_series_checked(db, sid, name=sname, count=len(works))
        print(f"    series {sid} '{sname}': +{got} work(s) of {len(works)} total{' (more next run)' if hit_cap else ''}.")
        # A one-shot "download all" drops out once everything's pulled.
        if not srow.get("follow") and not hit_cap:
            delete_series_follow(db, sid)


def main() -> None:
    load_dotenv()  # picks up worker/.env locally; no-op in CI where vars are set
    check_env()

    ao3 = get_source("ao3")
    _maybe_login_ao3(ao3)
    db = make_client()

    # Only import works in languages the user can read; everything else is
    # dropped before it ever reaches the library or tag-match discovery.
    allowed_langs = allowed_language_set()

    def keep_language(meta) -> bool:
        return language_allowed(meta.language, allowed_langs)

    print(f"Language allowlist: {', '.join(sorted(allowed_langs))}")
    print("Running logged-out — AO3 public pages only, no account import.")

    processed: set[str] = set()  # work ids whose metadata we fetched this run
    have_offline: set[str] = set()  # work ids whose chapter text we stored this run
    request_count = 0

    # FanFicFare is heavy to import, so build the link fetcher lazily and share
    # the one instance between the requested-links pass and non-AO3 saves (Royal
    # Road, …), which both download full offline copies through it.
    _linker_box: dict = {}

    def get_linker():
        if "l" not in _linker_box:
            from ficstash_worker.sources.link import LinkFetcher

            _linker_box["l"] = LinkFetcher()
        return _linker_box["l"]

    def space() -> None:
        # Sleep between AO3 requests, but not before the very first one.
        nonlocal request_count
        if request_count:
            time.sleep(RATE_LIMIT_SECONDS)
        request_count += 1

    # ---- Pass 1: requested links → full offline copies via FanFicFare ------
    # Works the user added by pasting a URL in the app (Royal Road, Scribble
    # Hub, FFN, …). Runs first so a just-pasted link downloads promptly rather
    # than waiting behind the full library sweep. Polite per-chapter spacing.
    print("\n== Requested links ==")
    # Drop unsupported AO3 series links first (…/series/<id>) so they don't sit
    # in the app as 'Bad Story URL' failures. Individual work links still parse;
    # series are handled via follow / download-all.
    series_dropped = clear_series_requests(db)
    if series_dropped:
        print(f"Removed {series_dropped} unsupported AO3 series link(s).")
    link_requests = fetch_requested_urls(db)
    print(f"{len(link_requests)} link request(s).")
    link_done = link_failed = link_dropped = link_requeued = 0
    if link_requests:
        from ficstash_worker.sources.link import UnsupportedSite

        linker = get_linker()
        for req in link_requests:
            rid = req["id"]
            url = req["url"]
            print(f"[link] {url}")
            try:
                mark_request(db, rid, status="fetching")
                ao3_id = re.search(r"/works/(\d+)", url) if "archiveofourown.org" in url else None
                if ao3_id:
                    # AO3 link → use the AO3 source (rich tags/fandom/summary, the
                    # adult-content cookie, all chapters) and stamp source='ao3' so
                    # it lands in the Fics shelf. FanFicFare would trip on AO3's
                    # age-gate and fall back to a bare, mis-shelved 'other' work.
                    #
                    # Fetch the work FIRST and only consult is_restricted() if it
                    # comes back empty (see _handle_empty_ao3_link) — mirroring the
                    # saves pass. A pre-flight is_restricted() request fired right
                    # before the metadata request meant two unspaced AO3 hits per
                    # link; the second could be throttled into a gate/error page
                    # that parses as zero chapters, which then got silently dropped.
                    wid = ao3_id.group(1)
                    meta, chapters = fetch_work_chapters(ao3, wid, space=space, backoff=_with_backoff)
                else:
                    wid = None
                    space()
                    meta, chap_list = linker.prepare(url)
                    chapters = []
                    for i, ch in enumerate(chap_list):
                        space()
                        chapters.append(linker.fetch_chapter(url, i, ch))
                if not chapters:
                    if ao3_id:
                        # A REAL AO3 work (a made-up id raises InvalidIdError and is
                        # dropped in the handler below) that returned no text. AO3's
                        # adult / age gate routinely parses as zero chapters, so this
                        # is usually transient — never silently delete it. Members-
                        # only → terminal "read on AO3"; otherwise re-queue so the
                        # next sync retries, exactly like the saves pass does.
                        if _handle_empty_ao3_link(db, rid, ao3, wid):
                            link_failed += 1
                        else:
                            link_requeued += 1
                        continue
                    # Generic (FanFicFare) empty result → an AI-hallucinated link
                    # that points nowhere: drop it rather than leaving a red error.
                    delete_request(db, rid)
                    link_dropped += 1
                    print("    empty — no chapters; dropped.")
                    continue
                work_uuid = upsert_work(db, meta, origin="link")
                written = upsert_chapters(db, work_uuid, chapters)
                if not written:
                    if ao3_id:
                        if _handle_empty_ao3_link(db, rid, ao3, wid):
                            link_failed += 1
                        else:
                            link_requeued += 1
                        continue
                    delete_request(db, rid)
                    link_dropped += 1
                    print("    empty — nothing written; dropped.")
                    continue
                mark_flag(db, [meta.source_work_id], "offline", source=meta.source)
                mark_request(
                    db,
                    rid,
                    status="done",
                    source=meta.source,
                    source_work_id=meta.source_work_id,
                    title=meta.title,
                )
                link_done += 1
                print(f"    downloaded — {written} chapter(s) from {meta.source}.")
            except UnsupportedSite as exc:
                # Terminal: FanFicFare has no adapter for this site — retrying
                # won't help. 'unsupported' is excluded from retries.
                mark_request(db, rid, status="unsupported", error=f"Unsupported site: {exc}")
                link_failed += 1
                print(f"    unsupported site ({exc}).")
            except Exception as exc:  # noqa: BLE001
                if _should_drop_link_error(exc):
                    # Made-up / non-existent work (404 / invalid id) → drop it so
                    # it doesn't clutter the queue as a permanent red error.
                    delete_request(db, rid)
                    link_dropped += 1
                    print(f"    not found / invalid — dropped ({type(exc).__name__}: {exc})")
                else:
                    # Real work that hit a transient hiccup or site block — keep it
                    # as a retryable error rather than silently deleting it.
                    mark_request(db, rid, status="error", error=_link_error_message(exc))
                    link_failed += 1
                    print(f"    kept as error ({type(exc).__name__}: {exc})")
    extra = f", {link_dropped} dropped (empty/not found)" if link_dropped else ""
    extra += f", {link_requeued} re-queued (AO3 empty, will retry)" if link_requeued else ""
    print(f"Requested links: {link_done} downloaded, {link_failed} failed{extra}.")

    # ---- Pass 2: requested saves → full offline copies ---------------------
    # Works the user tapped "Save" on in the app (tag_matches.wanted), across
    # every source. AO3 works are fetched directly via the AO3 source; non-AO3
    # works (Royal Road, …) are downloaded through the FanFicFare link path using
    # the source's canonical work URL. Runs ahead of the library sweep so a
    # tapped Save lands quickly. Marks the match saved once it's in the library.
    print("\n== Requested saves ==")
    wanted = fetch_wanted_matches_all(db)
    print(f"{len(wanted)} work(s) requested.")
    saved_count = save_failed = 0
    for w in wanted:
        src_id = w["source"]
        wid = w["source_work_id"]
        try:
            if src_id == "ao3":
                if wid in have_offline:
                    # Already downloaded in full this run — just flag it.
                    mark_matches_saved(db, wid)
                    saved_count += 1
                    continue
                meta, chapters = fetch_work_chapters(
                    ao3, wid, space=space, backoff=_with_backoff
                )
                work_uuid = upsert_work(db, meta, origin="tag")
                written = upsert_chapters(db, work_uuid, chapters)
                if not written:
                    # No text fetched. If the work is restricted to logged-in AO3
                    # members, a guest can never get it — flag it and stop the
                    # endless retry so the app can show a "read on AO3" label.
                    # Otherwise leave it wanted so a later run retries.
                    if ao3.is_restricted(wid):
                        mark_flag(db, [wid], "restricted")
                        mark_matches_saved(db, wid)
                        save_failed += 1
                        print(f"    requested {wid} — restricted to AO3 members; flagged (read on AO3).")
                        continue
                    save_failed += 1
                    print(f"    requested {wid} — no chapters fetched, will retry.")
                    continue
                mark_flag(db, [wid], "offline")
                mark_matches_saved(db, wid)
                processed.add(wid)
                have_offline.add(wid)
                saved_count += 1
                print(f"    saved {wid} — {written} chapter(s).")
            else:
                # Non-AO3: download a full offline copy via FanFicFare, using the
                # source's canonical link. The FanFicFare metadata stamps the same
                # source id we stored the match under, so flags line up.
                try:
                    source = get_source(src_id)
                except KeyError:
                    save_failed += 1
                    print(f"    requested {src_id}:{wid} — unknown source, skipped.")
                    continue
                url = source.work_url(wid)
                linker = get_linker()
                space()
                meta, chap_list = linker.prepare(url)
                work_uuid = upsert_work(db, meta, origin="tag")
                chapters = []
                for i, ch in enumerate(chap_list):
                    space()
                    chapters.append(linker.fetch_chapter(url, i, ch))
                written = upsert_chapters(db, work_uuid, chapters)
                if not written:
                    save_failed += 1
                    print(f"    requested {src_id}:{wid} — no chapters, will retry.")
                    continue
                mark_flag(db, [meta.source_work_id], "offline", source=meta.source)
                mark_matches_saved(db, wid, source=src_id)
                saved_count += 1
                print(
                    f"    saved {src_id}:{wid} — {written} chapter(s) "
                    f"({meta.source})."
                )
        except Exception as exc:  # noqa: BLE001
            save_failed += 1
            print(f"    requested {src_id}:{wid} skipped ({type(exc).__name__}: {exc})")
    print(f"Requested saves: {saved_count} saved, {save_failed} failed.")

    # ---- AO3 series → 'follow' / 'download all' series works ----------------
    # Part of the FAST lane: a "Download all works" tap should start fetching now,
    # like a Save — so this runs before the saves-only early-return below (and
    # therefore in saves-only runs too), not buried at the end of the full sweep.
    run_ao3_series_pass(db, ao3, space, _with_backoff)

    # Fast path: the app asked for a real-time Save — links, saves + series are
    # done, so stop here instead of running the slow full sweep (repair/
    # discovery/refresh/new-chapter checks), which the nightly schedule handles.
    if _saves_only():
        print("\n== Saves-only run: links, saves + series done; skipping discovery/refresh. ==")
        return

    # ---- Pass 3: repair works with blank metadata --------------------------
    # Older builds tolerated an ao3-api reload() abort without falling back to
    # the soup, so some works landed with an empty title/author/fandom (readable
    # but blank on the library page). Re-fetch their metadata — now soup-backed —
    # a capped batch at a time. Metadata only; no chapter re-download.
    print("\n== Repair blank metadata ==")
    repair_ids = fetch_untitled_works(db, limit=_repair_max())
    print(f"{len(repair_ids)} work(s) with blank metadata to repair.")
    repaired = repair_failed = 0
    for wid in repair_ids:
        if wid in processed:
            continue  # already re-fetched this run
        try:
            space()
            meta = _with_backoff(
                lambda: ao3.fetch_work_metadata(wid), what=f"repair metadata {wid}"
            )
            if not meta.title:
                repair_failed += 1
                print(f"    repair {wid} — still no title, will retry.")
                continue
            upsert_work(db, meta)
            processed.add(wid)
            repaired += 1
            print(f"    repaired {wid} — {meta.title!r}.")
        except Exception as exc:  # noqa: BLE001
            repair_failed += 1
            print(f"    repair {wid} skipped ({type(exc).__name__}: {exc})")
    print(f"Repair: {repaired} repaired, {repair_failed} failed.")

    # ---- Pass 4: tracked tag groups → discover new matches -----------------
    print("\n== Tracked tag groups ==")
    groups = fetch_tracked_groups(db)
    print(f"{len(groups)} tracked group(s).")

    # ---- global discovery filters (app-editable; discovery_prefs row) -------
    # `languages` = only keep tag-discovery matches in these languages (empty =
    # all). Each entry carries native + English spellings so we match a work's
    # language string directly. `excluded_tags` are merged into every AO3 tag
    # search (AO3 drops them server-side as excluded_tag_names) and also used as
    # a post-filter safety net. Ratings are tags on AO3, so this covers "exclude
    # Explicit". Language *groups* are exempt — an explicit language follow is
    # the filter, so we never second-guess it with the global language pref.
    prefs = fetch_discovery_prefs(db)
    discovery_langs: set[str] = set()
    for entry in prefs.get("languages") or []:
        if isinstance(entry, dict):
            for key in ("native", "english", "code"):
                val = (entry.get(key) or "").strip().lower()
                if val:
                    discovery_langs.add(val)
    # Excluded tags are scoped per Discovery shelf: {ao3:[],sites:[],books:[]}, so
    # the user can exclude e.g. "litrpg" from Stories without touching AO3. A
    # legacy flat array (older rows) is treated as AO3-only. Each shelf's list is
    # folded into that shelf's group searches below.
    def _shelf_for_source(src: str) -> str:
        return "books" if src == "books" else "ao3" if src == "ao3" else "sites"

    def _names(items):
        return [n for n in ((t.get("name") if isinstance(t, dict) else str(t)) for t in (items or [])) if n]

    raw_excluded = prefs.get("excluded_tags") or []
    global_excluded_by_shelf: dict[str, list[str]] = {"ao3": [], "sites": [], "books": []}
    if isinstance(raw_excluded, dict):
        for shelf in ("ao3", "sites", "books"):
            global_excluded_by_shelf[shelf] = _names(raw_excluded.get(shelf))
    elif isinstance(raw_excluded, list):
        global_excluded_by_shelf["ao3"] = _names(raw_excluded)  # legacy = AO3-only
    if discovery_langs:
        print(f"  discovery languages: {sorted(discovery_langs)}")
    if any(global_excluded_by_shelf.values()):
        print(f"  global excluded tags by shelf: {global_excluded_by_shelf}")

    def keep_discovery_language(meta) -> bool:
        if not discovery_langs:
            return True  # no preference set → allow every language
        lang = (getattr(meta, "language", "") or "").strip().lower()
        if lang in ("", "unknown"):
            return True  # never drop on missing data
        return lang in discovery_langs

    reseed = _reseed_tags()  # one-shot: force all-time for every group this run
    if reseed:
        print("  RESEED_TAGS set → re-fetching ALL discover tags all-time (refreshes metadata; keeps your saved/seen/dismissed).")
    for g in groups:
        # First run (never checked) SEEDS the tag's whole back-catalogue: since
        # stays None → AO3 searches all-time, so a freshly tracked tag surfaces
        # its existing works (capped/paginated in search_group), not just ones
        # posted after you added it. Every run after that is incremental — only
        # works new since the previous sync. Both manual and auto syncs stamp
        # last_checked, so the window always advances. RESEED_TAGS forces all-time
        # for one run so existing matches get refreshed metadata via the upsert.
        last_checked = _parse_ts(g.get("last_checked"))
        since = None if reseed else last_checked  # None on first run / reseed → all-time
        anchor = "reseed / all-time" if reseed else ("last sync" if last_checked else "first run / all-time seed")
        window = since.isoformat() if since else "all-time"
        source_id = g.get("source") or "ao3"
        print(f"  window: works since {window} ({anchor}) · source {source_id}")
        tags_raw = g.get("tags") or []
        # A "Browse by language" group carries a single kind:'language' tag whose
        # id is AO3's language_id code; it's searched by language, not by tags.
        # Language browsing is AO3-only.
        lang_tag = next(
            (t for t in tags_raw if isinstance(t, dict) and t.get("kind") == "language"),
            None,
        )
        if lang_tag is not None and source_id == "ao3":
            code = str(lang_tag.get("id") or lang_tag.get("name") or "").strip()
            label = g.get("label") or lang_tag.get("name") or g["id"]
            if not code:
                print(f"    '{label}': no language code, skipped.")
                continue
            try:
                space()
                # The language search IS the filter here, so we keep every
                # result — including languages outside the import allowlist.
                metas = _with_backoff(
                    lambda: ao3.search_language(code, since=since),
                    what=f"language search '{label}'",
                    broad=True,
                )
                written = upsert_tag_matches(db, g["id"], metas)
                mark_group_checked(db, g["id"])
                print(f"    '{label}' (language): {written} match(es).")
            except Exception as exc:  # noqa: BLE001
                print(f"    '{label}' skipped ({type(exc).__name__}: {exc})")
            continue

        tag_names = [
            (t.get("name") if isinstance(t, dict) else str(t))
            for t in tags_raw
        ]
        tag_names = [t for t in tag_names if t]
        excluded_names = [
            (t.get("name") if isinstance(t, dict) else str(t))
            for t in (g.get("excluded_tags") or [])
        ]
        excluded_names = [t for t in excluded_names if t]
        # Fold in this shelf's global excluded tags (deduped, order-stable).
        for t in global_excluded_by_shelf.get(_shelf_for_source(source_id), []):
            if t not in excluded_names:
                excluded_names.append(t)
        label = g.get("label") or " + ".join(tag_names) or g["id"]
        if not tag_names:
            print(f"    '{label}': no tags, skipped.")
            continue

        # Completion-status filter on the group: 'complete' / 'ongoing' / 'all'.
        grp_status = (g.get("status") or "all").strip().lower()
        completed = True if grp_status == "complete" else False if grp_status == "ongoing" else None

        def _keep_status(m, gs=grp_status):
            return status_matches(getattr(m, "status", ""), gs)

        if source_id == "ao3":
            try:
                space()
                metas = _with_backoff(
                    lambda: ao3.search_group(
                        tag_names,
                        match_mode=g.get("match_mode", "all"),
                        excluded_tags=excluded_names,
                        since=since,
                        completed=completed,
                    ),
                    what=f"tag search '{label}'",
                    broad=True,
                )
                kept = [m for m in metas if keep_discovery_language(m) and _keep_status(m)]
                dropped = len(metas) - len(kept)
                written = upsert_tag_matches(db, g["id"], kept)
                mark_group_checked(db, g["id"])
                note = f" ({dropped} filtered by language)" if dropped else ""
                print(f"    '{label}': {written} match(es).{note}")
            except Exception as exc:  # noqa: BLE001
                print(f"    '{label}' skipped ({type(exc).__name__}: {exc})")
            continue

        # ---- non-AO3 sources (Royal Road, Scribble Hub, …) -----------------
        # Capability-gated discovery. A multi-tag group means "a work must carry
        # EVERY tag" (intersection / AND), matching how each site's own search
        # works — done in ONE native query via search_by_tags, not a union of
        # each tag's newest works (which rarely overlap and returned 0). Excluded
        # tags are subtracted in the same query.
        try:
            source = get_source(source_id)
        except KeyError:
            print(f"    '{label}': unknown source '{source_id}', skipped.")
            continue
        if not source.supports(TAG_SEARCH):
            print(f"    '{label}': source '{source_id}' has no tag search, skipped.")
            continue
        # Prefer each tag's stored id (the site's tag slug) over its display name.
        def _terms(items):
            out = [
                (t.get("id") or t.get("name")) if isinstance(t, dict) else str(t)
                for t in (items or [])
            ]
            return [t for t in out if t]

        include_terms = _terms(tags_raw)
        exclude_terms = _terms(g.get("excluded_tags"))
        # Fold in this shelf's global excluded tags (e.g. exclude "litrpg" from
        # Stories). Matched by name in the site's own search query.
        for t in global_excluded_by_shelf.get(_shelf_for_source(source_id), []):
            if t not in exclude_terms:
                exclude_terms.append(t)
        try:
            space()
            metas = _with_backoff(
                lambda: source.search_by_tags(include_terms, exclude_terms, limit=30),
                what=f"{source_id} tag search '{label}'",
                broad=True,
            )
            metas = [m for m in metas if _keep_status(m)]
            written = upsert_tag_matches(db, g["id"], metas)
            mark_group_checked(db, g["id"])
            note = f" (excluding {len(exclude_terms)})" if exclude_terms else ""
            print(f"    '{label}' ({source_id}): {written} match(es).{note}")
        except Exception as exc:  # noqa: BLE001
            print(f"    '{label}' skipped ({type(exc).__name__}: {exc})")

    # ---- Pass 5: offline backfill → full copies for everything else --------
    # The app is offline-first, so every work should be a full offline copy.
    # Anything that landed as metadata-only (e.g. a kept bookmark not yet
    # downloaded) gets its chapter bodies pulled a capped batch at a time so the
    # library fills in gradually without hammering AO3.
    print("\n== Offline backfill ==")
    # Self-heal: any work flagged offline but with no stored chapter text gets
    # un-flagged so it's re-fetched below (recovers works mis-flagged by older
    # builds or by an interrupted fetch).
    requeued = reset_empty_offline(db)
    if requeued:
        print(f"Re-queued {requeued} work(s) flagged offline but missing text.")
    backfill_max = _offline_backfill_max()
    pending = fetch_non_offline_works(db, limit=backfill_max)
    print(f"{len(pending)} work(s) need offline copies (max {backfill_max or 'no cap'}).")
    bf_done = bf_failed = 0
    for row in pending:
        wid = row["source_work_id"]
        if wid in have_offline:
            continue  # already downloaded in full this run
        try:
            space()
            meta = _with_backoff(
                lambda: ao3.fetch_work_metadata(wid), what=f"backfill metadata {wid}"
            )
            work_uuid = upsert_work(db, meta)
            chapters = []
            for n in range(1, meta.chapters + 1):
                space()
                chapters.append(
                    _with_backoff(
                        lambda n=n: ao3.fetch_chapter(wid, n),
                        what=f"chapter {n} of {wid}",
                    )
                )
            written = upsert_chapters(db, work_uuid, chapters)
            if not written:
                # Leave offline=False so a later run retries this work instead
                # of marking it downloaded while it has no readable text.
                bf_failed += 1
                print(f"    backfill {wid} — no chapters fetched, will retry.")
                continue
            mark_flag(db, [wid], "offline")
            processed.add(wid)
            have_offline.add(wid)
            bf_done += 1
            print(f"    backfilled {wid} — {written} chapter(s).")
        except Exception as exc:  # noqa: BLE001
            bf_failed += 1
            print(f"    backfill {wid} skipped ({type(exc).__name__}: {exc})")
    print(f"Offline backfill: {bf_done} downloaded, {bf_failed} failed.")

    # ---- Pass 6: reflow legacy plain-text chapters -------------------------
    # Early builds stored ao3-api's Chapter.text (markup stripped), which the
    # reader rendered as one unbroken blob with no paragraph spacing. Now that
    # the AO3 source stores real chapter HTML, re-download those legacy works so
    # their formatting is restored. A capped batch per run keeps AO3 polite.
    print("\n== Reflow legacy plain-text chapters ==")
    reflow_max = _reflow_max()
    # Opt-in (set REFLOW=1). This is a one-off cleanup that's effectively complete,
    # and its detection query is a full scan of every chapter's `content` — which
    # statement-timeouts (error 57014) on a large / image-rich library and was
    # CRASHING the whole sync here, aborting the refresh + series + retention passes
    # below. A full re-check (Pass 7) re-downloads chapters with HTML anyway, so
    # this is rarely needed. Skipped by default; wrapped so it can never abort sync.
    reflow_ids: list = []
    if os.environ.get("REFLOW", "").strip().lower() in ("1", "true", "yes", "on"):
        try:
            reflow_ids = fetch_plaintext_chapter_works(db, limit=reflow_max)
        except Exception as exc:  # noqa: BLE001
            print(f"    reflow scan skipped ({type(exc).__name__}: {exc})")
    else:
        print("    skipped (set REFLOW=1 to run; a full re-check covers it).")
    print(
        f"{len(reflow_ids)} work(s) have plain-text chapters to re-download "
        f"(max {reflow_max or 'no cap'})."
    )
    rf_done = rf_failed = 0
    for wid in reflow_ids:
        if wid in have_offline:
            continue  # already re-downloaded with HTML this run
        try:
            space()
            meta = _with_backoff(
                lambda: ao3.fetch_work_metadata(wid), what=f"reflow metadata {wid}"
            )
            work_uuid = upsert_work(db, meta)
            chapters = []
            for n in range(1, meta.chapters + 1):
                space()
                chapters.append(
                    _with_backoff(
                        lambda n=n: ao3.fetch_chapter(wid, n),
                        what=f"chapter {n} of {wid}",
                    )
                )
            written = upsert_chapters(db, work_uuid, chapters)
            if not written:
                rf_failed += 1
                print(f"    reflow {wid} — no chapters fetched, will retry.")
                continue
            have_offline.add(wid)
            rf_done += 1
            print(f"    reflowed {wid} — {written} chapter(s).")
        except Exception as exc:  # noqa: BLE001
            rf_failed += 1
            print(f"    reflow {wid} skipped ({type(exc).__name__}: {exc})")
    print(f"Reflow: {rf_done} re-downloaded, {rf_failed} failed.")

    # ---- Pass 7: refresh works → pull new chapters + re-read metadata ------
    # Normally we re-check only ONGOING works (and append new chapters). A "full
    # refresh" (FULL_REFRESH=1, e.g. the workflow's "Re-check ALL works" toggle)
    # instead re-reads EVERY downloaded work — refreshing status/counts, pulling
    # any new chapters, and backfilling AO3 series tags on the existing library.
    # Either way it's spaced RATE_LIMIT_SECONDS apart and capped to stay polite.
    full = _full_refresh()
    if full:
        print("\n== Full refresh: re-check ALL works ==")
        refresh_max = _full_refresh_max()
        ongoing = fetch_all_offline_works(db, limit=refresh_max)
        print(f"{len(ongoing)} work(s) to re-check (max {refresh_max or 'no cap'}).")
    else:
        print("\n== Refresh ongoing works ==")
        refresh_max = _refresh_ongoing_max()
        ongoing = fetch_ongoing_offline_works(db, limit=refresh_max)
        print(f"{len(ongoing)} ongoing work(s) to re-check (max {refresh_max or 'no cap'}).")
    rc_updated = rc_same = rc_failed = 0
    refresh_linker = None
    for row in ongoing:
        src_id = row.get("source") or "ao3"
        wid = row.get("source_work_id") or ""
        stored = int(row.get("chapters") or 0)
        try:
            if src_id == "ao3":
                space()
                meta = _with_backoff(
                    lambda: ao3.fetch_work_metadata(wid), what=f"refresh metadata {wid}"
                )
                work_uuid = upsert_work(db, meta)  # refresh status/counts, keep origin
                new_total = meta.chapters or 0
                if new_total > stored:
                    new_chs = []
                    for n in range(stored + 1, new_total + 1):
                        space()
                        new_chs.append(
                            _with_backoff(
                                lambda n=n: ao3.fetch_chapter(wid, n),
                                what=f"new chapter {n} of {wid}",
                            )
                        )
                    written = upsert_chapters(db, work_uuid, new_chs)
                    record_chapter_updates(db, work_uuid, "ao3", wid, new_chs)
                    rc_updated += 1
                    print(f"    {wid}: +{written} new chapter(s) (now {new_total}).")
                else:
                    rc_same += 1
            else:
                # Non-AO3 (Royal Road / Scribble Hub / link): re-read via the link
                # path and append any chapters beyond what we already stored.
                url = row.get("source_url") or ""
                if not url:
                    try:
                        url = get_source(src_id).work_url(wid)
                    except Exception:  # noqa: BLE001
                        url = ""
                if not url:
                    rc_failed += 1
                    print(f"    {src_id}:{wid} — no URL to re-check, skipped.")
                    continue
                if refresh_linker is None:
                    refresh_linker = get_linker()
                space()
                meta, chap_list = refresh_linker.prepare(url)
                work_uuid = upsert_work(db, meta)  # keep origin
                new_total = len(chap_list)
                if new_total > stored:
                    new_chs = []
                    for i in range(stored, new_total):
                        space()
                        new_chs.append(refresh_linker.fetch_chapter(url, i, chap_list[i]))
                    written = upsert_chapters(db, work_uuid, new_chs)
                    record_chapter_updates(db, work_uuid, meta.source, meta.source_work_id, new_chs)
                    rc_updated += 1
                    print(f"    {src_id}:{wid}: +{written} new chapter(s) (now {new_total}).")
                else:
                    rc_same += 1
        except Exception as exc:  # noqa: BLE001
            rc_failed += 1
            print(f"    refresh {src_id}:{wid} skipped ({type(exc).__name__}: {exc})")
    print(f"Refresh ongoing: {rc_updated} updated, {rc_same} unchanged, {rc_failed} failed.")

    # (AO3 series download now runs early — see run_ao3_series_pass, before the
    # saves-only return — so it's part of the fast lane, not the full sweep tail.)

    # ---- What's New retention: keep the feed to the last N days -----------------
    # Everything stays in the LIBRARY; this only declutters What's New. New-chapter
    # notices are deleted; discovery-saves flip origin 'tag' -> 'bookmark' so they
    # leave the "New works" feed but remain in the library.
    print("\n== What's New retention ==")
    try:
        raw = os.environ.get("WHATS_NEW_DAYS", "").strip()
        days = max(1, int(raw)) if raw.isdigit() else DEFAULT_WHATS_NEW_DAYS
        n_ch = expire_chapter_updates(db, older_than_days=days)
        n_sv = age_out_saved_matches(db, older_than_days=days)
        print(f"Aged out {n_ch} chapter notice(s) + {n_sv} saved work(s) older than {days}d.")
    except Exception as exc:  # noqa: BLE001
        print(f"What's New retention skipped ({type(exc).__name__}: {exc})")

    print("\nSync complete.")


if __name__ == "__main__":
    main()
