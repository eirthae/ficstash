"""Source registry — capability-based; mirrors the app's src/sources/index.js ids.

Each source declares which capabilities it supports (see base.py). Callers ask
the registry "does this source do X?" via `supports()` before using it, so a
discovery-only source never gets asked to download, etc.
"""

from .base import (
    ALL_CAPABILITIES,
    DOWNLOAD,
    FOLLOW,
    GENRE_LIST,
    TAG_AUTOCOMPLETE,
    TAG_SEARCH,
    WORK_URL,
    Chapter,
    Source,
    WorkMeta,
)
from .ao3 import AO3Source
from .royalroad import RoyalRoadSource

SOURCES: dict[str, Source] = {
    s.id: s for s in (AO3Source(), RoyalRoadSource())
}


def get_source(source_id: str) -> Source:
    return SOURCES[source_id]


def supports(source_id: str, capability: str) -> bool:
    """True if the named source exists and declares the given capability."""
    src = SOURCES.get(source_id)
    return bool(src and src.supports(capability))


__all__ = [
    "Source",
    "WorkMeta",
    "Chapter",
    "SOURCES",
    "get_source",
    "supports",
    "ALL_CAPABILITIES",
    "TAG_SEARCH",
    "GENRE_LIST",
    "TAG_AUTOCOMPLETE",
    "DOWNLOAD",
    "FOLLOW",
    "WORK_URL",
]
