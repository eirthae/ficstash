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

# Scribble Hub's internal numeric genre ids (the `gmeid` on each Series Finder
# checkbox). The Series Finder is the only surface that ANDs multiple genres and
# subtracts excludes, and it keys on these ids — not slugs. Derived once from
# /series-finder/; keyed by lowercase genre name.
_GENRE_ID_BY_NAME: dict[str, int] = {
    "action": 9, "adult": 902, "adventure": 8, "boys love": 891, "comedy": 7,
    "drama": 903, "ecchi": 904, "fanfiction": 38, "fantasy": 19,
    "gender bender": 905, "girls love": 892, "harem": 1015, "historical": 21,
    "horror": 22, "isekai": 37, "josei": 906, "litrpg": 1180,
    "martial arts": 907, "mature": 20, "mecha": 908, "mystery": 909,
    "psychological": 910, "romance": 6, "school life": 911, "sci-fi": 912,
    "seinen": 913, "slice of life": 914, "smut": 915, "sports": 916,
    "supernatural": 5, "tragedy": 901,
}
# Also resolve by slug, so a stored tag id like "sci-fi" or "gender-bender" maps.
_GENRE_ID_BY_SLUG = {
    re.sub(r"[^a-z0-9]+", "-", name).strip("-"): gid
    for name, gid in _GENRE_ID_BY_NAME.items()
}


def _genre_id(tag: str) -> int | None:
    """Resolve a genre label or slug to its Scribble Hub numeric id."""
    t = (tag or "").strip().lower()
    if not t:
        return None
    return _GENRE_ID_BY_NAME.get(t) or _GENRE_ID_BY_SLUG.get(
        re.sub(r"[^a-z0-9]+", "-", t).strip("-")
    )


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
        """Find recently-updated Scribble Hub works in a single genre."""
        return self.search_by_tags([tag], limit=limit)

    def search_by_tags(
        self,
        include: list[str],
        exclude: list[str] | tuple[str, ...] = (),
        limit: int = 25,
    ) -> list[WorkMeta]:
        """Find recent Scribble Hub works in ALL `include` genres and NONE of
        `exclude` (metadata only).

        Uses the Series Finder, the only Scribble Hub surface that ANDs multiple
        genres (mgi=and) and subtracts excludes (ge=), sorted by last chapter
        update so a sync surfaces fresh works first. The per-item RSS feed can't
        AND, so a single known genre also goes through the finder; an unknown
        single tag (not in the genre-id map) falls back to that genre's RSS feed.
        Genres may be labels ("Sci-fi") or slugs ("sci-fi"); both resolve.
        """
        inc_terms = [t for t in include if t]
        inc_ids = [gid for gid in (_genre_id(t) for t in inc_terms) if gid]
        exc_ids = [gid for gid in (_genre_id(t) for t in exclude or []) if gid]

        # Every include genre resolved → native AND via the Series Finder.
        if inc_ids and len(inc_ids) == len(inc_terms):
            params = {
                "sf": "1",
                "gi": ",".join(str(i) for i in inc_ids),
                "mgi": "and",
                "sort": "lastchpdate",
                "order": "desc",
            }
            if exc_ids:
                params["ge"] = ",".join(str(i) for i in exc_ids)
            resp = self._session.get(
                f"{BASE}/series-finder/", params=params, timeout=_TIMEOUT
            )
            resp.raise_for_status()
            return _parse_finder(resp.text, limit=limit)

        # Single unknown tag → that genre's RSS feed (newest-first).
        if len(inc_terms) == 1:
            slug = _slugify(inc_terms[0])
            if not slug:
                return []
            resp = self._session.get(f"{BASE}/genre/{slug}/feed/", timeout=_TIMEOUT)
            resp.raise_for_status()
            return _parse_feed(resp.text, limit=limit)

        # Multi-tag group with some unmapped genres → AND only the ones we can
        # resolve via the finder (dropping the unknowns rather than returning 0).
        if inc_ids:
            params = {
                "sf": "1",
                "gi": ",".join(str(i) for i in inc_ids),
                "mgi": "and",
                "sort": "lastchpdate",
                "order": "desc",
            }
            if exc_ids:
                params["ge"] = ",".join(str(i) for i in exc_ids)
            resp = self._session.get(
                f"{BASE}/series-finder/", params=params, timeout=_TIMEOUT
            )
            resp.raise_for_status()
            return _parse_finder(resp.text, limit=limit)
        return []


# ---- Series Finder HTML parsing (multi-genre AND results) -------------------
_FINDER_ITEM_RE = re.compile(r'<div class="search_body">.*?(?=<div class="search_body">|$)', re.S)
_FINDER_LINK_RE = re.compile(
    r'<div class="search_title">.*?<a href="https://www\.scribblehub\.com/series/(\d+)/[^"]*">(.*?)</a>',
    re.S,
)


def _parse_finder(html_text: str, limit: int) -> list[WorkMeta]:
    """Parse Series Finder result cards into WorkMeta (id + title + genres).

    The listing carries no author/summary (FanFicFare fills those on save), but
    each card lists its genre links, which we surface as tags.
    """
    out: list[WorkMeta] = []
    seen: set[str] = set()
    for block in _FINDER_ITEM_RE.findall(html_text):
        m = _FINDER_LINK_RE.search(block)
        if not m:
            continue
        wid, title = m.group(1), _html.unescape(_strip_html(m.group(2))) or "Untitled"
        if wid in seen:
            continue
        seen.add(wid)
        tags: list[dict] = []
        gblock = re.search(r'<div class="search_genre">(.*?)</div>', block, re.S)
        if gblock:
            for name in re.findall(r"<a[^>]*>([^<]+)</a>", gblock.group(1)):
                nm = _html.unescape(name).strip()
                if nm:
                    tags.append({"t": nm, "k": "freeform"})
        out.append(
            WorkMeta(
                source="scribblehub",
                source_work_id=wid,
                title=title,
                author="",  # filled on save via FanFicFare
                summary="",
                tags=tags,
                language="English",
                url=f"{BASE}/series/{wid}/",
            )
        )
        if len(out) >= limit:
            break
    return out


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
