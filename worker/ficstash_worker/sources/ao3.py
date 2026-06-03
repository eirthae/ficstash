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

import html
import math
import time
from datetime import datetime, timezone

import AO3

from .base import (
    DOWNLOAD,
    FOLLOW,
    GENRE_LIST,
    TAG_SEARCH,
    WORK_URL,
    Chapter,
    Source,
    WorkMeta,
)

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


def _revised_since(since: datetime | None) -> str:
    """AO3 'Date' search value selecting works revised on/after `since`.

    AO3's work search exposes only a relative date filter (work_search[revised_at]),
    e.g. '< 7 days' = revised within the last 7 days. We translate `since` into the
    smallest whole-day window that still covers it, rounding UP so we never drop a
    work that's newer than the cutoff (a little over-inclusion is harmless — matches
    are de-duped on upsert). Returns '' when there's no cutoff (search all-time).
    """
    if since is None:
        return ""
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)
    secs = (datetime.now(timezone.utc) - since).total_seconds()
    days = max(1, math.ceil(secs / 86400))
    return f"< {days} days"


def _is_rate_limited(exc: Exception) -> bool:
    """True if an exception looks like an AO3 429 / rate-limit response."""
    name = type(exc).__name__.lower()
    if "ratelimit" in name or "tooManyRequests".lower() in name:
        return True
    text = str(exc).lower()
    return "429" in text or "rate limit" in text or "too many requests" in text


