"""Books source — published-book release watcher via Open Library (Phase F/J).

Unlike the fiction sources, this one is *notify-only*. FicStash can't download a
commercial ebook, so a "Books" tracker watches a SUBJECT (genre/theme — e.g.
"fantasy", "magic", "dragons") and surfaces matching new releases in the swipe
feed; when the user buys the EPUB they add it through the upload path (Phase B).
So this source declares only TAG_SEARCH (the discovery engine, keyed on Open
Library subjects) + WORK_URL (a canonical Open Library link). It deliberately
does NOT declare DOWNLOAD/FOLLOW, so the registry never asks it to fetch chapter
bodies and the app hides the Save button.

Subjects, not authors (Phase J): the user wanted to follow a shelf/genre the way
Goodreads shelves work, not a single author. Goodreads/StoryGraph/LibraryThing
are all Cloudflare-blocked from CI (like NovelUpdates), so the feed is Open
Library, whose search.json ANDs multiple `subject:` clauses and subtracts
`-subject:` clauses — giving a tracked group real AND + exclude semantics.

Politeness mirrors the rest of the worker: the caller spaces requests itself
(the worker's `space()`), and Open Library asks API users to send a descriptive
User-Agent, which we do. A transient error/429 surfaces as a normal exception
the caller's backoff handles; a skipped run just means releases arrive next sync.
"""

from __future__ import annotations

import json
from urllib.parse import quote_plus

import requests

from .base import TAG_SEARCH, WORK_URL, Source, WorkMeta

BASE = "https://openlibrary.org"
# Open Library requests a descriptive UA with a contact so they can reach out if
# a client misbehaves; see https://openlibrary.org/developers/api .
_HEADERS = {
    "User-Agent": "FicStash/1.0 (personal reading tracker; +https://github.com/eirthae/ficstash)",
    "Accept": "application/json",
}
_TIMEOUT = 25

# Only the fields we actually use — keeps the response small and fast.
_FIELDS = "key,title,author_name,first_publish_year,language,subject"

# Open Library returns ISO 639-2/B three-letter codes ("eng", "jpn", ...). Map
# the common ones to the native-script names the rest of the app displays; fall
# back to the raw code (title-cased) for anything unlisted.
_LANG_NAMES = {
    "eng": "English",
    "jpn": "日本語",
    "rus": "Русский",
    "fre": "Français",
    "fra": "Français",
    "ger": "Deutsch",
    "deu": "Deutsch",
    "spa": "Español",
    "ita": "Italiano",
    "por": "Português",
    "chi": "中文",
    "zho": "中文",
    "kor": "한국어",
    "arm": "Հայերեն",
    "hye": "Հայերեն",
}


def _lang_name(codes) -> str:
    """First language code from a doc -> a display name (or "" if absent)."""
    if not codes:
        return ""
    code = codes[0] if isinstance(codes, list) else codes
    code = (code or "").strip().lower()
    if not code:
        return ""
    return _LANG_NAMES.get(code, code.title())


def _subject_clause(term: str, negate: bool = False) -> str:
    """A single `subject:"…"` (or `-subject:"…"`) clause for search.json's q."""
    t = (term or "").strip().replace('"', "")
    if not t:
        return ""
    return f'{"-" if negate else ""}subject:"{t}"'


class BooksSource(Source):
    id = "books"
    # Discovery (by subject/genre) + a canonical link. Notify-only: NO
    # download/follow, so the app hides the Save button and the user uploads the
    # bought EPUB.
    capabilities = frozenset({TAG_SEARCH, WORK_URL})

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers.update(_HEADERS)

    def work_url(self, source_work_id: str) -> str:
        # source_work_id is the Open Library work key without the "/works/"
        # prefix, e.g. "OL45153903W".
        return f"{BASE}/works/{source_work_id}"

    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        """Find recent books in a single subject (metadata only)."""
        return self.search_by_tags([tag], limit=limit)

    def search_by_tags(
        self,
        include: list[str],
        exclude: list[str] | tuple[str, ...] = (),
        limit: int = 25,
    ) -> list[WorkMeta]:
        """Find recent books matching ALL `include` subjects and NONE of
        `exclude` (metadata only).

        Open Library's search.json ANDs multiple `subject:` clauses and subtracts
        `-subject:` clauses in one query, sorted newest-first — so a tracked
        Books group gets the same AND + exclude semantics as the fiction sources.
        """
        inc = [c for c in (_subject_clause(t) for t in include) if c]
        if not inc:
            return []
        exc = [c for c in (_subject_clause(t, negate=True) for t in (exclude or [])) if c]

        # 1) Strict: every term must be an Open Library *subject* (newest first).
        docs = self._query(" ".join(inc + exc), limit=limit, sort="new")

        # 2) Forgiving fallback: OL subjects are a stiff catalog vocabulary, so
        #    reader-style tags ("enemies to lovers") often match no subject under
        #    strict AND. When the strict query is empty, retry as a loose
        #    free-text search over the raw terms (relevance-ranked, still
        #    subtracting any excluded subjects) so a group returns relevant books
        #    instead of nothing. (Tags with no book-catalogue equivalent at all —
        #    e.g. "male lead" — still find nothing; that's Open Library's limit.)
        if not docs:
            terms = " ".join(t.strip() for t in include if t and t.strip())
            if terms:
                q = " ".join([terms] + exc)
                docs = self._query(q, limit=limit, sort=None)

        return _parse_docs(docs, limit=limit)

    def _query(self, q: str, *, limit: int, sort: str | None) -> list:
        """One Open Library search.json request → its `docs` list."""
        url = f"{BASE}/search.json?q={quote_plus(q)}&limit={int(limit)}&fields={_FIELDS}"
        if sort:
            url += f"&sort={sort}"
        resp = self._session.get(url, timeout=_TIMEOUT)
        resp.raise_for_status()
        return json.loads(resp.text).get("docs", [])


def _parse_docs(docs: list, limit: int) -> list[WorkMeta]:
    out: list[WorkMeta] = []
    seen: set[str] = set()

    for doc in docs:
        key = (doc.get("key") or "").strip()
        # Work keys look like "/works/OL12345W"; strip the prefix for the id.
        wid = key.rsplit("/", 1)[-1] if key else ""
        if not wid or wid in seen:
            continue

        title = (doc.get("title") or "Untitled").strip()
        names = doc.get("author_name") or []
        author_disp = ", ".join(names) if names else "Unknown author"
        year = doc.get("first_publish_year")
        summary = f"Published book · {year}" if year else "Published book"
        # Surface a few subjects as tags so the card shows what it matched on.
        subjects = doc.get("subject") or []
        tags = [{"t": s, "k": "freeform"} for s in subjects[:4]] or [{"t": "Book", "k": "freeform"}]

        seen.add(wid)
        out.append(
            WorkMeta(
                source="books",
                source_work_id=wid,
                title=title,
                author=author_disp,
                summary=summary,
                tags=tags,
                language=_lang_name(doc.get("language")),
                # A published book is a finished work, not an ongoing serial.
                status="complete",
                url=f"{BASE}/works/{wid}",
            )
        )
        if len(out) >= limit:
            break
    return out
