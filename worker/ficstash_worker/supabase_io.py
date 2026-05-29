"""Supabase writes for the worker (service_role key, server-side only).

The service_role key bypasses Row Level Security. It is read from the
environment by name and never logged. The app never sees this key — it reads
with the anon key behind the SELECT policies in 0001_init.sql.

Upsert strategy: we deliberately OMIT the user-owned reading-state columns
(progress, last_chapter, unread, frozen, frozen_date) from the work payload.
PostgREST's ON CONFLICT DO UPDATE only touches columns present in the payload,
so re-syncing a work preserves whatever progress the reader has made.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

from supabase import Client, create_client

from .sources.base import Chapter, WorkMeta
from .sources.ao3 import palette_for


def make_client() -> Client:
    url = os.environ["SUPABASE_URL"]
    key = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
    return create_client(url, key)


def _relative_label(iso: str | None) -> str | None:
    """Turn an ISO timestamp into a short human label like '3 days ago'."""
    if not iso:
        return None
    try:
        dt = datetime.fromisoformat(iso)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = datetime.now(timezone.utc) - dt
    secs = max(delta.total_seconds(), 0)
    if secs < 3600:
        m = int(secs // 60)
        return "just now" if m < 1 else f"{m} min ago"
    if secs < 86400:
        h = int(secs // 3600)
        return f"{h}h ago"
    days = int(secs // 86400)
    if days < 7:
        return f"{days} day{'s' if days != 1 else ''} ago"
    if days < 30:
        w = days // 7
        return f"{w} week{'s' if w != 1 else ''} ago"
    months = days // 30
    return f"{months} month{'s' if months != 1 else ''} ago"


def upsert_work(client: Client, meta: WorkMeta) -> str:
    """Insert/update one work and return its uuid primary key.

    Omits progress/last_chapter/unread/frozen/frozen_date so the reader's state
    survives re-syncs.
    """
    payload = {
        "source": meta.source,
        "source_work_id": meta.source_work_id,
        "title": meta.title,
        "author": meta.author,
        "fandom": meta.fandom,
        "pairing": meta.pairing,
        "summary": meta.summary,
        "tags": meta.tags,
        "words": meta.words,
        "chapters": meta.chapters,
        "chapters_total": meta.chapters_total,
        "status": meta.status,
        "updated_label": _relative_label(meta.updated),
        "source_updated": meta.updated,
        "palette": palette_for(meta.fandom or meta.title),
    }
    resp = (
        client.table("works")
        .upsert(payload, on_conflict="source,source_work_id")
        .execute()
    )
    if not resp.data:
        raise RuntimeError(f"Upsert returned no row for work {meta.source_work_id}")
    return resp.data[0]["id"]


def upsert_chapters(client: Client, work_id: str, chapters: list[Chapter]) -> int:
    """Insert/update chapter bodies for a work. Returns the count written."""
    rows = [
        {
            "work_id": work_id,
            "n": ch.n,
            "title": ch.title,
            "words": ch.words,
            "content": ch.html,
            "fetched": bool(ch.html),
        }
        for ch in chapters
    ]
    if not rows:
        return 0
    client.table("chapters").upsert(rows, on_conflict="work_id,n").execute()
    return len(rows)
