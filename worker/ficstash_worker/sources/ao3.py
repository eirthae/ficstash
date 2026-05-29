"""AO3 source — real implementation (Phase 1).

Uses the `ao3-api` package (imported as `AO3`) for login, bookmark enumeration,
metadata, and chapter text. FanFicFare is kept in requirements for future EPUB
export / additional sources, but AO3 itself is handled here because ao3-api maps
cleanly onto our WorkMeta/Chapter shapes and the Supabase schema.

AO3 is a volunteer-run nonprofit. Be polite:
  * keep RATE_LIMIT_SECONDS between requests (the caller spaces calls);
  * back off on HTTP 429 (raised as RateLimitError below);
  * prefer the single "entire work" view over per-chapter page hits.
Store the session, never the password.
"""

from __future__ import annotations

import time

import AO3

from .base import Source, WorkMeta, Chapter

RATE_LIMIT_SECONDS = 5

# Mirror app/src/data/sample.js COVER_PALETTES length and hashStr() so the
# worker assigns the same cover palette index the app would compute for a seed.
_PALETTE_COUNT = 8


class RateLimitError(Exception):
    """AO3 returned HTTP 429 — caller should back off and retry."""


def _hash_str(s: str) -> int:
    """Port of the app's hashStr(): h = (h*31 + charCode) >>> 0."""
    h = 0
    for ch in s or "":
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return h


def palette_for(seed: str) -> int:
    return _hash_str(seed or "") % _PALETTE_COUNT


def _is_rate_limited(exc: Exception) -> bool:
    """True if an exception looks like an AO3 429 / rate-limit response."""
    name = type(exc).__name__.lower()
    if "ratelimit" in name or "tooManyRequests".lower() in name:
        return True
    text = str(exc).lower()
    return "429" in text or "rate limit" in text or "too many requests" in text


class AO3Source(Source):
    id = "ao3"

    def __init__(self) -> None:
        self._session: AO3.Session | None = None
        # Cache the loaded Work between fetch_work_metadata() and fetch_chapter()
        # so we don't re-request the same work. Loading metadata is one request;
        # downloading chapter bodies (load_chapters) is a second, heavier one we
        # only make when a work has actually changed.
        self._work_cache: dict[str, "AO3.Work"] = {}
        self._chapters_loaded: set[str] = set()

    # ---- auth --------------------------------------------------------------
    def authenticate(self, username: str, password: str) -> str:
        """Log in and keep the session on this instance.

        Returns the logged-in username as an opaque token. The password is used
        only to mint the session and is never stored.
        """
        self._session = AO3.Session(username, password)
        return getattr(self._session, "username", username)

    def _require_session(self) -> "AO3.Session":
        if self._session is None:
            raise RuntimeError("AO3Source.authenticate() must run before fetching.")
        return self._session

    # ---- reading list ------------------------------------------------------
    def import_reading_list(self, session: str = "") -> list[WorkMeta]:
        """Return the user's AO3 bookmarks as lightweight WorkMeta.

        Only ids (and titles when AO3's listing exposes them) are populated here;
        full metadata + chapter bodies are fetched per-work by the caller, spaced
        out for politeness. Pagination is walked by ao3-api.
        """
        s = self._require_session()
        try:
            works = s.get_bookmarks(use_threading=False)
        except Exception as exc:  # noqa: BLE001 — normalize rate limits
            if _is_rate_limited(exc):
                raise RateLimitError(str(exc)) from exc
            raise
        return self._stubs(works)

    def import_history(self, max_pages: int | None = None) -> list[WorkMeta]:
        """Return the user's AO3 reading history as lightweight WorkMeta.

        This is the closest thing AO3 exposes to "all-time usage" — every work
        the user has opened (kudos-given history is NOT exposed by AO3). Stored
        metadata-only; we never download full chapter bodies for history items.
        `max_pages` bounds how many history listing pages we walk per run.
        """
        s = self._require_session()
        try:
            # ao3-api returns [(work, num_visits, last_visit), ...] for history.
            rows = s.get_history(max_pages=max_pages) if max_pages else s.get_history()
        except TypeError:
            rows = s.get_history()
        except Exception as exc:  # noqa: BLE001
            if _is_rate_limited(exc):
                raise RateLimitError(str(exc)) from exc
            raise
        works = [r[0] if isinstance(r, (tuple, list)) else r for r in (rows or [])]
        return self._stubs(works)

    def import_subscriptions(self) -> list[WorkMeta]:
        """Return the works the user subscribes to (followed for new chapters)."""
        s = self._require_session()
        getter = getattr(s, "get_work_subscriptions", None) or getattr(
            s, "get_subscriptions", None
        )
        if getter is None:
            return []
        try:
            works = getter(use_threading=False)
        except TypeError:
            works = getter()
        except Exception as exc:  # noqa: BLE001
            if _is_rate_limited(exc):
                raise RateLimitError(str(exc)) from exc
            raise
        return self._stubs(works)

    def _stubs(self, works) -> list[WorkMeta]:
        """Build lightweight WorkMeta (id + title) from a list of AO3 works."""
        out: list[WorkMeta] = []
        for w in works or []:
            wid = str(getattr(w, "id", "") or "")
            if not wid:
                continue
            out.append(
                WorkMeta(
                    source=self.id,
                    source_work_id=wid,
                    title=getattr(w, "title", "") or "",
                    author=_first_author(w),
                    url=f"https://archiveofourown.org/works/{wid}",
                )
            )
        return out

    # ---- per-work metadata + chapters --------------------------------------
    def fetch_work_metadata(self, source_work_id: str) -> WorkMeta:
        """Load one work's metadata only — no chapter bodies (one request).

        Cheap enough to call on every work each sync to detect new chapters.
        """
        work = self._load_work(source_work_id, with_chapters=False)
        return _work_to_meta(self.id, source_work_id, work)

    def fetch_chapter(self, source_work_id: str, chapter_n: int) -> Chapter:
        """Return one chapter's body, downloading chapter text on first use."""
        work = self._load_work(source_work_id, with_chapters=True)
        chapters = getattr(work, "chapters", None) or []
        # AO3 chapter numbers are 1-based; chapters list is 0-based.
        if chapter_n < 1 or chapter_n > len(chapters):
            return Chapter(n=chapter_n, title="", words=0, html="")
        ch = chapters[chapter_n - 1]
        return Chapter(
            n=chapter_n,
            title=getattr(ch, "title", "") or "",
            words=int(getattr(ch, "words", 0) or 0),
            html=_chapter_text(ch),
        )

    def _load_work(self, source_work_id: str, with_chapters: bool = False) -> "AO3.Work":
        work = self._work_cache.get(source_work_id)
        if work is None:
            s = self._require_session()
            try:
                work = AO3.Work(int(source_work_id), session=s, load=True)
            except Exception as exc:  # noqa: BLE001
                if _is_rate_limited(exc):
                    raise RateLimitError(str(exc)) from exc
                raise
            self._work_cache[source_work_id] = work

        if with_chapters and source_work_id not in self._chapters_loaded:
            try:
                if hasattr(work, "load_chapters"):
                    work.load_chapters()
            except Exception as exc:  # noqa: BLE001
                if _is_rate_limited(exc):
                    raise RateLimitError(str(exc)) from exc
                raise
            self._chapters_loaded.add(source_work_id)
        return work

    # ---- update detection --------------------------------------------------
    def check_for_updates(self, known: WorkMeta) -> WorkMeta | None:
        """Return fresh metadata if chapter count or update time changed."""
        fresh = self.fetch_work_metadata(known.source_work_id)
        if (
            fresh.chapters != known.chapters
            or fresh.words != known.words
            or fresh.updated != known.updated
        ):
            return fresh
        return None

    # ---- tag search (Phase 2 surface; basic implementation) ----------------
    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        try:
            search = AO3.Search(any_field="", tags=[tag], session=self._session)
            search.update()
        except TypeError:
            # Older ao3-api signatures differ; fall back to a query search.
            search = AO3.Search(query=tag, session=self._session)
            search.update()
        except Exception as exc:  # noqa: BLE001
            if _is_rate_limited(exc):
                raise RateLimitError(str(exc)) from exc
            raise

        out: list[WorkMeta] = []
        for w in (getattr(search, "results", None) or [])[:limit]:
            wid = str(getattr(w, "id", "") or "")
            if not wid:
                continue
            out.append(
                WorkMeta(
                    source=self.id,
                    source_work_id=wid,
                    title=getattr(w, "title", "") or "",
                    author=_first_author(w),
                    url=f"https://archiveofourown.org/works/{wid}",
                )
            )
        return out


