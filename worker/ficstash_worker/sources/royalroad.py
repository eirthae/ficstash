"""Royal Road source — tag/genre discovery (Phase C).

Royal Road is a free original-fiction site with a rich tag/genre taxonomy. This
source implements *discovery only*: it queries Royal Road's public fiction
search for works carrying a tracked tag and returns lightweight metadata for the
swipe feed. It deliberately does NOT implement DOWNLOAD — when the user Saves a
Royal Road match, the worker downloads the full offline copy through the
existing FanFicFare link path (sources/link.py), which already handles Royal
Road. So this source declares TAG_SEARCH + GENRE_LIST + WORK_URL and nothing
else; the registry never asks it to fetch chapter bodies.

Politeness mirrors the rest of the worker: the caller spaces requests itself
(the worker's `space()`), so discovery never hammers the site. Royal Road is not
as aggressively bot-gated as some sites, but datacenter IPs (GitHub Actions) can
still draw an occasional 403 — those surface as a normal exception the caller's
backoff handles, and a skipped run just means matches arrive on the next sync.
"""

from __future__ import annotations

import re

import requests
from bs4 import BeautifulSoup

from .base import GENRE_LIST, TAG_SEARCH, WORK_URL, Source, WorkMeta

BASE = "https://www.royalroad.com"
# A normal desktop UA — Royal Road serves the same public HTML either way, but a
# blank/python UA is more likely to be challenged.
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
}
_TIMEOUT = 20

# Royal Road's fiction tags, shown in the app's tracker so users pick from the
# real taxonomy. `slug` is what the search endpoint expects; `name` is the label.
# Kept here as the source of truth; the app mirrors it in its sources registry.
GENRES: list[dict] = [
    {"name": "Action", "slug": "action"},
    {"name": "Adventure", "slug": "adventure"},
    {"name": "Comedy", "slug": "comedy"},
    {"name": "Contemporary", "slug": "contemporary"},
    {"name": "Drama", "slug": "drama"},
    {"name": "Fantasy", "slug": "fantasy"},
    {"name": "Historical", "slug": "historical"},
    {"name": "Horror", "slug": "horror"},
    {"name": "Mystery", "slug": "mystery"},
    {"name": "Psychological", "slug": "psychological"},
    {"name": "Romance", "slug": "romance"},
    {"name": "Satire", "slug": "satire"},
    {"name": "Sci-fi", "slug": "sci_fi"},
    {"name": "Tragedy", "slug": "tragedy"},
    {"name": "Anti-Hero Lead", "slug": "anti-hero_lead"},
    {"name": "Artificial Intelligence", "slug": "artificial_intelligence"},
    {"name": "Cyberpunk", "slug": "cyberpunk"},
    {"name": "Dungeon", "slug": "dungeon"},
    {"name": "Dystopia", "slug": "dystopia"},
    {"name": "Female Lead", "slug": "female_lead"},
    {"name": "GameLit", "slug": "gamelit"},
    {"name": "Grimdark", "slug": "grimdark"},
    {"name": "Harem", "slug": "harem"},
    {"name": "High Fantasy", "slug": "high_fantasy"},
    {"name": "LitRPG", "slug": "litrpg"},
    {"name": "Low Fantasy", "slug": "low_fantasy"},
    {"name": "Magic", "slug": "magic"},
    {"name": "Male Lead", "slug": "male_lead"},
    {"name": "Martial Arts", "slug": "martial_arts"},
    {"name": "Mythos", "slug": "mythos"},
    {"name": "Non-Human Lead", "slug": "non-human_lead"},
    {"name": "Portal Fantasy / Isekai", "slug": "summoned_hero"},
    {"name": "Post Apocalyptic", "slug": "post_apocalyptic"},
    {"name": "Progression", "slug": "progression"},
    {"name": "Reincarnation", "slug": "reincarnation"},
    {"name": "School Life", "slug": "school_life"},
    {"name": "Slice of Life", "slug": "slice_of_life"},
    {"name": "Space Opera", "slug": "space_opera"},
    {"name": "Sports", "slug": "sports"},
    {"name": "Steampunk", "slug": "steampunk"},
    {"name": "Strategy", "slug": "strategy"},
    {"name": "Strong Lead", "slug": "strong_lead"},
    {"name": "Super Heroes", "slug": "super_heroes"},
    {"name": "Supernatural", "slug": "supernatural"},
    {"name": "Time Loop", "slug": "loop"},
    {"name": "Time Travel", "slug": "time_travel"},
    {"name": "Urban Fantasy", "slug": "urban_fantasy"},
    {"name": "Villainous Lead", "slug": "villainous_lead"},
    {"name": "Virtual Reality", "slug": "virtual_reality"},
    {"name": "War and Military", "slug": "war_and_military"},
    {"name": "Wuxia", "slug": "wuxia"},
    {"name": "Xianxia", "slug": "xianxia"},
]
_SLUG_BY_NAME = {g["name"].lower(): g["slug"] for g in GENRES}


