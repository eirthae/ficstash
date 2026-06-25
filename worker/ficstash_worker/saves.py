"""Save-download helper — fetch a work's metadata + every chapter from a source.

Extracted from main.py's "requested saves" pass so the fetch logic is unit-
testable without network or a database. The save flow is:

  1. user taps Save on a tag match  → tag_matches.wanted = true (app)
  2. worker's requested-saves pass   → fetch_work_chapters(...) downloads it
  3. chapters are stored + the work is flagged offline + the match marked saved

`fetch_work_chapters` is deliberately I/O-free except for the two source calls it
makes through the injected `space` (rate-limit pause) and `backoff` (retry-on-429)
hooks, so tests can pass no-op hooks and a fake source.
"""

from __future__ import annotations


def fetch_work_chapters(source, source_work_id, *, space=None, backoff=None):
    """Fetch a work's metadata and every chapter via a source's
    `fetch_work_metadata(id)` / `fetch_chapter(id, n)`.

    Returns ``(meta, chapters)``. ``chapters`` is EMPTY when the work reports 0
    chapters — which happens when AO3 serves an adult / login-restricted gate
    page instead of the work (it parses as zero chapters), or for a genuinely
    empty work. The caller treats an empty result as "nothing fetched, leave it
    wanted and retry next run" rather than saving an empty work.
    """
    space = space or (lambda: None)
    backoff = backoff or (lambda fn, what="": fn())

    space()
    meta = backoff(lambda: source.fetch_work_metadata(source_work_id),
                   what=f"metadata {source_work_id}")

    n_chapters = int(getattr(meta, "chapters", 0) or 0)
    # AO3 already downloaded every chapter inside the metadata request (the whole
    # work view), so reading each chapter is a free, cached parse — spacing between
    # them just sleeps 6s per chapter for zero requests. Only space per chapter for
    # sources that genuinely fetch each one separately (the FanFicFare link path).
    space_per_chapter = not getattr(source, "fetches_full_work", False)
    chapters = []
    for n in range(1, n_chapters + 1):
        if space_per_chapter:
            space()
        chapters.append(
            backoff(lambda n=n: source.fetch_chapter(source_work_id, n),
                    what=f"chapter {n} of {source_work_id}")
        )
    return meta, chapters
