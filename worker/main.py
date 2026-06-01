"""FicStash worker entry point.

Reads secrets from the environment ONLY. Never hard-code or print credential
values. The service_role key lives here (server-side) and never ships in the
app, which uses the anon key behind Row Level Security.

Required environment variables:
  SUPABASE_URL                 Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY    server-side key (NEVER in the app/repo)
  AO3_USERNAME                 AO3 login
  AO3_PASSWORD                 AO3 password (used to mint a session, not stored)

Optional:
  HISTORY_MAX_PAGES            how many reading-history listing pages to walk
                               per run (default 3 ≈ 60 works). Already-stored
                               history works are just re-flagged, so history
                               backfills a little each run rather than all at once.
  OFFLINE_BACKFILL_MAX         how many not-yet-offline works to fully download
                               per run (default 25; "all"/0 = no cap). Keeps the
                               offline backfill gradual and polite to AO3.

Flow: log in → passes over the user's AO3 activity:
  1. Bookmarks   → full offline copies (metadata + chapter bodies).
  2. Subscriptions → register metadata, flagged for new-chapter tracking.
  3. Reading history → register metadata ("all-time usage"; new entries backfilled).
  4. Tracked tag groups → discover new matches.
  5. Requested saves → full offline copies for in-app Save requests.
  6. Requested links → full offline copies of works added by pasted URL
     (Royal Road, Scribble Hub, FFN, …) via FanFicFare.
  7. Offline backfill → download full chapter text for any work that isn't a
     full offline copy yet (subscriptions/history), capped per run. The app is
     offline-first: every work should become readable offline by default.
Upserts omit reader-state columns so progress survives re-syncs, and unchanged
works are never re-downloaded.
"""

from __future__ import annotations

import os
import sys
import time

from dotenv import load_dotenv

from ficstash_worker.lang import allowed_language_set, language_allowed
from ficstash_worker.sources import get_source
from ficstash_worker.sources.ao3 import RateLimitError
from ficstash_worker.supabase_io import (
    fetch_existing_works,
    fetch_non_offline_works,
    fetch_requested_urls,
    fetch_tracked_groups,
    fetch_wanted_matches,
    make_client,
    mark_flag,
    mark_group_checked,
    mark_in_history,
    mark_matches_saved,
    mark_request,
    reset_empty_offline,
    upsert_chapters,
    upsert_tag_matches,
    upsert_work,
)

REQUIRED_ENV = (
    "SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "AO3_USERNAME",
    "AO3_PASSWORD",
)

# AO3 is a volunteer nonprofit — stay polite. Space requests apart and back off
# (with growing waits) whenever AO3 signals it's being hit too hard.
RATE_LIMIT_SECONDS = 6
BACKOFF_SECONDS = (30, 60, 120)
DEFAULT_HISTORY_MAX_PAGES = 3
# Per-run cap on how many not-yet-offline works to fully download. Default is
# unbounded so the library fully populates (no half-empty works); requests are
# still spaced RATE_LIMIT_SECONDS apart and only missing works are fetched, so
# AO3 stays polite. Set OFFLINE_BACKFILL_MAX to a number to re-cap a run.
DEFAULT_OFFLINE_BACKFILL_MAX = None


def check_env() -> None:
    """Verify required secrets are present without printing their values."""
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        print("Missing required environment variables:", ", ".join(missing))
        sys.exit(1)
    print("Environment OK — all required secrets present.")