class AO3Source(Source):
    id = "ao3"
    # AO3's public pages give us tag/language search, full downloads, ongoing-work
    # re-checks, and canonical links. No tag autocomplete yet (the app types tags
    # freehand and AO3's own search canonicalizes them).
    capabilities = frozenset({TAG_SEARCH, GENRE_LIST, DOWNLOAD, FOLLOW, WORK_URL})

    def work_url(self, source_work_id: str) -> str:
        return f"https://archiveofourown.org/works/{source_work_id}"

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
            # FicStash is a curated reader now, not an account mirror: it runs
            # logged-out (see main.py — no AO3 creds in REQUIRED_ENV). Public work
            # metadata, chapter bodies and tag/language search all work as a guest,
            # so lazily mint a guest session the first time one is needed.
            # authenticate() can still install a logged-in session for any future
            # account feature; until then this keeps every AO3 path working.
            self._session = AO3.GuestSession()
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
        Each stub carries `history_read_at` (AO3's "last visited" date) so the
        app can filter by the year the work was read.
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
        out: list[WorkMeta] = []
        for r in rows or []:
            work = r[0] if isinstance(r, (tuple, list)) else r
            last_visit = r[2] if isinstance(r, (tuple, list)) and len(r) > 2 else None
            stub = self._stub_one(work)
            if stub is None:
                continue
            stub.history_read_at = _to_iso(last_visit)
            out.append(stub)
        return out

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
            stub = self._stub_one(w)
            if stub is not None:
                out.append(stub)
        return out

    def _stub_one(self, w) -> WorkMeta | None:
        """Build one lightweight WorkMeta (id + title) from an AO3 work."""
        wid = str(getattr(w, "id", "") or "")
        if not wid:
            return None
        return WorkMeta(
            source=self.id,
            source_work_id=wid,
            title=getattr(w, "title", "") or "",
            author=_first_author(w),
            language=_language(w),
            url=f"https://archiveofourown.org/works/{wid}",
        )

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
            html=_chapter_html(ch),
        )

    def _load_work(self, source_work_id: str, with_chapters: bool = False) -> "AO3.Work":
        work = self._work_cache.get(source_work_id)
        if work is None:
            s = self._require_session()
            # Build the work without auto-loading, then reload() ourselves so we
            # can survive a quirk in ao3-api: its reload() does
            #   self._soup.find("h2", {"class", "heading"}).text
            # where the attrs filter is a *set*, not a dict, so on some valid work
            # layouts find() returns None and .text raises AttributeError —
            # aborting the whole load. Because _soup is already populated by then,
            # the metadata is in fact parseable, so we swallow that specific abort
            # and carry on. A genuine missing work still raises InvalidIdError.
            try:
                work = AO3.Work(int(source_work_id), session=s, load=False)
            except Exception as exc:  # noqa: BLE001
                if _is_rate_limited(exc):
                    raise RateLimitError(str(exc)) from exc
                raise
            try:
                work.reload(load_chapters=False)
            except Exception as exc:  # noqa: BLE001
                if _is_rate_limited(exc):
                    raise RateLimitError(str(exc)) from exc
                if type(exc).__name__ == "InvalidIdError":
                    raise
                if not getattr(work, "loaded", False):
                    # The page never came back — nothing to salvage.
                    raise
                print(
                    f"    note: tolerated ao3-api load quirk for work "
                    f"{source_work_id} ({type(exc).__name__}: {exc})"
                )
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

    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        return self.search_group([tag], match_mode="all", limit=limit)

    # ---- tag-group discovery -----------------------------------------------
    def search_group(
        self,
        tags: list[str],
        match_mode: str = "all",
        limit: int = 30,
        excluded_tags: list[str] | None = None,
        since: datetime | None = None,
    ) -> list[WorkMeta]:
        """Find recent works matching a tracked tag group, via AO3's own search.

        We feed tag names to AO3's works search so AO3's canonical-tag / synonym
        wrangling applies (e.g. "Soulmates AU" pulls in everything AO3 folds
        under it) — no naive string matching here.
          * match_mode 'all' (AND): one search with all tags included together.
          * match_mode 'any' (OR): one search per tag, results merged.
        `excluded_tags` are handed to AO3 as excluded_tag_names so any work
        carrying one is dropped before it becomes a match.
        `since` constrains results to works revised on/after that moment (AO3's
        own date filter), so a run only surfaces works new since the last sync;
        None searches all-time. Results are newest-first by date posted, deduped,
        capped at `limit`.
        """
        tags = [t for t in (tags or []) if t]
        if not tags:
            return []
        excluded_csv = ",".join(t for t in (excluded_tags or []) if t)
        revised = _revised_since(since)
        queries = [",".join(tags)] if match_mode == "all" else list(tags)

        seen: dict[str, WorkMeta] = {}
        for qi, q in enumerate(queries):
            if qi:
                time.sleep(RATE_LIMIT_SECONDS)  # space multi-tag 'any' searches
            for w in self._run_tag_search(q, limit, excluded_tags=excluded_csv, revised_at=revised):
                wid = str(getattr(w, "id", "") or "")
                if not wid or wid in seen:
                    continue
                seen[wid] = _work_to_meta(self.id, wid, w)
                if len(seen) >= limit:
                    break
        return list(seen.values())[:limit]

    # ---- language discovery ------------------------------------------------
    def search_language(
        self, language: str, limit: int = 30, since: datetime | None = None
    ) -> list[WorkMeta]:
        """Find recent works in one AO3 language (newest first, metadata only).

        `language` is AO3's language_id code (e.g. "hy" Armenian, "ja" Japanese).
        `since` constrains results to works revised on/after that moment, so a run
        only surfaces works new since the last sync (None = all-time). Mirrors
        search_group so language browsing feeds the same match flow.
        """
        language = (language or "").strip()
        if not language:
            return []
        revised = _revised_since(since)
        s = self._require_session()
        try:
            try:
                search = AO3.Search(
                    language=language,
                    revised_at=revised,
                    sort_column="created_at",
                    session=s,
                )
            except TypeError:
                search = AO3.Search(language=language, session=s)
            search.update()
        except Exception as exc:  # noqa: BLE001
            if _is_rate_limited(exc):
                raise RateLimitError(str(exc)) from exc
            raise

        out: dict[str, WorkMeta] = {}
        for w in (getattr(search, "results", None) or [])[:limit]:
            wid = str(getattr(w, "id", "") or "")
            if wid and wid not in out:
                out[wid] = _work_to_meta(self.id, wid, w)
        return list(out.values())[:limit]

    def _run_tag_search(
        self, tags_csv: str, limit: int, excluded_tags: str = "", revised_at: str = ""
    ):
        s = self._require_session()
        try:
            try:
                search = AO3.Search(
                    tags=tags_csv,
                    excluded_tags=excluded_tags,
                    revised_at=revised_at,
                    sort_column="created_at",
                    session=s,
                )
            except TypeError:
                # Older ao3-api signatures lack revised_at / sort_column / excluded_tags.
                try:
                    search = AO3.Search(
                        tags=tags_csv, excluded_tags=excluded_tags, session=s
                    )
                except TypeError:
                    search = AO3.Search(tags=tags_csv, session=s)
            search.update()
        except Exception as exc:  # noqa: BLE001
            if _is_rate_limited(exc):
                raise RateLimitError(str(exc)) from exc
            raise
        return (getattr(search, "results", None) or [])[:limit]


