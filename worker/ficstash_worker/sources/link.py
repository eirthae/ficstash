"""Add-a-work-by-link source — powered by FanFicFare.

The user pastes a story URL in the app (Royal Road, Scribble Hub, FFN,
SpaceBattles, …); the worker downloads a full offline copy here. FanFicFare
already supports hundreds of sites and maps each to chapter HTML, so we lean on
it instead of writing a scraper per site.

Politeness: like the AO3 path, the caller fetches one chapter at a time and
spaces requests itself (the worker's `space()`), so we never hammer a site.
We fetch metadata first (one request), then each chapter on demand.
"""

from __future__ import annotations

import logging
import os

import fanficfare
import fanficfare.adapters as adapters
from fanficfare import exceptions
from fanficfare.configurable import Configuration

from .base import Chapter, WorkMeta

_DEFAULTS_INI = os.path.join(os.path.dirname(fanficfare.__file__), "defaults.ini")

# FanFicFare is chatty at DEBUG; keep the worker's logs readable.
logging.getLogger("fanficfare").setLevel(logging.WARNING)

# FanFicFare reports the host (e.g. "www.royalroad.com"); we want a short source
# id that matches the app's source registry where one exists.
_SOURCE_ALIASES = {"archiveofourown": "ao3"}


class UnsupportedSite(Exception):
    """The pasted URL isn't a site FanFicFare can download."""


def _source_id(site: str) -> str:
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
        index to fetch_chapter(). Raises UnsupportedSite for unknown URLs.
        """
        adapter = self._build_adapter(url)
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
        source = _source_id(site)
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
        adapter = self._adapters.get(url)
        if adapter is None:
            self.prepare(url)  # rebuild metadata + cache the adapter
            adapter = self._adapters[url]
        chap_url = chapter.get("url") if isinstance(chapter, dict) else None
        html = adapter.getChapterTextNum(chap_url, index) if chap_url else ""
        title = (chapter.get("title") if isinstance(chapter, dict) else "") or ""
        return Chapter(n=index + 1, title=title, words=0, html=html or "")
