"""Books discovery source — powered by Goodreads "shelves" (reader tags).

Books discovery is **notify-only**: it finds new books by the reader tags people
actually use and returns basic info + a link. There's no download — a published
book isn't fetchable — so finding/buying/sourcing the file (then uploading it) is
the user's job. The source therefore declares only TAG_SEARCH + WORK_URL.

Why Goodreads instead of Open Library: Goodreads "shelves" ARE the living
reader-tag vocabulary (m-m-romance, enemies-to-lovers, hockey, sports-romance…),
whereas Open Library only has stiff library-catalogue subjects, so reader-style
tags returned nothing. We scrape `/shelf/show/<tag>` — a public HTML book list.

A multi-tag group ANDs by intersecting the books that appear on EVERY include
shelf (falling back to the primary shelf if the intersection is empty, so a
niche combo still surfaces something); excluded tags' books are removed. Request
counts are capped to stay polite.
"""

from __future__ import annotations

import html as _html
import re
import time

import requests

from .base import TAG_SEARCH, WORK_URL, Source, WorkMeta

BASE = "https://www.goodreads.com"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
_TIMEOUT = 25
_MAX_INCLUDE = 3   # cap shelves fetched per group (politeness)
_MAX_EXCLUDE = 2
_DESC_LIMIT = 12   # only fetch a real blurb for the first N results (one request each)
_DESC_PAUSE = 0.4  # polite gap between per-book detail fetches


def _slug(tag: str) -> str:
    """A Goodreads shelf slug: lowercase, non-alphanumerics → single hyphens."""
    return re.sub(r"[^a-z0-9]+", "-", (tag or "").strip().lower()).strip("-")


def parse_description(html_text: str) -> str:
    """Pull a book's blurb from a Goodreads /book/show page.

    The shelf listing carries no synopsis, but the book page exposes it for SEO
    in a social-share meta tag (`og:description`, falling back to the plain
    `description` meta). Pure/regex-based so it's unit-testable without network.
    """
    for prop in ('property="og:description"', 'name="description"'):
        for tag in re.findall(r"<meta\b[^>]*>", html_text or ""):
            if prop in tag:
                cm = re.search(r'content="([^"]*)"', tag)
                if cm and cm.group(1).strip():
                    return _html.unescape(cm.group(1)).strip()
    return ""


def parse_shelf(html_text: str, limit: int = 50) -> list[dict]:
    """Pure parser: a Goodreads shelf page → [{id, title, author, rating}].

    Book entries look like:
      <a class="bookTitle" href="/book/show/59754566-him">Him (Him, #1)</a>
      … <a class="authorName" …><span itemprop="name">Sarina Bowen</span></a>
      … 4.21 avg rating …
    Unit-tested against a fixture; no network here.
    """
    out: list[dict] = []
    seen: set[str] = set()
    for chunk in html_text.split('class="bookTitle"')[1:]:
        m_id = re.search(r'href="/book/show/(\d+)', chunk)
        m_title = re.search(r">\s*([^<]+?)\s*</a>", chunk)
        if not m_id or not m_title:
            continue
        bid = m_id.group(1)
        if bid in seen:
            continue
        seen.add(bid)
        title = _html.unescape(m_title.group(1)).strip()
        m_auth = re.search(r'class="authorName"[^>]*>\s*(?:<span[^>]*>)?([^<]+)', chunk)
        author = _html.unescape(m_auth.group(1)).strip() if m_auth else "Unknown author"
        m_rate = re.search(r"(\d+\.\d+)\s+avg rating", chunk)
        out.append({"id": bid, "title": title or "Untitled", "author": author, "rating": m_rate.group(1) if m_rate else ""})
        if len(out) >= limit:
            break
    return out


class BooksSource(Source):
    id = "books"
    # Notify-only: discovery + a canonical link. No DOWNLOAD (can't fetch a book).
    capabilities = frozenset({TAG_SEARCH, WORK_URL})

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers["User-Agent"] = _UA

    def work_url(self, source_work_id: str) -> str:
        return f"{BASE}/book/show/{source_work_id}"

    def _description(self, bid: str) -> str:
        """Fetch one book page and extract its blurb ("" on any failure)."""
        try:
            resp = self._session.get(f"{BASE}/book/show/{bid}", timeout=_TIMEOUT)
            if resp.status_code != 200:
                return ""
            return parse_description(resp.text)
        except Exception:  # noqa: BLE001 — a flaky fetch shouldn't kill the sync
            return ""

    def _shelf(self, tag: str, limit: int = 50) -> list[dict]:
        slug = _slug(tag)
        if not slug:
            return []
        try:
            resp = self._session.get(f"{BASE}/shelf/show/{slug}", timeout=_TIMEOUT)
            if resp.status_code != 200:
                return []
            return parse_shelf(resp.text, limit=limit)
        except Exception:  # noqa: BLE001 — a flaky fetch shouldn't kill the sync
            return []

    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        return self.search_by_tags([tag], limit=limit)

    def search_by_tags(
        self,
        include: list[str],
        exclude: list[str] | tuple[str, ...] = (),
        limit: int = 25,
    ) -> list[WorkMeta]:
        inc = [t for t in (include or []) if t and t.strip()][:_MAX_INCLUDE]
        if not inc:
            return []
        shelves = [self._shelf(t) for t in inc]
        if not shelves[0]:
            return []

        by_id = {b["id"]: b for s in shelves for b in s}
        # AND: books present on every include shelf.
        ids = set(b["id"] for b in shelves[0])
        for s in shelves[1:]:
            ids &= set(b["id"] for b in s)
        if not ids:  # niche combo with no overlap → fall back to the primary shelf
            ids = set(b["id"] for b in shelves[0])

        # Remove anything that also sits on an excluded shelf.
        for t in (exclude or [])[:_MAX_EXCLUDE]:
            for b in self._shelf(t):
                ids.discard(b["id"])

        # Order by the primary shelf (Goodreads' own popularity order).
        ordered = [b["id"] for b in shelves[0] if b["id"] in ids][:limit]
        # Enrich the first few with a real description (one extra fetch each,
        # capped + spaced); the rest keep a light placeholder.
        metas: list[WorkMeta] = []
        for idx, bid in enumerate(ordered):
            desc = ""
            if idx < _DESC_LIMIT:
                if idx:
                    time.sleep(_DESC_PAUSE)
                desc = self._description(bid)
            metas.append(self._to_meta(by_id[bid], desc))
        return metas

    def _to_meta(self, b: dict, description: str = "") -> WorkMeta:
        rating = f" · {b['rating']}★ avg" if b.get("rating") else ""
        summary = description.strip() if description else f"Book on Goodreads{rating}"
        return WorkMeta(
            source="books",
            source_work_id=b["id"],
            title=b["title"],
            author=b["author"],
            summary=summary,
            tags=[{"t": "Book", "k": "freeform"}],
            status="complete",  # a published book is a finished work
            url=self.work_url(b["id"]),
        )
