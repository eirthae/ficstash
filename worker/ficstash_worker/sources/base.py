"""Abstract source interface.

Every supported site (AO3, Royal Road, Scribble Hub, ...) implements this
interface so the rest of the worker stays source-agnostic. The `id` of each
source matches the `source` field stored on every `works` row in Supabase and
the ids in the app's `src/sources/index.js` registry.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field


@dataclass
class WorkMeta:
    """Metadata for a single work — no chapter bodies."""
    source: str
    source_work_id: str
    title: str
    author: str
    fandom: str = ""
    pairing: str = ""
    summary: str = ""
    # Tag objects in the app's shape: [{"t": name, "k": kind}, ...]
    tags: list[dict] = field(default_factory=list)
    # Native-script language name as AO3 displays it ("English", "日本語",
    # "Русский", "Հայերեն", ...). Empty/"Unknown" when not yet determined.
    language: str = ""
    words: int = 0
    chapters: int = 0
    chapters_total: int | None = None
    status: str = "ongoing"  # "ongoing" | "complete"
    updated: str | None = None  # ISO-8601 last-updated timestamp
    url: str = ""
    # Only set for reading-history stubs: when the user last opened the work on
    # AO3 (ISO-8601). Lets the app build a "read in <year>" archive shelf.
    history_read_at: str | None = None


@dataclass
class Chapter:
    n: int
    title: str
    words: int = 0
    html: str = ""


class Source(ABC):
    """One fanfic site. Subclasses must set `id` and implement every method."""

    id: str = ""

    @abstractmethod
    def authenticate(self, username: str, password: str) -> str:
        """Log in and return a session token/cookie to reuse.

        Store the returned session, never the password. Raises on failure.
        """

    @abstractmethod
    def import_reading_list(self, session: str) -> list[WorkMeta]:
        """Return the user's reading list (AO3 bookmarks, RR follows, ...)."""

    @abstractmethod
    def fetch_work_metadata(self, source_work_id: str) -> WorkMeta:
        """Fetch metadata for one work (no chapter bodies)."""

    @abstractmethod
    def fetch_chapter(self, source_work_id: str, chapter_n: int) -> Chapter:
        """Fetch a single chapter's body."""

    @abstractmethod
    def check_for_updates(self, known: WorkMeta) -> WorkMeta | None:
        """Return fresh metadata if the work changed, else None."""

    @abstractmethod
    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        """Return works matching a tracked tag (metadata only)."""
