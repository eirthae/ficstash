"""Scribble Hub source — genre discovery (Phase D).

Scribble Hub is a free original-fiction site. Like Royal Road, this source does
*discovery only*: it surfaces recent works in a tracked genre for the swipe feed
and leaves downloading to the existing FanFicFare link path (sources/link.py),
which already supports scribblehub.com. So it declares TAG_SEARCH + GENRE_LIST +
WORK_URL and nothing else; the registry never asks it to fetch chapter bodies.

Discovery surface — chosen after a CI-reachability spike (see the throwaway
spike_scribblehub.py / spike workflow used to derive all of this):

  * Scribble Hub serves its public HTML to GitHub Actions (datacenter) IPs; the
    Cloudflare "/cdn-cgi/challenge-platform/" beacon is present on normal pages
    but there's no actual interstitial, so a plain requests GET works.
  * Each genre has an RSS feed at /genre/<slug>/feed/ that lists the ~10 most
    recently-updated works newest-first — lightweight and stable, far better for
    "what's new in this genre" than scraping the popularity-ordered HTML listing.
  * Genre slugs are the lowercase, hyphenated genre name (verified against the
    site's own /genre/<slug>/ links, e.g. "Sci-fi" -> "sci-fi",
    "School Life" -> "school-life").

Politeness mirrors the rest of the worker: the caller spaces requests itself
(the worker's `space()`), so discovery never hammers the site. A datacenter IP
can still draw an occasional Cloudflare 403 — that surfaces as a normal exception
the caller's backoff handles, and a skipped run just means matches arrive next sync.
"""

from __future__ import annotations

import html as _html
import re

import requests

from .base import GENRE_LIST, TAG_SEARCH, WORK_URL, Source, WorkMeta

BASE = "https://www.scribblehub.com"
# A normal desktop UA — Scribble Hub serves the same public HTML either way, but
# a blank/python UA is more likely to be challenged.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
_TIMEOUT = 25

# Scribble Hub's genres, shown in the app's tracker so users pick from the real
# taxonomy. `slug` is what /genre/<slug>/feed/ expects; `name` is the label.
# Verified against the site's own genre links. Kept here as the source of truth;
# the app mirrors it in its sources registry.
GENRES: list[dict] = [
    {"name": "Action", "slug": "action"},
    {"name": "Adventure", "slug": "adventure"},
    {"name": "Comedy", "slug": "comedy"},
    {"name": "Drama", "slug": "drama"},
    {"name": "Fantasy", "slug": "fantasy"},
    {"name": "Gender Bender", "slug": "gender-bender"},
    {"name": "Harem", "slug": "harem"},
    {"name": "Historical", "slug": "historical"},
    {"name": "Horror", "slug": "horror"},
    {"name": "Isekai", "slug": "isekai"},
    {"name": "Josei", "slug": "josei"},
    {"name": "LitRPG", "slug": "litrpg"},
    {"name": "Martial Arts", "slug": "martial-arts"},
    {"name": "Mature", "slug": "mature"},
    {"name": "Mecha", "slug": "mecha"},
    {"name": "Mystery", "slug": "mystery"},
    {"name": "Psychological", "slug": "psychological"},
    {"name": "Romance", "slug": "romance"},
    {"name": "School Life", "slug": "school-life"},
    {"name": "Sci-fi", "slug": "sci-fi"},
    {"name": "Seinen", "slug": "seinen"},
    {"name": "Slice of Life", "slug": "slice-of-life"},
    {"name": "Sports", "slug": "sports"},
    {"name": "Supernatural", "slug": "supernatural"},
    {"name": "Tragedy", "slug": "tragedy"},
]
_SLUG_BY_NAME = {g["name"].lower(): g["slug"] for g in GENRES}


def _slugify(tag: str) -> str:
    """Map a tag label to a Scribble Hub genre slug.

    Prefers the known-genre table (so "Sci-fi" -> "sci-fi"); otherwise falls back
    to a best-effort slug (lowercase, runs of non-alphanumerics -> a single
    hyphen) which matches Scribble Hub's own slug convention for most genres.
    """
    t = (tag or "").strip()
    if not t:
        return ""
    known = _SLUG_BY_NAME.get(t.lower())
    if known:
        return known
    return re.sub(r"[^a-z0-9]+", "-", t.lower()).strip("-")


class ScribbleHubSource(Source):
    id = "scribblehub"
    # Discovery + a canonical link. NOT download: saved SH works are fetched via
    # the FanFicFare link path, which already supports scribblehub.com.
    capabilities = frozenset({TAG_SEARCH, GENRE_LIST, WORK_URL})

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers.update(_HEADERS)

    def work_url(self, source_work_id: str) -> str:
        # The bare /series/<id>/ form redirects to the full slug URL; both the
        # browser and FanFicFare follow it.
        return f"{BASE}/series/{source_work_id}/"

    def genres(self) -> list[dict]:
        return list(GENRES)

    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        """Find recently-updated Scribble Hub works in a genre (metadata only).

        `tag` may be a display label ("Sci-fi") or a slug ("sci-fi"); both are
        normalised. The genre RSS feed is newest-first, so a sync surfaces fresh
        works at the top.
        """
        slug = _slugify(tag)
        if not slug:
            return []
        resp = self._session.get(
            f"{BASE}/genre/{slug}/feed/", timeout=_TIMEOUT
        )
        resp.raise_for_status()
        return _parse_feed(resp.text, limit=limit)


# ---- RSS parsing (the feed is small, well-formed XML) -----------------------
_ITEM_RE = re.compile(r"<item\b.*?</item>", re.I | re.S)
_SERIES_ID_RE = re.compile(r"/series/(\d+)/")


def _tag_text(item: str, name: str) -> str:
    """Inner text of <name>…</name>, CDATA-unwrapped and entity-decoded."""
    m = re.search(rf"<{name}[^>]*>(.*?)</{name}>", item, re.I | re.S)
    if not m:
        return ""
    val = m.group(1).strip()
    cdata = re.match(r"<!\[CDATA\[(.*?)\]\]>", val, re.S)
    if cdata:
        val = cdata.group(1).strip()
    return _html.unescape(val).strip()


def _strip_html(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text or "")).strip()


def _parse_feed(xml_text: str, limit: int) -> list[WorkMeta]:
    out: list[WorkMeta] = []
    seen: set[str] = set()

    for raw in _ITEM_RE.findall(xml_text):
        link = _tag_text(raw, "link") or _tag_text(raw, "guid")
        m = _SERIES_ID_RE.search(link)
        if not m:
            continue
        wid = m.group(1)
        if wid in seen:
            continue

        title = _tag_text(raw, "title") or "Untitled"
        author = _tag_text(raw, "dc:creator") or _tag_text(raw, "creator")
        summary = _strip_html(_tag_text(raw, "description"))

        # The feed carries no per-work tags; FanFicFare fills proper metadata if
        # the user saves the work. Surface the genre categories when present.
        tags: list[dict] = []
        for cat in re.findall(r"<category[^>]*>(.*?)</category>", raw, re.I | re.S):
            name = _strip_html(cat)
            if name:
                tags.append({"t": name, "k": "freeform"})

        seen.add(wid)
        out.append(
            WorkMeta(
                source="scribblehub",
                source_work_id=wid,
                title=title,
                author=author,
                summary=summary,
                tags=tags,
                language="English",
                url=f"{BASE}/series/{wid}/",
            )
        )
        if len(out) >= limit:
            break
    return out
