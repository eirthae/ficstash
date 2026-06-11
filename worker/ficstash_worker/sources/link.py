"""Add-a-work-by-link source — FanFicFare, with a generic article fallback.

The user pastes a story URL in the app (Royal Road, Scribble Hub, FFN,
SpaceBattles, …); the worker downloads a full offline copy here. FanFicFare
already supports hundreds of fiction sites and maps each to chapter HTML, so we
lean on it first. When FanFicFare doesn't recognise the host (e.g. a personal
blog or a news site hosting a single story — armcon.am and the like), we fall
back to a generic readability-style extractor (trafilatura) that pulls the main
article text as a single chapter. So *any* readable URL becomes an offline copy.

Politeness: like the AO3 path, the caller fetches one chapter at a time and
spaces requests itself (the worker's `space()`), so we never hammer a site.
We fetch metadata first (one request), then each chapter on demand.
"""

from __future__ import annotations

import logging
import os
import re
from urllib.parse import urlparse

import fanficfare
import fanficfare.adapters as adapters
from fanficfare import exceptions
from fanficfare.configurable import Configuration

from .base import Chapter, WorkMeta

_DEFAULTS_INI = os.path.join(os.path.dirname(fanficfare.__file__), "defaults.ini")

# FanFicFare is chatty at DEBUG; keep the worker's logs readable.
logging.getLogger("fanficfare").setLevel(logging.WARNING)

_UA = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    )
}

# FanFicFare reports the host (e.g. "www.royalroad.com"); we want a short source
# id that matches the app's source registry where one exists.
_SOURCE_ALIASES = {"archiveofourown": "ao3"}

# Known fiction hosts → their app source id. Matched as a substring of the host
# so a pasted AO3 / Royal Road / Scribble Hub link is ALWAYS classified into the
# right library shelf (AO3 → Fics, the rest → Stories) — never mis-filed under
# Books — regardless of what FanFicFare reports for "site" (full URL, subdomain,
# or empty). This is the primary signal; the registrable-name parse below is a
# fallback for every other host.
_HOST_SOURCES = (
    ("archiveofourown.org", "ao3"),
    ("royalroad.com", "royalroad"),
    ("scribblehub.com", "scribblehub"),
    ("fanfiction.net", "ffn"),
    ("fictionpress.com", "fictionpress"),
)


class UnsupportedSite(Exception):
    """The pasted URL isn't a site FanFicFare can download."""


def _source_from_host(value: str) -> str:
    """Known-fiction-host detection by substring ("" if none match)."""
    h = (value or "").strip().lower()
    for needle, sid in _HOST_SOURCES:
        if needle in h:
            return sid
    return ""


def _source_id(site: str) -> str:
    # Known fiction hosts win outright (robust to odd/empty FanFicFare strings).
    known = _source_from_host(site)
    if known:
        return known
    host = (site or "").strip().lower()
    if host.startswith("www."):
        host = host[4:]
    parts = [p for p in host.split(".") if p]
    if len(parts) >= 2:
        label = parts[-2]  # registrable name: royalroad, scribblehub, fanfiction
    elif parts:
        label = parts[0]
    else:
        label = "link"
    return _SOURCE_ALIASES.get(label, label)


def _resolve_source(site: str, url: str) -> str:
    """Best source id for a link work: known host (from FanFicFare's site OR the
    pasted URL), else the registrable-name parse, else a generic 'link'."""
    return (
        _source_from_host(site)
        or _source_from_host(urlparse(url).netloc)
        or _source_id(site)
        or "link"
    )


def _strip_html(html: str) -> str:
    """Flatten a metadata HTML blob (summary) to plain text for storage."""
    try:
        from fanficfare.htmlcleanup import stripHTML

        return stripHTML(html or "").strip()
    except Exception:  # noqa: BLE001
        import re

        return re.sub(r"<[^>]+>", "", html or "").strip()


