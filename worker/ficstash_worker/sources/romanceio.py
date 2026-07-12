"""romance.io discovery source — Books shelf.

romance.io has a private JSON books API that answers a normal server request —
unlike AO3 / Scribble Hub, it does NOT Cloudflare-block datacenter IPs — so its
discovery runs HERE on the worker, like Goodreads. Notify-only: metadata + a link
to romance.io/books/<id>; the user buys the EPUB and uploads it. (The app also
tries romance.io on-device for instant results; both upsert the same tag_matches,
so this is the reliable fallback.)

Endpoint: GET /json/topics/books/<include|all>/<sort>/<offset>/<limit>[/<hide>]
  include / hide = topic SLUGS (each group tag's stored id), percent-encoded and
  comma-joined. Slugs often contain spaces ("grumpy sunshine", "high fantasy").
  A permanent default-exclude list (non-binary-MC topics) is ALWAYS hidden.
"""

from __future__ import annotations

from urllib.parse import quote

import requests

from .base import TAG_SEARCH, WORK_URL, Source, WorkMeta

HOST = "https://www.romance.io"
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36"
_TIMEOUT = 25
_PAGE = 20

# Non-binary-MC topics the user never wants shown — always appended to hide.
# Mirrors ROMANCEIO_DEFAULT_EXCLUDE in app/src/data/romanceioTopics.js.
DEFAULT_EXCLUDE = [
    "100-plus-years-nbi-mc", "60-100-years-nbi-mc", "afab", "agender", "amab",
    "asexual-nbi-mc", "athlete-nbi-mc", "bodyguard-nbi-mc", "career-professional-nbi-mc",
    "chubby-nbi-mc", "cold-nbi-mc", "cruel-nbi-mc", "demi-sexual-nbi-mc", "early-20s-nbi-mc",
    "famous-nbi-mc", "genderfluid", "immortal-nbi-mc", "in-their-30s", "in-their-40s-50s",
    "late-20s-nbi-mc", "m-f-x", "muscular-nbi-mc", "nerdy-nbi-mc", "non-human-nbi-mc",
    "outlaw-nbi-mc", "poor-nbi-mc", "possessive-nbi-mc", "rake-nbi-mc", "rich-nbi-mc",
    "royal-nbi-mc", "short-nbi-mc", "shy-nbi-mc", "single-parent-nbi-mc", "slim-nbi-mc",
    "stalker-nbi-mc", "sunny-nbi-mc", "sweet-nbi-mc", "tall-nbi-mc", "teacher-nbi-mc",
    "teenage-nbi-mc", "tortured-nbi-mc", "transfemme", "transmasc", "virgin-nbi-mc",
    "warrior-nbi-mc", "working-class-nbi-mc",
]


def _enc(slugs) -> str:
    """Dedupe + percent-encode each slug, join with literal commas the API splits on."""
    seen: list[str] = []
    for s in slugs or []:
        s = (s or "").strip()
        if s and s not in seen:
            seen.append(s)
    return ",".join(quote(s, safe="") for s in seen)


def books_url(include, exclude, page: int = 1) -> str:
    inc = _enc(include) or "all"
    hide = _enc(list(exclude or []) + DEFAULT_EXCLUDE)
    offset = max(0, (max(1, page) - 1) * _PAGE)
    path = f"/json/topics/books/{inc}/best/{offset}/{_PAGE}"
    if hide:
        path += f"/{hide}"
    return HOST + path


def parse_books(data) -> list[WorkMeta]:
    """Pure parser: the books API JSON → [WorkMeta] (metadata-only). Unit-testable."""
    out: list[WorkMeta] = []
    for b in (data or {}).get("books") or []:
        bid = str(b.get("_id") or "")
        if not bid:
            continue
        info = b.get("info") or {}
        authors = [a.get("name") for a in (b.get("authors") or []) if a and a.get("name")]
        tags: list[dict] = []
        avg = info.get("avgRating")
        if isinstance(avg, (int, float)):
            tags.append({"t": f"★ {round(avg, 1)}", "k": "freeform"})
        steam = (info.get("steam_rating_description") or "").strip()
        if steam:
            tags.append({"t": steam, "k": "rating"})
        series = b.get("series") or {}
        out.append(WorkMeta(
            source="romanceio",
            source_work_id=bid,
            title=(info.get("title") or "Untitled").strip() or "Untitled",
            author=", ".join(authors) or "Unknown",
            fandom=(series.get("title") or series.get("series") or ""),
            summary=(info.get("description") or "").strip(),
            tags=tags,
            status="complete",
            url=f"{HOST}/books/{bid}",
        ))
    return out


class RomanceIoSource(Source):
    id = "romanceio"
    # Notify-only, like Goodreads: discovery + a canonical link. No DOWNLOAD.
    capabilities = frozenset({TAG_SEARCH, WORK_URL})

    def __init__(self) -> None:
        self._session = requests.Session()
        self._session.headers["User-Agent"] = _UA

    def work_url(self, source_work_id: str) -> str:
        return f"{HOST}/books/{source_work_id}"

    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        return self.search_by_tags([tag], limit=limit)

    def search_by_tags(self, include, exclude=(), limit: int = 25) -> list[WorkMeta]:
        inc = [t for t in (include or []) if t]
        if not inc:
            return []
        try:
            resp = self._session.get(books_url(inc, list(exclude or []), page=1), timeout=_TIMEOUT)
            if resp.status_code != 200:
                return []
            return parse_books(resp.json())[:limit]
        except Exception:  # noqa: BLE001 — a flaky fetch shouldn't kill the sync
            return []