# ---- helpers ---------------------------------------------------------------
def _first_author(work: "AO3.Work") -> str:
    authors = getattr(work, "authors", None)
    if authors:
        a = authors[0]
        return getattr(a, "username", None) or str(a)
    return ""


def _chapter_text(ch) -> str:
    for attr in ("text", "content"):
        val = getattr(ch, attr, None)
        if val:
            return str(val)
    return ""


def _status(work: "AO3.Work") -> str:
    raw = (getattr(work, "status", "") or "").strip().lower()
    return "complete" if raw in ("completed", "complete") else "ongoing"


def _tags(work: "AO3.Work") -> list[dict]:
    """Build the [{t,k}] tag shape the schema/app expect, keyed by kind."""
    out: list[dict] = []

    def add(values, kind):
        for v in values or []:
            name = getattr(v, "name", None) or str(v)
            if name:
                out.append({"t": name, "k": kind})

    add(getattr(work, "relationships", None), "relationship")
    add(getattr(work, "characters", None), "character")
    add(getattr(work, "tags", None), "freeform")
    return out


def _work_to_meta(source: str, source_work_id: str, work: "AO3.Work") -> WorkMeta:
    fandoms = getattr(work, "fandoms", None) or []
    fandom = ""
    if fandoms:
        f = fandoms[0]
        fandom = getattr(f, "name", None) or str(f)

    relationships = getattr(work, "relationships", None) or []
    pairing = ""
    if relationships:
        r = relationships[0]
        pairing = getattr(r, "name", None) or str(r)

    date_updated = getattr(work, "date_updated", None)
    updated_iso = date_updated.isoformat() if date_updated is not None else None

    nchapters = int(getattr(work, "nchapters", 0) or 0)
    expected = getattr(work, "expected_chapters", None)
    chapters_total = int(expected) if expected else None

    title = getattr(work, "title", "") or ""

    return WorkMeta(
        source=source,
        source_work_id=source_work_id,
        title=title,
        author=_first_author(work),
        fandom=fandom,
        pairing=pairing,
        summary=getattr(work, "summary", "") or "",
        tags=_tags(work),
        words=int(getattr(work, "words", 0) or 0),
        chapters=nchapters,
        chapters_total=chapters_total,
        status=_status(work),
        updated=updated_iso,
        url=f"https://archiveofourown.org/works/{source_work_id}",
    )