class LinkFetcher:
    """Downloads arbitrary story URLs via FanFicFare, one work at a time."""

    def __init__(self) -> None:
        # Reuse one adapter per url between prepare() and fetch_chapter() so the
        # metadata request isn't repeated for every chapter.
        self._adapters: dict[str, object] = {}
        # url -> extracted article HTML, for the generic (non-FanFicFare) path.
        self._generic: dict[str, str] = {}

    def _build_adapter(self, url: str):
        try:
            config = Configuration(adapters.getConfigSectionsFor(url), "html")
        except exceptions.UnknownSite as exc:
            raise UnsupportedSite(str(exc)) from exc
        # Bundled defaults give every adapter sane settings; missing files are
        # silently ignored by ConfigParser.read().
        config.read([_DEFAULTS_INI])
        adapter = adapters.getAdapter(config, url)
        # Public works only — assert adult-content consent so age-gated public
        # pages return their text. (We never log in to third-party sites.)
        adapter.is_adult = True
        return adapter

    def prepare(self, url: str) -> tuple[WorkMeta, list[dict]]:
        """Fetch metadata (one request) and return (WorkMeta, chapter list).

        The chapter list is FanFicFare's [{title,url}, …]; pass each entry's
        index to fetch_chapter(). For a host FanFicFare doesn't know, falls back
        to a generic single-article extraction instead of failing.
        """
        try:
            adapter = self._build_adapter(url)
        except UnsupportedSite:
            return self._prepare_generic(url)
        adapter.getStoryMetadataOnly(get_cover=False)
        story = adapter.story

        def meta(key: str, default: str = "") -> str:
            try:
                return story.getMetadata(key) or default
            except Exception:  # noqa: BLE001
                return default

        def first(key: str) -> str:
            try:
                vals = story.getList(key)
            except Exception:  # noqa: BLE001
                vals = None
            return (vals[0] if vals else "") or ""

        tags: list[dict] = []
        for key, kind in (("ships", "relationship"), ("characters", "character")):
            try:
                for v in story.getList(key) or []:
                    if v:
                        tags.append({"t": v, "k": kind})
            except Exception:  # noqa: BLE001
                pass
        for key in ("genre", "freeformtags", "sitetags", "extratags"):
            try:
                for v in story.getList(key) or []:
                    if v:
                        tags.append({"t": v, "k": "freeform"})
            except Exception:  # noqa: BLE001
                pass

        # numWords arrives comma-formatted ("806,306") on most sites.
        try:
            words = int(str(story.getMetadataRaw("numWords") or "0").replace(",", "").strip() or 0)
        except Exception:  # noqa: BLE001
            words = 0

        status_raw = meta("status").strip().lower()
        status = "complete" if status_raw in ("completed", "complete") else "ongoing"

        updated = None
        try:
            d = story.getMetadataRaw("dateUpdated")
            updated = d.isoformat() if hasattr(d, "isoformat") else (d or None)
        except Exception:  # noqa: BLE001
            updated = None

        chapters = adapter.get_chapters()
        site = meta("site") or ""
        source = _resolve_source(site, url)
        story_id = meta("storyId") or url
        story_url = meta("storyUrl") or url

        wm = WorkMeta(
            source=source,
            source_work_id=str(story_id),
            title=meta("title", "Untitled"),
            author=meta("author"),
            fandom=first("category"),
            pairing=first("ships"),
            summary=_strip_html(meta("description")),
            tags=tags,
            language=meta("language"),
            words=words,
            chapters=len(chapters),
            chapters_total=len(chapters) if status == "complete" else None,
            status=status,
            updated=updated,
            url=story_url,
        )
        self._adapters[url] = adapter
        return wm, chapters

    def fetch_chapter(self, url: str, index: int, chapter: dict) -> Chapter:
        """Fetch one chapter's HTML body (one request). `index` is 0-based."""
        title = (chapter.get("title") if isinstance(chapter, dict) else "") or ""
        # Generic single-article works keep their body from prepare().
        if url in self._generic:
            return Chapter(n=index + 1, title=title, words=0, html=self._generic[url])
        if url not in self._adapters and url not in self._generic:
            self.prepare(url)  # rebuild metadata + cache the adapter/body
            if url in self._generic:
                return Chapter(n=index + 1, title=title, words=0, html=self._generic[url])
        adapter = self._adapters[url]
        chap_url = chapter.get("url") if isinstance(chapter, dict) else None
        html = adapter.getChapterTextNum(chap_url, index) if chap_url else ""
        return Chapter(n=index + 1, title=title, words=0, html=html or "")

    # ---- generic article fallback (non-FanFicFare hosts) -------------------
    def _prepare_generic(self, url: str) -> tuple[WorkMeta, list[dict]]:
        """Extract the main article from an arbitrary page as a one-chapter work.

        Uses trafilatura (readability-style) which copes with non-Latin scripts
        like Armenian. Raises UnsupportedSite if no article text can be pulled.
        """
        try:
            import trafilatura
        except Exception as exc:  # noqa: BLE001
            raise UnsupportedSite("generic extractor unavailable") from exc

        downloaded = None
        try:
            downloaded = trafilatura.fetch_url(url)
        except Exception:  # noqa: BLE001
            downloaded = None
        if not downloaded:
            try:
                import requests

                resp = requests.get(url, headers=_UA, timeout=30)
                resp.raise_for_status()
                downloaded = resp.text
            except Exception as exc:  # noqa: BLE001
                raise UnsupportedSite(f"could not fetch {url}") from exc

        body = trafilatura.extract(
            downloaded, output_format="html", include_comments=False,
            include_images=False, favor_recall=True,
        )
        if not body or not body.strip():
            raise UnsupportedSite(f"no article text found at {url}")

        text = trafilatura.extract(downloaded) or ""
        md = None
        try:
            md = trafilatura.extract_metadata(downloaded)
        except Exception:  # noqa: BLE001
            md = None
        title = (getattr(md, "title", "") or "") or _html_title(downloaded) or url
        author = getattr(md, "author", "") or ""
        date = getattr(md, "date", "") or None
        host = urlparse(url).netloc
        wm = WorkMeta(
            source=_resolve_source(host, url),
            source_work_id=url,
            title=title.strip()[:300] or "Untitled",
            author=(author or "").strip(),
            summary=(text.strip()[:280] + ("…" if len(text) > 280 else "")),
            tags=[{"t": "Web", "k": "freeform"}],
            language=_detect_language(text),
            words=len(text.split()),
            chapters=1,
            chapters_total=1,
            status="complete",
            updated=date,
            url=url,
        )
        self._generic[url] = body
        return wm, [{"title": title.strip()[:300] or "Untitled", "url": url}]


def _html_title(html: str) -> str:
    m = re.search(r"<title[^>]*>(.*?)</title>", html or "", re.I | re.S)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def _detect_language(text: str) -> str:
    """Best-effort native-script language name from the dominant script."""
    if not text:
        return ""
    sample = text[:2000]
    counts = {
        "Հայերեն": sum(1 for c in sample if "԰" <= c <= "֏"),  # Armenian
        "Русский": sum(1 for c in sample if "Ѐ" <= c <= "ӿ"),  # Cyrillic
        "日本語": sum(1 for c in sample if "぀" <= c <= "ヿ" or "一" <= c <= "鿿"),
        "한국어": sum(1 for c in sample if "가" <= c <= "힣"),
    }
    top = max(counts, key=counts.get)
    return top if counts[top] >= 12 else "English"
