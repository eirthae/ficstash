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


def fetch_existing_works(client: Client, source: str = "ao3") -> dict[str, dict]:
    """Return already-stored works for a source, keyed by source_work_id.

    Used to skip re-downloading chapter bodies for works that haven't changed.
    """
    resp = (
        client.table("works")
        .select("id,source_work_id,chapters,words,offline,hidden")
        .eq("source", source)
        .execute()
    )
    return {r["source_work_id"]: r for r in (resp.data or [])}


def fetch_non_offline_works(
    client: Client, source: str = "ao3", limit: int | None = None
) -> list[dict]:
    """Return stored works that don't yet have full offline chapter bodies.

    Every work in the library should become a full offline copy (the app is
    offline-first). Bookmarks are fetched whole on pass 1; subscriptions and
    history start as metadata-only, so this backfills their chapter text on
    later runs. Ordered most-recently-updated first and capped by `limit` so the
    backfill stays gradual and polite to AO3.
    """
    query = (
        client.table("works")
        .select("id,source_work_id,chapters,words")
        .eq("source", source)
        .eq("offline", False)
        .eq("hidden", False)
        .order("source_updated", desc=True)
    )
    if limit:
        query = query.limit(limit)
    return list(query.execute().data or [])


def fetch_untitled_works(
    client: Client, source: str = "ao3", limit: int | None = None
) -> list[str]:
    """Return source_work_ids of stored works whose title never populated.

    Older worker builds tolerated an ao3-api reload() abort but didn't fall back
    to the soup, so those rows landed with a blank title (and blank
    author/fandom). This finds them so a repair pass can re-fetch their metadata.
    Ordered most-recently-updated first and capped by `limit` to stay polite.
    """
    query = (
        client.table("works")
        .select("source_work_id,title")
        .eq("source", source)
        .eq("hidden", False)
        .or_("title.is.null,title.eq.")
        .order("source_updated", desc=True)
    )
    if limit:
        query = query.limit(limit)
    rows = list(query.execute().data or [])
    return [r["source_work_id"] for r in rows if r.get("source_work_id")]


def upsert_work(
    client: Client,
    meta: WorkMeta,
    *,
    history_read_at: str | None = None,
    **flags: bool,
) -> str:
    """Insert/update one work and return its uuid primary key.

    Omits progress/last_chapter/unread/frozen/frozen_date so the reader's state
    survives re-syncs. `flags` (offline/bookmarked/subscribed/in_history) are
    only written when provided, so one sync pass never clobbers another's flag.
    `history_read_at` (the AO3 last-visited date) is written only when supplied.
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
    # Store the canonical link only for works added by URL (non-AO3), so the
    # app can link back out; AO3 rows leave source_url null.
    if meta.source != "ao3" and meta.url:
        payload["source_url"] = meta.url
    for key in ("offline", "bookmarked", "subscribed", "in_history"):
        if key in flags:
            payload[key] = bool(flags[key])
    if history_read_at is not None:
        payload["history_read_at"] = history_read_at
    resp = (
        client.table("works")
        .upsert(payload, on_conflict="source,source_work_id")
        .execute()
    )
    if not resp.data:
        raise RuntimeError(f"Upsert returned no row for work {meta.source_work_id}")
    return resp.data[0]["id"]


def fetch_tracked_groups(client: Client) -> list[dict]:
    """Return the user's tracked tag groups (created in-app)."""
    resp = (
        client.table("tracked_groups")
        .select("id,label,tags,excluded_tags,match_mode")
        .execute()
    )
    return list(resp.data or [])


def upsert_tag_matches(client: Client, group_id: str, metas: list[WorkMeta]) -> int:
    """Store discovered works for a tracked group.

    Omits `seen`/`first_seen_at`/`dismissed` so a work already marked seen stays
    seen — and a user-dismissed work stays hidden — across re-runs; brand-new
    matches default to unseen ("fresh") and not dismissed.
    """
    rows = [
        {
            "group_id": group_id,
            "source": m.source,
            "source_work_id": m.source_work_id,
            "title": m.title,
            "author": m.author,
            "fandom": m.fandom,
            "summary": m.summary,
            "tags": m.tags,
            "words": m.words,
            "chapters": m.chapters,
            "status": m.status,
            "source_updated": m.updated,
            "palette": palette_for(m.fandom or m.title),
        }
        for m in metas
    ]
    if not rows:
        return 0
    client.table("tag_matches").upsert(
        rows, on_conflict="group_id,source,source_work_id"
    ).execute()
    return len(rows)