# ---- helpers ---------------------------------------------------------------
def _to_iso(value) -> str | None:
    """Normalize AO3's last-visited value (datetime/str) to an ISO string."""
    if value is None:
        return None
    iso = getattr(value, "isoformat", None)
    return iso() if callable(iso) else str(value)


def _language(work) -> str:
    """Read a work's language defensively.

    On search results / listing stubs the language comes from the blurb and is a
    plain attribute. On unloaded works without it, the `language` cached_property
    would touch a missing soup and raise — hence the broad guard.
    """
    try:
        return (getattr(work, "language", "") or "").strip()
    except Exception:  # noqa: BLE001
        return ""


def _first_author(work: "AO3.Work") -> str:
    authors = getattr(work, "authors", None)
    if authors:
        a = authors[0]
        return getattr(a, "username", None) or str(a)
    return ""


# ---- soup fallbacks --------------------------------------------------------
# When ao3-api's reload() aborts mid-parse (see _load_work), the Work object's
# attributes (title/fandoms/authors/…) never populate even though _soup holds
# the full work page. These read the same fields straight off the soup so a
# tolerated load still yields complete metadata instead of blank cards.
def _soup_of(work) -> "object | None":
    return getattr(work, "_soup", None)


def _soup_text(soup, selector: str) -> str:
    if soup is None:
        return ""
    el = soup.select_one(selector)
    return el.get_text(strip=True) if el else ""


def _soup_first_tag(soup, container_cls: str) -> str:
    """First tag name inside dd.<container_cls>.tags (e.g. fandom/relationship)."""
    if soup is None:
        return ""
    el = soup.select_one(f"dd.{container_cls}.tags a.tag")
    return el.get_text(strip=True) if el else ""


def _soup_tag_list(soup, container_cls: str, kind: str) -> list[dict]:
    if soup is None:
        return []
    out: list[dict] = []
    for a in soup.select(f"dd.{container_cls}.tags a.tag"):
        name = a.get_text(strip=True)
        if name:
            out.append({"t": name, "k": kind})
    return out


def _soup_chapters(soup) -> tuple[int, int | None]:
    """Parse 'n/total' (or 'n/?') out of dd.chapters; returns (n, total|None)."""
    raw = _soup_text(soup, "dd.chapters")
    if not raw:
        return 0, None
    parts = raw.split("/")
    try:
        n = int(parts[0].replace(",", "").strip())
    except ValueError:
        n = 0
    total: int | None = None
    if len(parts) > 1:
        t = parts[1].replace(",", "").strip()
        if t.isdigit():
            total = int(t)
    return n, total


def _soup_int(soup, selector: str) -> int:
    raw = _soup_text(soup, selector).replace(",", "").strip()
    return int(raw) if raw.isdigit() else 0


