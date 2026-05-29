"""Source registry — mirrors the app's src/sources/index.js ids."""

from .base import Source, WorkMeta, Chapter
from .ao3 import AO3Source

SOURCES: dict[str, Source] = {
    s.id: s for s in (AO3Source(),)
}


def get_source(source_id: str) -> Source:
    return SOURCES[source_id]


__all__ = ["Source", "WorkMeta", "Chapter", "SOURCES", "get_source"]