def mark_group_checked(client: Client, group_id: str) -> None:
    """Record that the worker just searched this group."""
    client.table("tracked_groups").update(
        {"last_checked": datetime.now(timezone.utc).isoformat()}
    ).eq("id", group_id).execute()


def mark_flag(
    client: Client, source_work_ids: list[str], flag: str, source: str = "ao3"
) -> int:
    """Set a boolean origin flag to true on already-stored works.

    Lets us tag works as in_history/subscribed without a fresh AO3 request when
    we already have their metadata.
    """
    ids = list(source_work_ids)
    if not ids:
        return 0
    client.table("works").update({flag: True}).eq("source", source).in_(
        "source_work_id", ids
    ).execute()
    return len(ids)


def mark_in_history(
    client: Client, reads: dict[str, str | None], source: str = "ao3"
) -> int:
    """Flag already-stored works as in_history and stamp their last-read date.

    `reads` maps source_work_id -> ISO last-visited date (or None). Works sharing
    the same read date are updated together to keep this to a few writes.
    """
    if not reads:
        return 0
    by_date: dict[str | None, list[str]] = {}
    for wid, read_at in reads.items():
        by_date.setdefault(read_at, []).append(wid)
    for read_at, ids in by_date.items():
        payload: dict = {"in_history": True}
        if read_at is not None:
            payload["history_read_at"] = read_at
        client.table("works").update(payload).eq("source", source).in_(
            "source_work_id", ids
        ).execute()
    return len(reads)


def fetch_wanted_matches(client: Client, source: str = "ao3") -> list[str]:
    """Return distinct source_work_ids the app has requested be saved offline.

    These are tag_matches the user tapped "Save" on (wanted=true) that the worker
    hasn't fetched into the library yet (saved=false).
    """
    resp = (
        client.table("tag_matches")
        .select("source_work_id")
        .eq("source", source)
        .eq("wanted", True)
        .eq("saved", False)
        .execute()
    )
    seen: list[str] = []
    for r in resp.data or []:
        wid = r.get("source_work_id")
        if wid and wid not in seen:
            seen.append(wid)
    return seen


def mark_matches_saved(
    client: Client, source_work_id: str, source: str = "ao3"
) -> None:
    """Flag every match row for a work as saved once it's in the library."""
    client.table("tag_matches").update({"saved": True, "wanted": False}).eq(
        "source", source
    ).eq("source_work_id", source_work_id).execute()


def reset_empty_offline(client: Client, source: str = "ao3") -> int:
    """Clear the offline flag on works that have no readable chapter text.

    Older worker builds flagged a work `offline=True` before its chapter bodies
    were actually stored, so a failed fetch could leave a work marked
    "downloaded" while empty — and the backfill (which only looks at
    offline=False works) would never retry it. This re-checks every flagged work
    against the chapters table and resets any with zero fetched chapters back to
    offline=False so the next backfill pass picks them up. DB-only; no AO3 hits.
    Idempotent and safe to run every sync.
    """
    flagged = (
        client.table("works")
        .select("id")
        .eq("source", source)
        .eq("offline", True)
        .execute()
        .data
        or []
    )
    if not flagged:
        return 0
    flagged_ids = [w["id"] for w in flagged]

    chunk = 100
    have_text: set[str] = set()
    for i in range(0, len(flagged_ids), chunk):
        batch = flagged_ids[i : i + chunk]
        rows = (
            client.table("chapters")
            .select("work_id")
            .in_("work_id", batch)
            .eq("fetched", True)
            .execute()
            .data
            or []
        )
        for r in rows:
            have_text.add(r["work_id"])

    empty_ids = [wid for wid in flagged_ids if wid not in have_text]
    for i in range(0, len(empty_ids), chunk):
        batch = empty_ids[i : i + chunk]
        client.table("works").update({"offline": False}).in_("id", batch).execute()
    return len(empty_ids)


def fetch_requested_urls(client: Client) -> list[dict]:
    """Return queued add-by-link requests (oldest first) the app submitted."""
    resp = (
        client.table("requested_urls")
        .select("id,url")
        .eq("status", "queued")
        .order("created_at", desc=False)
        .execute()
    )
    return list(resp.data or [])


def mark_request(client: Client, request_id: str, **fields) -> None:
    """Update a link request's progress (status/source/source_work_id/title/error)."""
    payload = {k: v for k, v in fields.items() if v is not None}
    if not payload:
        return
    client.table("requested_urls").update(payload).eq("id", request_id).execute()


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
