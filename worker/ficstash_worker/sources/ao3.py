"""AO3 source — stub.

Real fetching is wired up in Phase 1 using FanFicFare (which handles AO3
login, chapter extraction, update detection, and EPUB export). For now this
just declares the interface so the registry and main loop can be built.

AO3 is a volunteer-run nonprofit. Be polite: keep RATE_LIMIT_SECONDS between
requests, back off on HTTP 429, and prefer EPUB / RSS / search endpoints over
aggressive page scraping. Store the session cookie, never the password.
"""

from __future__ import annotations

from .base import Source, WorkMeta, Chapter

RATE_LIMIT_SECONDS = 5


class AO3Source(Source):
    id = "ao3"

    def authenticate(self, username: str, password: str) -> str:
        raise NotImplementedError("AO3 login lands in Phase 1 (FanFicFare).")

    def import_reading_list(self, session: str) -> list[WorkMeta]:
        raise NotImplementedError("Bookmark import lands in Phase 1.")

    def fetch_work_metadata(self, source_work_id: str) -> WorkMeta:
        raise NotImplementedError("Metadata fetch lands in Phase 1.")

    def fetch_chapter(self, source_work_id: str, chapter_n: int) -> Chapter:
        raise NotImplementedError("Chapter fetch lands in Phase 1.")

    def check_for_updates(self, known: WorkMeta) -> WorkMeta | None:
        raise NotImplementedError("Update detection lands in Phase 1.")

    def search_by_tag(self, tag: str, limit: int = 25) -> list[WorkMeta]:
        raise NotImplementedError("Tag search lands in Phase 1.")
