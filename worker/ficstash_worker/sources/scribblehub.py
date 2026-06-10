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
import time

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
_DESC_LIMIT = 12   # only fetch a real blurb for the first N finder results
_DESC_PAUSE = 0.4  # polite gap between per-series detail fetches


def parse_description(html_text: str) -> str:
    """A Scribble Hub series blurb from its /series page.

    The Series Finder cards carry no synopsis, but each series page exposes one
    for SEO in the `og:description` social-share meta tag. Pure/regex-based so it
    unit-tests without network.
    """
    for tag in re.findall(r"<meta\b[^>]*>", html_text or ""):
        if 'property="og:description"' in tag:
            cm = re.search(r'content="([^"]*)"', tag)
            if cm and cm.group(1).strip():
                return _html.unescape(cm.group(1)).strip()
    return ""

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
        # slug -> numeric tag id, resolved lazily (see _tag_id) and cached for the
        # life of the run so a sync resolves each tracked tag at most once.
        self._tag_ids: dict[str, int | None] = {}

    def _tag_id(self, slug: str) -> int | None:
        """Resolve a tag slug to Scribble Hub's numeric tag id.

        The Series Finder filters tags by numeric id (tgi/tge), but those ids
        aren't listed anywhere bulk. A tag's own archive page carries it in the
        WordPress body class (`term-<id>`), so we fetch it once per slug and
        cache. Returns None if the tag/page can't be resolved.
        """
        slug = (slug or "").strip().lower()
        if not slug:
            return None
        if slug in self._tag_ids:
            return self._tag_ids[slug]
        tid: int | None = None
        try:
            resp = self._session.get(f"{BASE}/tag/{slug}/", timeout=_TIMEOUT)
            if resp.ok:
                m = re.search(r"\bterm-(\d+)\b", resp.text)
                if m:
                    tid = int(m.group(1))
        except requests.RequestException:
            tid = None
        self._tag_ids[slug] = tid
        return tid

    def work_url(self, source_work_id: str) -> str:
        # The bare /series/<id>/ form redirects to the full slug URL; both the
        # browser and FanFicFare follow it.
        return f"{BASE}/series/{source_work_id}/"

    def genres(self) -> list[dict]:
        return list(GENRES)

    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        """Find recently-updated Scribble Hub works in a single genre."""
        return self.search_by_tags([tag], limit=limit)

    def _classify(self, terms) -> tuple[list[int], list[int]]:
        """Split terms into (genre ids, tag ids). A term that resolves to a known
        genre is a genre (gi/ge); anything else is treated as a tag (tgi/tge) and
        its slug resolved to a numeric id lazily."""
        genre_ids: list[int] = []
        tag_ids: list[int] = []
        for t in terms or []:
            if not t:
                continue
            gid = _genre_id(t)
            if gid:
                genre_ids.append(gid)
                continue
            tid = self._tag_id(_slugify(t))
            if tid:
                tag_ids.append(tid)
        return genre_ids, tag_ids

    def search_by_tags(
        self,
        include: list[str],
        exclude: list[str] | tuple[str, ...] = (),
        limit: int = 25,
    ) -> list[WorkMeta]:
        """Find recent Scribble Hub works matching ALL `include` genres/tags and
        NONE of `exclude` (metadata only).

        Uses the Series Finder — the only Scribble Hub surface that ANDs multiple
        genres (gi + mgi=and) AND tags (tgi + tgi_mm=and) and subtracts excluded
        genres (ge) and tags (tge), sorted by last chapter update. Each term is
        classified: known genres → genre ids; everything else → a tag whose slug
        is resolved to a numeric id. A single bare genre with nothing else falls
        back to that genre's RSS feed (lighter, same newest-first ordering).
        """
        inc_terms = [t for t in include if t]
        if not inc_terms:
            return []

        # Fast path: exactly one genre, no tags, no excludes → genre RSS feed.
        if (
            len(inc_terms) == 1
            and not exclude
            and _genre_id(inc_terms[0])
        ):
            slug = _slugify(inc_terms[0])
            resp = self._session.get(f"{BASE}/genre/{slug}/feed/", timeout=_TIMEOUT)
            resp.raise_for_status()
            return _parse_feed(resp.text, limit=limit)

        gi, tgi = self._classify(inc_terms)
        ge, tge = self._classify(exclude)
        if not gi and not tgi:
            return []

        params = {"sf": "1", "sort": "lastchpdate", "order": "desc"}
        if gi:
            params["gi"] = ",".join(str(i) for i in gi)
            params["mgi"] = "and"
        if tgi:
            params["tgi"] = ",".join(str(i) for i in tgi)
            params["tgi_mm"] = "and"
        if ge:
            params["ge"] = ",".join(str(i) for i in ge)
        if tge:
            params["tge"] = ",".join(str(i) for i in tge)
        resp = self._session.get(
            f"{BASE}/series-finder/", params=params, timeout=_TIMEOUT
        )
        resp.raise_for_status()
        return self._enrich_descriptions(_parse_finder(resp.text, limit=limit))

    def _description(self, wid: str) -> str:
        """Fetch one series page and extract its blurb ("" on any failure)."""
        try:
            resp = self._session.get(f"{BASE}/series/{wid}/", timeout=_TIMEOUT)
            if resp.status_code != 200:
                return ""
            return parse_description(resp.text)
        except Exception:  # noqa: BLE001 — a flaky fetch shouldn't kill the sync
            return ""

    def _enrich_descriptions(self, metas: list[WorkMeta]) -> list[WorkMeta]:
        """Fill in a real synopsis for the first few finder results (one extra
        fetch each, capped + spaced). Finder cards carry no summary, so without
        this the discovery feed shows blank blurbs."""
        fetched = 0
        for m in metas:
            if fetched >= _DESC_LIMIT:
                break
            if getattr(m, "summary", ""):
                continue
            if fetched:
                time.sleep(_DESC_PAUSE)
            desc = self._description(m.source_work_id)
            fetched += 1
            if desc:
                m.summary = desc
        return metas


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