def _slugify(tag: str) -> str:
    """Map a tag label to a Royal Road search slug.

    Prefers the known-genre table (so "Sci-fi" → "sci_fi"); otherwise falls back
    to a best-effort slug (lowercase, spaces → underscores) which still works for
    most single-word tags.
    """
    t = (tag or "").strip()
    if not t:
        return ""
    known = _SLUG_BY_NAME.get(t.lower())
    if known:
        return known
    return re.sub(r"\s+", "_", t.lower())


class RoyalRoadSource(Source):
    id = "royalroad"
    # Discovery + a canonical link. NOT download: saved RR works are fetched via
    # the FanFicFare link path, which already supports Royal Road.
    capabilities = frozenset({TAG_SEARCH, GENRE_LIST, WORK_URL})

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers.update(_HEADERS)

    def work_url(self, source_work_id: str) -> str:
        # The bare /fiction/<id> form 302-redirects to the full slug URL; both
        # the browser and FanFicFare follow it.
        return f"{BASE}/fiction/{source_work_id}"

    def genres(self) -> list[dict]:
        return list(GENRES)

    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        """Find recent Royal Road works carrying a single tag (metadata only)."""
        return self.search_by_tags([tag], limit=limit)

    def search_by_tags(
        self,
        include: list[str],
        exclude: list[str] | tuple[str, ...] = (),
        limit: int = 25,
    ) -> list[WorkMeta]:
        """Find recent Royal Road works carrying ALL `include` tags and NONE of
        `exclude` (metadata only).

        Royal Road's fiction search ANDs repeated `tagsAdd` params and subtracts
        `tagsRemove` params natively — exactly the semantics a tracked group
        wants ("Male Lead" + "Magic" = works tagged both). Tags may be display
        labels ("Sci-fi") or slugs ("sci_fi"); both normalise. Results are
        ordered most-recently-updated first.
        """
        add = [s for s in (_slugify(t) for t in include) if s]
        remove = [s for s in (_slugify(t) for t in exclude) if s]
        if not add:
            return []
        # requests serialises a list of (key, value) pairs into repeated query
        # params, which is how Royal Road expects multiple tags.
        params: list[tuple[str, str]] = [("tagsAdd", s) for s in add]
        params += [("tagsRemove", s) for s in remove]
        params += [("orderBy", "last_update"), ("dir", "desc")]
        resp = self._session.get(
            f"{BASE}/fictions/search", params=params, timeout=_TIMEOUT
        )
        resp.raise_for_status()
        return _parse_search(resp.text, limit=limit)


# ---- HTML parsing (defensive — Royal Road markup shifts over time) ----------
_FICTION_ID_RE = re.compile(r"/fiction/(\d+)")


def _parse_search(html_text: str, limit: int) -> list[WorkMeta]:
    soup = BeautifulSoup(html_text, "html.parser")
    out: list[WorkMeta] = []
    seen: set[str] = set()

    items = soup.select("div.fiction-list-item") or soup.select(".fiction-list-item")
    for item in items:
        link = item.select_one('h2.fiction-title a') or item.select_one(
            'a[href^="/fiction/"]'
        )
        if link is None:
            continue
        href = link.get("href") or ""
        m = _FICTION_ID_RE.search(href)
        if not m:
            continue
        wid = m.group(1)
        if wid in seen:
            continue

        title = link.get_text(strip=True)

        # Description block. Royal Road uses a couple of class shapes over time.
        desc_el = (
            item.select_one("div.fiction-description")
            or item.select_one("div.margin-top-10.col-xs-12")
            or item.select_one("div.description")
        )
        summary = desc_el.get_text(" ", strip=True) if desc_el else ""

        tags: list[dict] = []
        for a in item.select("a.fiction-tag, a.label[href*='tagsAdd'], span.tags a"):
            name = a.get_text(strip=True)
            if name:
                tags.append({"t": name, "k": "freeform"})

        seen.add(wid)
        out.append(
            WorkMeta(
                source="royalroad",
                source_work_id=wid,
                title=title or "Untitled",
                author="",  # not shown on the listing; filled on save via FanFicFare
                summary=summary,
                tags=tags,
                language="English",
                url=f"{BASE}/fiction/{wid}",
            )
        )
        if len(out) >= limit:
            break
    return out
