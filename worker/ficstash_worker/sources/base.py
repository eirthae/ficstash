"""Abstract source interface — capability-based.

Every supported site (AO3, Royal Road, Scribble Hub, NovelUpdates, ...)
implements this interface so the rest of the worker stays source-agnostic. The
`id` of each source matches the `source` field stored on every `works` row in
Supabase and the ids in the app's `src/sources/index.js` registry.

FicStash is a curated reader, not an account mirror, so sources are no longer
required to log in or import a reading list. Instead each source DECLARES which
capabilities it supports, and the worker/app only call what's declared:

  * TAG_SEARCH       — find works by tag/genre (the discovery engine).
  * GENRE_LIST       — offer a fixed list of the site's genres/categories.
  * TAG_AUTOCOMPLETE — suggest tag names as the user types.
  * DOWNLOAD         — fetch full chapter bodies for an offline copy.
  * FOLLOW           — re-check an ongoing work for new chapters.
  * WORK_URL         — build a canonical "open at source" link.

A discovery-only aggregator like NovelUpdates can declare TAG_SEARCH + WORK_URL
and nothing else; the registry won't ask it to download. The capability tokens
are the SAME strings the app uses, so both sides agree on what a source can do.
"""

from __future__ import annotations

from abc import ABC
from dataclasses import dataclass, field

# ---- capability tokens (kept identical to the app's src/sources/index.js) ----
TAG_SEARCH = "tagSearch"
GENRE_LIST = "genreList"
TAG_AUTOCOMPLETE = "tagAutocomplete"
DOWNLOAD = "download"
FOLLOW = "follow"
WORK_URL = "workUrl"

ALL_CAPABILITIES = frozenset(
    {TAG_SEARCH, GENRE_LIST, TAG_AUTOCOMPLETE, DOWNLOAD, FOLLOW, WORK_URL}
)


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
    # AO3 series membership (the work's primary series), for auto-grouping.
    series_id: str = ""
    series_name: str = ""
    series_index: float | None = None  # position in the series (set when known)
    # AO3 "work skin" CSS (chat/texting/social styling), captured raw; the app
    # sanitizes + scopes it at render. Empty for ordinary fics.
    work_skin: str = ""
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
    """One fanfic site.

    Subclasses must set `id` and `capabilities`, then implement the methods
    matching the capabilities they declare. Methods for capabilities a source
    does NOT declare are left as the NotImplementedError defaults below — the
    registry checks `supports()` before calling, so they should never fire.
    """

    id: str = ""
    capabilities: frozenset[str] = frozenset()

    def supports(self, capability: str) -> bool:
        return capability in self.capabilities

    # ---- WORK_URL ----------------------------------------------------------
    def work_url(self, source_work_id: str) -> str:
        """Canonical "open at source" link for a work."""
        raise NotImplementedError(f"{self.id} has no work_url")

    # ---- DOWNLOAD ----------------------------------------------------------
    def fetch_work_metadata(self, source_work_id: str) -> WorkMeta:
        """Fetch metadata for one work (no chapter bodies)."""
        raise NotImplementedError(f"{self.id} cannot fetch metadata")

    def fetch_chapter(self, source_work_id: str, chapter_n: int) -> Chapter:
        """Fetch a single chapter's body."""
        raise NotImplementedError(f"{self.id} cannot download")

    # ---- FOLLOW ------------------------------------------------------------
    def check_for_updates(self, known: WorkMeta) -> WorkMeta | None:
        """Return fresh metadata if the work changed, else None."""
        raise NotImplementedError(f"{self.id} cannot check for updates")

    # ---- TAG_SEARCH --------------------------------------------------------
    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        """Return works matching a single tracked tag (metadata only)."""
        raise NotImplementedError(f"{self.id} has no tag search")

    def search_by_tags(
        self,
        include: list[str],
        exclude: list[str] | tuple[str, ...] = (),
        limit: int = 25,
    ) -> list[WorkMeta]:
        """Return works matching ALL `include` tags and NONE of `exclude`.

        This is the real discovery entry point for a tracked group: a group with
        several tags means "a work must carry every one" (intersection / AND),
        mirroring how each site's own multi-tag search behaves — NOT the union of
        each tag's newest works (which rarely overlap and looked like "0 results").

        The default here only honours the first include tag; sources with a
        native multi-tag search (Royal Road) or a per-item category list
        (Scribble Hub) override this to AND properly and apply excludes.
        """
        inc = [t for t in include if t]
        if not inc:
            return []
        return self.search_by_tag(inc[0], limit=limit)
