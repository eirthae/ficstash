"""FicStash worker entry point.

Reads secrets from the environment ONLY. Never hard-code or print credential
values. The service_role key lives here (server-side) and never ships in the
app, which uses the anon key behind Row Level Security.

Required environment variables:
  SUPABASE_URL                 Supabase project URL
  SUPABASE_SERVICE_ROLE_KEY    server-side key (NEVER in the app/repo)
  AO3_USERNAME                 AO3 login
  AO3_PASSWORD                 AO3 password (used to mint a session, not stored)

Flow (Phase 1): log in to AO3 → enumerate bookmarks → for each work, fetch full
metadata + chapter bodies (spaced for politeness) → upsert into Supabase. The
upsert omits reader-state columns so progress is preserved across re-syncs.
"""

from __future__ import annotations

import os
import sys
import time

from dotenv import load_dotenv

from ficstash_worker.sources import get_source
from ficstash_worker.sources.ao3 import RateLimitError
from ficstash_worker.supabase_io import make_client, upsert_chapters, upsert_work

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


def check_env() -> None:
    """Verify required secrets are present without printing their values."""
    missing = [name for name in REQUIRED_ENV if not os.environ.get(name)]
    if missing:
        print("Missing required environment variables:", ", ".join(missing))
        sys.exit(1)
    print("Environment OK — all required secrets present.")


def _with_backoff(fn, *, what: str):
    """Run fn(), retrying on RateLimitError with growing waits."""
    for attempt, wait in enumerate((0, *BACKOFF_SECONDS)):
        if wait:
            print(f"  rate limited — backing off {wait}s before retrying {what}…")
            time.sleep(wait)
        try:
            return fn()
        except RateLimitError:
            if attempt >= len(BACKOFF_SECONDS):
                raise
    raise RateLimitError(f"gave up on {what} after backoff")


def main() -> None:
    load_dotenv()  # picks up worker/.env locally; no-op in CI where vars are set
    check_env()

    ao3 = get_source("ao3")
    db = make_client()

    print("Logging in to AO3…")
    ao3.authenticate(os.environ["AO3_USERNAME"], os.environ["AO3_PASSWORD"])

    print("Fetching bookmarks…")
    reading_list = _with_backoff(ao3.import_reading_list, what="bookmark list")
    total = len(reading_list)
    print(f"Found {total} bookmarked work(s).")

    ok = 0
    for i, stub in enumerate(reading_list, start=1):
        wid = stub.source_work_id
        label = stub.title or f"work {wid}"
        print(f"[{i}/{total}] {label} (id {wid})")
        try:
            meta = _with_backoff(
                lambda: ao3.fetch_work_metadata(wid), what=f"metadata for {wid}"
            )
            work_uuid = upsert_work(db, meta)

            chapters = []
            for n in range(1, meta.chapters + 1):
                chapters.append(
                    _with_backoff(
                        lambda n=n: ao3.fetch_chapter(wid, n),
                        what=f"chapter {n} of {wid}",
                    )
                )
            written = upsert_chapters(db, work_uuid, chapters)
            print(f"    saved metadata + {written} chapter(s).")
            ok += 1
        except Exception as exc:  # noqa: BLE001 — keep going on per-work failures
            print(f"    skipped (error: {type(exc).__name__}: {exc})")

        if i < total:
            time.sleep(RATE_LIMIT_SECONDS)

    print(f"Done. Synced {ok}/{total} work(s).")


if __name__ == "__main__":
    main()
