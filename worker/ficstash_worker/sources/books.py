"""Books source — published-book release watcher via Open Library (Phase F).

Unlike the fiction sources, this one is *notify-only*. FicStash can't download a
commercial ebook, so a "Books" tracker watches an author and surfaces their new
releases in the swipe feed; when the user buys the EPUB they add it through the
upload path (Phase B). So this source declares only TAG_SEARCH (the discovery
engine, keyed on an author name rather than a genre) + WORK_URL (a canonical
Open Library link). It deliberately does NOT declare DOWNLOAD/FOLLOW, so the
registry never asks it to fetch chapter bodies and the app hides the Save button.

Why Open Library and not Google Books:

  * Google Books' volumes API works without a key but is aggressively rate-limited
    per-IP (it returned HTTP 429 from a normal residential IP during testing).
  * Open Library's search.json is free, keyless and lenient — it returned 212
    newest-first results for "Brandon Sanderson" with no throttling — and exposes
    exactly what we need: work key, title, author names, language, publish year.

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
_FIELDS = "key,title,author_name,first_publish_year,language,edition_count"

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


class BooksSource(Source):
    id = "books"
    # Discovery (by author) + a canonical link. Notify-only: NO download/follow,
    # so the app hides the Save button and the user uploads the bought EPUB.
    capabilities = frozenset({TAG_SEARCH, WORK_URL})

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers.update(_HEADERS)

    def work_url(self, source_work_id: str) -> str:
        # source_work_id is the Open Library work key without the "/works/"
        # prefix, e.g. "OL45153903W".
        return f"{BASE}/works/{source_work_id}"

    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        """Find an author's most recent books (metadata only).

        `tag` is an author name (the Books tracker stores authors, not genres).
        Sorted newest-first so a sync surfaces fresh releases at the top.
        """
        author = (tag or "").strip()
        if not author:
            return []
        url = (
            f"{BASE}/search.json"
            f"?author={quote_plus(author)}"
            f"&sort=new&limit={int(limit)}&fields={_FIELDS}"
        )
        resp = self._session.get(url, timeout=_TIMEOUT)
        resp.raise_for_status()
        data = json.loads(resp.text)
        return _parse_docs(data.get("docs", []), author=author, limit=limit)


def _parse_docs(docs: list, author: str, limit: int) -> list[WorkMeta]:
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
        author_disp = ", ".join(names) if names else author
        year = doc.get("first_publish_year")
        summary = f"Published book · {year}" if year else "Published book"

        seen.add(wid)
        out.append(
            WorkMeta(
                source="books",
                source_work_id=wid,
                title=title,
                author=author_disp,
                summary=summary,
                tags=[{"t": "Book", "k": "freeform"}],
                language=_lang_name(doc.get("language")),
                # A published book is a finished work, not an ongoing serial.
                status="complete",
                url=f"{BASE}/works/{wid}",
            )
        )
        if len(out) >= limit:
            break
    return out