def _with_backoff(fn, *, what: str, broad: bool = False):
    """Run fn(), retrying with growing waits.

    Always retries RateLimitError. With broad=True, also retries any other
    exception — used for listing pages (bookmarks/history/subscriptions), where
    AO3 occasionally returns a malformed page under load that ao3-api surfaces
    as an AttributeError rather than a clean 429.
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


def _history_max_pages() -> int | None:
    raw = os.environ.get("HISTORY_MAX_PAGES", "").strip()
    if not raw:
        return DEFAULT_HISTORY_MAX_PAGES
    if raw.lower() in ("0", "all", "none"):
        return None  # walk every page
    try:
        return max(1, int(raw))
    except ValueError:
        return DEFAULT_HISTORY_MAX_PAGES


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


def main() -> None:
    load_dotenv()  # picks up worker/.env locally; no-op in CI where vars are set
    check_env()

    ao3 = get_source("ao3")
    db = make_client()

    # Only import works in languages the user can read; everything else is
    # dropped before it ever reaches the library or tag-match discovery.
    allowed_langs = allowed_language_set()

    def keep_language(meta) -> bool:
        return language_allowed(meta.language, allowed_langs)

    print(f"Language allowlist: {', '.join(sorted(allowed_langs))}")

    print("Logging in to AO3…")
    ao3.authenticate(os.environ["AO3_USERNAME"], os.environ["AO3_PASSWORD"])

    print("Loading already-stored works…")
    existing = fetch_existing_works(db)
    print(f"{len(existing)} work(s) already in the library.")

    processed: set[str] = set()  # work ids whose metadata we fetched this run
    have_offline: set[str] = set()  # work ids whose chapter text we stored this run
    request_count = 0

    def space() -> None:
        # Sleep between AO3 requests, but not before the very first one.
        nonlocal request_count
        if request_count:
            time.sleep(RATE_LIMIT_SECONDS)
        request_count += 1

    # ---- Pass 1: bookmarks → full offline copies ---------------------------
    print("\n== Bookmarks ==")
    bookmarks = _with_backoff(
        ao3.import_reading_list, what="bookmark list", broad=True
    )
    total = len(bookmarks)
    print(f"Found {total} bookmarked work(s).")

    new_count = updated_count = unchanged = failed = filtered = 0
    for i, stub in enumerate(bookmarks, start=1):
        wid = stub.source_work_id
        # Cheap pre-filter on the listing-blurb language — skips a request when
        # the work is plainly in a language we don't import.
        if not keep_language(stub):
            filtered += 1
            continue
        print(f"[{i}/{total}] {stub.title or wid} (id {wid})")
        try:
            space()
            meta = _with_backoff(
                lambda: ao3.fetch_work_metadata(wid), what=f"metadata {wid}"
            )
            if not keep_language(meta):
                filtered += 1
                print(f"    filtered — language {meta.language!r} not in allowlist.")
                continue
            # Don't flag offline yet — only after chapter text is actually
            # stored, so a work is never shown as "downloaded" while empty.
            work_uuid = upsert_work(db, meta, bookmarked=True)
            processed.add(wid)

            prev = existing.get(wid)
            is_new = prev is None
            changed = (
                is_new
                # Not yet a full offline copy — older builds stored the chapter
                # *count* from metadata without the chapter *bodies*, so the
                # counts below would falsely match. Re-download until offline.
                or not prev.get("offline")
                or prev.get("chapters") != meta.chapters
                or prev.get("words") != meta.words
            )
            if not changed:
                unchanged += 1
                print("    unchanged — kept existing chapters.")
            else:
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
                if written:
                    mark_flag(db, [wid], "offline")
                    have_offline.add(wid)
                new_count += is_new
                updated_count += not is_new
                tag = "NEW" if is_new else "UPDATED"
                print(f"    {tag} — saved metadata + {written} chapter(s).")
        except Exception as exc:  # noqa: BLE001 — keep going on per-work failures
            failed += 1
            print(f"    skipped (error: {type(exc).__name__}: {exc})")
    print(
        f"Bookmarks: {new_count} new, {updated_count} updated, "
        f"{unchanged} unchanged, {filtered} filtered, {failed} failed."
    )

    # ---- Pass 2: subscriptions → metadata + new-chapter tracking -----------
    print("\n== Subscriptions ==")
    subs = _with_backoff(
        ao3.import_subscriptions, what="subscriptions", broad=True
    )
    print(f"Found {len(subs)} subscription(s).")
    sub_fetched = sub_flagged = sub_failed = sub_filtered = 0
    already_subbed: list[str] = []
    for stub in subs:
        wid = stub.source_work_id
        if wid in processed:
            already_subbed.append(wid)  # bookmarked too — just set the flag
            continue
        if not keep_language(stub):
            sub_filtered += 1
            continue
        try:
            space()
            meta = _with_backoff(
                lambda: ao3.fetch_work_metadata(wid), what=f"sub metadata {wid}"
            )
            if not keep_language(meta):
                sub_filtered += 1
                continue
            upsert_work(db, meta, subscribed=True)
            processed.add(wid)
            sub_fetched += 1
        except Exception as exc:  # noqa: BLE001
            sub_failed += 1
            print(f"    sub {wid} skipped ({type(exc).__name__}: {exc})")
    if already_subbed:
        sub_flagged = mark_flag(db, already_subbed, "subscribed")
    print(
        f"Subscriptions: {sub_fetched} fetched, {sub_flagged} flagged, "
        f"{sub_filtered} filtered, {sub_failed} failed."
    )

    # ---- Pass 3: reading history → metadata only ("all-time usage") --------
    print("\n== Reading history ==")
    max_pages = _history_max_pages()
    history = _with_backoff(
        lambda: ao3.import_history(max_pages=max_pages),
        what="reading history",
        broad=True,
    )
    print(f"Found {len(history)} history work(s) (max_pages={max_pages}).")
    hist_fetched = hist_failed = hist_filtered = 0
    flag_only: dict[str, str | None] = {}  # source_work_id -> last-read ISO date
    for stub in history:
        wid = stub.source_work_id
        if wid in processed or wid in existing:
            # already stored — just mark in_history + stamp the read date
            flag_only[wid] = stub.history_read_at
            continue
        if not keep_language(stub):
            hist_filtered += 1
            continue
        try:
            space()
            meta = _with_backoff(
                lambda: ao3.fetch_work_metadata(wid), what=f"history metadata {wid}"
            )
            if not keep_language(meta):
                hist_filtered += 1
                continue
            upsert_work(
                db, meta, in_history=True, history_read_at=stub.history_read_at
            )
            processed.add(wid)
            hist_fetched += 1
        except Exception as exc:  # noqa: BLE001
            hist_failed += 1
            print(f"    history {wid} skipped ({type(exc).__name__}: {exc})")
    hist_flagged = mark_in_history(db, flag_only) if flag_only else 0
    print(
        f"History: {hist_fetched} newly stored, {hist_flagged} flagged, "
        f"{hist_filtered} filtered, {hist_failed} failed."
    )

    # ---- Pass 4: tracked tag groups → discover new matches -----------------
    print("\n== Tracked tag groups ==")
    groups = fetch_tracked_groups(db)
    print(f"{len(groups)} tracked group(s).")
    for g in groups:
        tags_raw = g.get("tags") or []
        # A "Browse by language" group carries a single kind:'language' tag whose
        # id is AO3's language_id code; it's searched by language, not by tags.
        lang_tag = next(
            (t for t in tags_raw if isinstance(t, dict) and t.get("kind") == "language"),
            None,
        )
        if lang_tag is not None:
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
                    lambda: ao3.search_language(code),
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
        label = g.get("label") or " + ".join(tag_names) or g["id"]
        if not tag_names:
            print(f"    '{label}': no tags, skipped.")
            continue
        try:
            space()
            metas = _with_backoff(
                lambda: ao3.search_group(
                    tag_names,
                    match_mode=g.get("match_mode", "all"),
                    excluded_tags=excluded_names,
                ),
                what=f"tag search '{label}'",
                broad=True,
            )
            kept = [m for m in metas if keep_language(m)]
            dropped = len(metas) - len(kept)
            written = upsert_tag_matches(db, g["id"], kept)
            mark_group_checked(db, g["id"])
            note = f" ({dropped} filtered by language)" if dropped else ""
            print(f"    '{label}': {written} match(es).{note}")
        except Exception as exc:  # noqa: BLE001
            print(f"    '{label}' skipped ({type(exc).__name__}: {exc})")

    # ---- Pass 5: requested saves → full offline copies ---------------------
    # Works the user tapped "Save" on in the app (tag_matches.wanted). Fetch the
    # full work like a bookmark, store it offline, then mark the match saved.
    print("\n== Requested saves ==")
    wanted = fetch_wanted_matches(db)
    print(f"{len(wanted)} work(s) requested.")
    saved_count = save_failed = 0
    for wid in wanted:
        if wid in have_offline:
            # Already downloaded in full this run (e.g. also a bookmark) — just flag it.
            mark_matches_saved(db, wid)
            saved_count += 1
            continue
        try:
            space()
            meta = _with_backoff(
                lambda: ao3.fetch_work_metadata(wid), what=f"requested metadata {wid}"
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
                # No text fetched — leave it un-flagged and still wanted so a
                # later run retries, rather than showing an empty work.
                save_failed += 1
                print(f"    requested {wid} — no chapters fetched, will retry.")
                continue
            mark_flag(db, [wid], "offline")
            mark_matches_saved(db, wid)
            processed.add(wid)
            have_offline.add(wid)
            saved_count += 1
            print(f"    saved {wid} — {written} chapter(s).")
        except Exception as exc:  # noqa: BLE001
            save_failed += 1
            print(f"    requested {wid} skipped ({type(exc).__name__}: {exc})")
    print(f"Requested saves: {saved_count} saved, {save_failed} failed.")

    # ---- Pass 6: requested links → full offline copies via FanFicFare ------
    # Works the user added by pasting a URL in the app (Royal Road, Scribble
    # Hub, FFN, …). Runs before the long backfill so a just-pasted link
    # downloads promptly. Same per-chapter spacing as AO3 to stay polite.
    print("\n== Requested links ==")
    link_requests = fetch_requested_urls(db)
    print(f"{len(link_requests)} link request(s).")
    link_done = link_failed = 0
    if link_requests:
        from ficstash_worker.sources.link import LinkFetcher, UnsupportedSite

        linker = LinkFetcher()
        for req in link_requests:
            rid = req["id"]
            url = req["url"]
            print(f"[link] {url}")
            try:
                mark_request(db, rid, status="fetching")
                space()
                meta, chap_list = linker.prepare(url)
                work_uuid = upsert_work(db, meta)
                chapters = []
                for i, ch in enumerate(chap_list):
                    space()
                    chapters.append(linker.fetch_chapter(url, i, ch))
                written = upsert_chapters(db, work_uuid, chapters)
                if not written:
                    mark_request(db, rid, status="error", error="No chapters fetched.")
                    link_failed += 1
                    print("    no chapters fetched.")
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
                mark_request(db, rid, status="error", error=f"Unsupported site: {exc}")
                link_failed += 1
                print(f"    unsupported site ({exc}).")
            except Exception as exc:  # noqa: BLE001
                mark_request(db, rid, status="error", error=f"{type(exc).__name__}: {exc}")
                link_failed += 1
                print(f"    skipped ({type(exc).__name__}: {exc})")
    print(f"Requested links: {link_done} downloaded, {link_failed} failed.")

    # ---- Pass 7: offline backfill → full copies for everything else --------
    # The app is offline-first, so every work should be a full offline copy.
    # Subscriptions/history land as metadata only; here we download their
    # chapter bodies a capped batch at a time so the library fills in gradually
    # without hammering AO3.
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

    print("\nSync complete.")


if __name__ == "__main__":
    main()