def _chapter_html(ch) -> str:
    """Return the chapter body as HTML so paragraph breaks and inline
    formatting survive into the reader.

    ao3-api's ``Chapter.text`` concatenates each paragraph's *plain text* with
    newlines, stripping all markup. The app injects chapter bodies with
    ``dangerouslySetInnerHTML``, where those newlines collapse to a single
    space — so the whole chapter renders as one unbroken blob with no spacing
    between paragraphs. To preserve formatting we instead pull the inner HTML
    of AO3's ``<div role="article">`` (the userstuff body), matching what the
    FanFicFare path already stores for other sources.

    Falls back to wrapping the plain text in ``<p>`` tags when the chapter
    soup isn't available (e.g. a future ao3-api that doesn't expose it).
    """
    soup = getattr(ch, "_soup", None)
    if soup is not None:
        try:
            div = soup.find("div", {"role": "article"})
            if div is None:
                div = soup.find("div", class_="userstuff")
            if div is not None:
                # Drop AO3's screen-reader landmark heading ("Chapter Text").
                for landmark in div.find_all("h3", class_="landmark"):
                    landmark.decompose()
                inner = div.decode_contents().strip()
                if inner:
                    return inner
        except Exception:  # noqa: BLE001 — fall through to the plain-text path
            pass

    # Fallback: plain text → one <p> per non-empty line, escaped.
    raw = ""
    for attr in ("text", "content"):
        val = getattr(ch, attr, None)
        if val:
            raw = str(val)
            break
    if not raw:
        return ""
    paras = [p.strip() for p in raw.replace("\r", "").split("\n")]
    return "".join(f"<p>{html.escape(p)}</p>" for p in paras if p)


def _status(work: "AO3.Work") -> str:
    raw = (getattr(work, "status", "") or "").strip().lower()
    if not raw:
        # On a tolerated reload() abort the attr is blank; the stats block's
        # dt.status reads "Completed:" for finished works, "Updated:" otherwise.
        raw = _soup_text(_soup_of(work), "dt.status").strip().lower()
    return "complete" if raw.startswith(("completed", "complete")) else "ongoing"


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
    # Soup is only consulted to fill blanks left by a tolerated reload() abort;
    # for cleanly loaded works every attribute is already set and soup is unused.
    soup = _soup_of(work)

    fandoms = getattr(work, "fandoms", None) or []
    fandom = ""
    if fandoms:
        f = fandoms[0]
        fandom = getattr(f, "name", None) or str(f)
    if not fandom:
        fandom = _soup_first_tag(soup, "fandom")

    relationships = getattr(work, "relationships", None) or []
    pairing = ""
    if relationships:
        r = relationships[0]
        pairing = getattr(r, "name", None) or str(r)
    if not pairing:
        pairing = _soup_first_tag(soup, "relationship")

    date_updated = getattr(work, "date_updated", None)
    updated_iso = date_updated.isoformat() if date_updated is not None else None
    if updated_iso is None:
        updated_iso = _soup_text(soup, "dd.status") or None

    nchapters = int(getattr(work, "nchapters", 0) or 0)
    expected = getattr(work, "expected_chapters", None)
    chapters_total = int(expected) if expected else None
    if not nchapters:
        nchapters, soup_total = _soup_chapters(soup)
        if chapters_total is None:
            chapters_total = soup_total

    title = getattr(work, "title", "") or ""
    if not title:
        title = _soup_text(soup, "h2.title.heading")

    author = _first_author(work) or _soup_text(soup, "h3.byline.heading a[rel=author]")

    summary = getattr(work, "summary", "") or ""
    if not summary:
        summary = _soup_text(soup, "div.summary blockquote")

    tags = _tags(work)
    if not tags:
        tags = (
            _soup_tag_list(soup, "relationship", "relationship")
            + _soup_tag_list(soup, "character", "character")
            + _soup_tag_list(soup, "freeform", "freeform")
        )

    words = int(getattr(work, "words", 0) or 0)
    if not words:
        words = _soup_int(soup, "dd.words")

    return WorkMeta(
        source=source,
        source_work_id=source_work_id,
        title=title,
        author=author,
        fandom=fandom,
        pairing=pairing,
        summary=summary,
        tags=tags,
        language=_language(work),
        words=words,
        chapters=nchapters,
        chapters_total=chapters_total,
        status=_status(work),
        updated=updated_iso,
        url=f"https://archiveofourown.org/works/{source_work_id}",
    )
