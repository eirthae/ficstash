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
from datetime import datetime, timedelta, timezone

from supabase import Client, create_client

from .sources.base import Chapter, WorkMeta
from .util import is_following
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


def record_chapter_updates(client: Client, work_uuid: str, source: str,
                            source_work_id: str, chapters: list) -> int:
    """Record newly-appended chapters in the What's New "new chapters" feed.

    Called by the refresh pass after it adds chapters to an already-offline
    work. One row per chapter; idempotent on (work_id, chapter_n) so a repeat
    sync won't duplicate. `chapters` are Chapter objects (n/title/words).
    """
    rows = [
        {
            "work_id": work_uuid,
            "source": source,
            "source_work_id": source_work_id,
            "chapter_n": int(getattr(c, "n", 0) or 0),
            "title": getattr(c, "title", "") or "",
            "words": int(getattr(c, "words", 0) or 0),
        }
        for c in (chapters or [])
        if getattr(c, "n", 0)
    ]
    if not rows:
        return 0
    try:
        client.table("chapter_updates").upsert(
            rows, on_conflict="work_id,chapter_n"
        ).execute()
    except Exception:  # noqa: BLE001 — feed is best-effort; never fail a sync over it
        return 0
    return len(rows)


def fetch_discovery_prefs(client: Client) -> dict:
    """Global discovery filters (the single discovery_prefs row).

    Returns {"languages": [...], "excluded_tags": [...]} or {} if the row/table
    isn't there yet, so callers apply no extra filtering by default.
    """
    try:
        resp = (
            client.table("discovery_prefs")
            .select("languages,excluded_tags")
            .eq("id", 1)
            .limit(1)
            .execute()
        )
        rows = resp.data or []
        return rows[0] if rows else {}
    except Exception:  # noqa: BLE001 — table may not exist on older deployments
        return {}


def fetch_ongoing_offline_works(
    client: Client, limit: int | None = None
) -> list[dict]:
    """Return downloaded works that are still ONGOING, to re-check for new
    chapters. Any saved work (any source) that isn't complete is a candidate;
    the refresh pass re-reads it and pulls only the chapters it doesn't have.
    Newest-activity first, capped by `limit` so the re-check stays polite.
    """
    query = (
        client.table("works")
        .select("id,source,source_work_id,source_url,chapters,chapters_total,status")
        .eq("offline", True)
        .eq("hidden", False)
        .neq("status", "complete")
        .order("source_updated", desc=True)
    )
    if limit:
        query = query.limit(limit)
    return list(query.execute().data or [])


def fetch_all_offline_works(client: Client, limit: int | None = None) -> list[dict]:
    """Return EVERY downloaded work (any status), for a full library revamp.

    Like fetch_ongoing_offline_works but without the status filter — used by the
    on-demand "full refresh" to re-read each work's metadata (status, counts,
    AO3 series) and pull any chapters it's missing. Newest-activity first.
    """
    query = (
        client.table("works")
        .select("id,source,source_work_id,source_url,chapters,chapters_total,status")
        .eq("offline", True)
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


def fetch_plaintext_chapter_works(
    client: Client, source: str = "ao3", limit: int | None = None
) -> list[str]:
    """Return source_work_ids of works whose stored chapter bodies are plain text.

    Early builds stored ao3-api's ``Chapter.text``, which strips all markup, so
    the reader (which injects bodies as HTML) rendered those chapters as one
    unbroken blob with no paragraph spacing. Newer builds store the chapter's
    real HTML. A genuine HTML body always contains at least one ``<`` tag; a
    stripped plain-text body never does — so chapters whose fetched content has
    no ``<`` are the legacy ones a repair pass should re-download.

    Ordered most-recently-updated first and capped by ``limit`` to stay polite.
    """
    # Fetched chapter rows whose body contains no markup at all. Select only the
    # work_id so we don't pull the (large) content blobs back over the wire.
    resp = (
        client.table("chapters")
        .select("work_id")
        .eq("fetched", True)
        .not_.like("content", "%<%")
        .execute()
    )
    work_uuids = {r["work_id"] for r in (resp.data or []) if r.get("work_id")}
    if not work_uuids:
        return []
    query = (
        client.table("works")
        .select("source_work_id,source_updated")
        .eq("source", source)
        .eq("hidden", False)
        .in_("id", list(work_uuids))
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
    origin: str | None = None,
    **flags: bool,
) -> str:
    """Insert/update one work and return its uuid primary key.

    Omits progress/last_chapter/unread/frozen/frozen_date so the reader's state
    survives re-syncs. `flags` (offline/bookmarked/subscribed/in_history/follow)
    are only written when provided, so one sync pass never clobbers another's
    flag. `origin` (how the work entered the library: 'link'/'tag'/…) is written
    only when supplied, so a backfill never overwrites the original source lane.
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
    # AO3 series membership for auto-grouping — written only when known, so a
    # lazy/unloaded refresh (series == "") never wipes a previously-set series.
    if getattr(meta, "series_id", ""):
        payload["ao3_series_id"] = meta.series_id
        payload["ao3_series_name"] = meta.series_name
    if getattr(meta, "series_index", None) is not None:
        payload["ao3_series_index"] = meta.series_index
    # Work-skin CSS (chat/texting styling) — only written when captured, so a
    # search-sourced or unloaded upsert (work_skin == "") never wipes one we have.
    if getattr(meta, "work_skin", ""):
        payload["work_skin"] = meta.work_skin
    # `follow` is not a manual toggle. Every still-updating work is followed by
    # default so the refresh pass re-checks it for new chapters on each sync;
    # complete works are unfollowed (nothing left to fetch). Derived from status
    # on every upsert, so it self-corrects as a work flips ongoing → complete.
    payload["follow"] = is_following(meta.status)
    # `hidden` is included so an explicit re-save / re-add un-deletes a work the
    # user had removed (passed hidden=False by the link + tag-save passes). It's
    # written only when supplied, so automatic passes (backfill/refresh) never
    # resurrect a deleted work.
    for key in ("offline", "bookmarked", "subscribed", "in_history", "hidden"):
        if key in flags:
            payload[key] = bool(flags[key])
    if origin:
        payload["origin"] = origin
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
        .select(
            "id,label,tags,excluded_tags,match_mode,source,status,last_checked,created_at"
        )
        .execute()
    )
    return list(resp.data or [])


def fetch_dismissed_work_ids(client: Client) -> set:
    """source_work_ids the user dismissed in ANY tracked group. A dismissal is
    global: a work that also matches another tracked tag shouldn't reappear there
    once you've swiped it away once."""
    resp = (
        client.table("tag_matches").select("source_work_id").eq("dismissed", True).execute()
    )
    return {r["source_work_id"] for r in (resp.data or []) if r.get("source_work_id")}


def propagate_dismissals(client: Client) -> int:
    """Spread every dismissal across all tracked groups: a work dismissed in one
    group is marked dismissed in its rows under every OTHER group too, so it stops
    appearing in those tags' feeds. DB-only, idempotent. Returns rows newly hidden."""
    ids = list(fetch_dismissed_work_ids(client))
    if not ids:
        return 0
    total = 0
    for i in range(0, len(ids), 200):
        batch = ids[i : i + 200]
        resp = (
            client.table("tag_matches")
            .update({"dismissed": True, "seen": True})
            .in_("source_work_id", batch)
            .eq("dismissed", False)
            .execute()
        )
        total += len(resp.data or [])
    return total


def upsert_tag_matches(client: Client, group_id: str, metas: list[WorkMeta]) -> int:
    """Store discovered works for a tracked group.

    Omits `seen`/`first_seen_at`/`dismissed`/`later` so a work already marked seen
    stays seen, a dismissed work stays hidden, and one set aside for Later stays
    there across re-runs; brand-new matches default to unseen ("fresh"), not
    dismissed, not in the Later stash.

    Every row carries the SAME keys on purpose: PostgREST rejects a bulk upsert
    whose objects don't all match ("All object keys must match"), so stamping
    `dismissed` on only some rows silently dropped the WHOLE batch — and any tag
    that overlapped a previously-dismissed work came back with 0 matches. Spreading
    a dismissal across tags is handled separately by propagate_dismissals().
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


def fetch_wanted_matches_all(client: Client) -> list[dict]:
    """Return distinct (source, source_work_id) the app requested be saved.

    Like fetch_wanted_matches but across every source, so non-AO3 matches (Royal
    Road, …) get downloaded too. Each entry is {"source", "source_work_id"};
    saves are downloaded via the source's own path in the worker.
    """
    resp = (
        client.table("tag_matches")
        .select("source,source_work_id")
        .eq("wanted", True)
        .eq("saved", False)
        .execute()
    )
    seen: set[tuple[str, str]] = set()
    out: list[dict] = []
    for r in resp.data or []:
        src = r.get("source") or "ao3"
        wid = r.get("source_work_id")
        if not wid or (src, wid) in seen:
            continue
        seen.add((src, wid))
        out.append({"source": src, "source_work_id": wid})
    return out


def mark_matches_saved(
    client: Client, source_work_id: str, source: str = "ao3"
) -> None:
    """Flag every match row for a work as saved once it's in the library."""
    client.table("tag_matches").update({"saved": True, "wanted": False}).eq(
        "source", source
    ).eq("source_work_id", source_work_id).execute()


def _work_ids_with_fetched_text(client: Client, work_ids: list) -> set:
    """The subset of `work_ids` that have at least one fetched (non-empty) chapter.

    Pages through the chapters query. This MATTERS: each fetched chapter is its own
    row repeating its work_id, so a 100-work batch can have thousands of rows —
    far past PostgREST's default 1000-row response cap. A single un-paged query
    silently truncated, dropped work_ids past the cap, and made fully-downloaded
    works look "empty" (so they got re-downloaded every run). We page with
    .range() until a short page comes back, so the set is complete.
    """
    have: set = set()
    page = 1000
    chunk = 100
    for i in range(0, len(work_ids), chunk):
        batch = work_ids[i : i + chunk]
        start = 0
        while True:
            rows = (
                client.table("chapters")
                .select("work_id")
                .in_("work_id", batch)
                .eq("fetched", True)
                .range(start, start + page - 1)
                .execute()
                .data
                or []
            )
            for r in rows:
                have.add(r["work_id"])
            if len(rows) < page:
                break
            start += page
    return have


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
    have_text = _work_ids_with_fetched_text(client, flagged_ids)

    empty_ids = [wid for wid in flagged_ids if wid not in have_text]
    for i in range(0, len(empty_ids), chunk):
        batch = empty_ids[i : i + chunk]
        client.table("works").update({"offline": False}).in_("id", batch).execute()
    return len(empty_ids)


def fetch_requested_urls(client: Client) -> list[dict]:
    """Return add-by-link requests to (re)try, oldest first.

    Retries both freshly 'queued' links AND ones left in a retryable 'error' state
    (transient hiccups, or works that were marked restricted by an earlier
    LOGGED-OUT run and can now be fetched via the authenticated session). Terminal
    states are excluded: 'done', 'restricted' (members-only even when logged in),
    and 'unsupported' (FanFicFare can't read the site)."""
    resp = (
        client.table("requested_urls")
        .select("id,url")
        .in_("status", ["queued", "error"])
        .order("created_at", desc=False)
        .execute()
    )
    return list(resp.data or [])


def delete_chapters_for_hidden_works(client: Client) -> int:
    """Free the offline text of soft-deleted (hidden) works.

    "Remove from library" only sets works.hidden=true; the chapter rows — the bulk
    of the DB (see docs/supabase-storage.md) — stayed forever. This purges chapter
    text for hidden works while keeping the lightweight `works` tombstone (so the
    worker still won't re-add them and reading state survives). Returns the number
    of chapter rows deleted. Cheap on repeat runs: once purged, a hidden work has no
    chapters left to delete. Batched to stay under statement limits.
    """
    hidden_ids: list[str] = []
    start, page = 0, 1000
    while True:
        resp = (
            client.table("works").select("id").eq("hidden", True)
            .range(start, start + page - 1).execute()
        )
        rows = resp.data or []
        hidden_ids.extend(r["id"] for r in rows)
        if len(rows) < page:
            break
        start += page
    if not hidden_ids:
        return 0
    deleted = 0
    for i in range(0, len(hidden_ids), 100):
        batch = hidden_ids[i:i + 100]
        resp = client.table("chapters").delete().in_("work_id", batch).execute()
        deleted += len(resp.data or [])
    return deleted


def clear_series_requests(client: Client) -> int:
    """Delete AO3 series-link requests from the queue (any status).

    Series URLs (…/series/<id>) can't be imported as a single work, so they'd
    otherwise sit in the app as red 'Bad Story URL' failures forever (the queue
    only re-runs status='queued'). Removing them up front keeps the link list
    clean. Series are handled via follow / download-all instead. Returns the
    number removed.
    """
    from ficstash_worker.util import is_ao3_series_url

    resp = client.table("requested_urls").select("id,url").execute()
    ids = [r["id"] for r in (resp.data or []) if is_ao3_series_url(r.get("url"))]
    for rid in ids:
        client.table("requested_urls").delete().eq("id", rid).execute()
    return len(ids)


def delete_request(client: Client, request_id: str) -> None:
    """Remove a single link request entirely (used to drop empty / non-existent
    works so they don't linger in the app as red failures)."""
    client.table("requested_urls").delete().eq("id", request_id).execute()


def mark_not_offline(client: Client, source: str, source_work_id: str) -> None:
    """Flag a work as NOT yet downloaded (offline=false) so the app shows it as
    'downloading' instead of a blank 'ready to read'. Used when a fetch comes back
    empty for a work that may already have a (ghost) row from a previous build —
    harmless when no such row exists (the update matches nothing)."""
    if not source_work_id:
        return
    client.table("works").update({"offline": False}).eq("source", source).eq(
        "source_work_id", source_work_id
    ).execute()


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
    # Write in size-bounded batches so one big or image-heavy work doesn't exceed
    # Postgres's statement timeout (the '57014 canceling statement' error). Each
    # statement carries at most ~3 MB of chapter content (a single chapter bigger
    # than that goes alone).
    MAX_BATCH_BYTES = 3_000_000
    batch: list[dict] = []
    size = 0
    for row in rows:
        clen = len(row["content"] or "")
        if batch and size + clen > MAX_BATCH_BYTES:
            client.table("chapters").upsert(batch, on_conflict="work_id,n").execute()
            batch, size = [], 0
        batch.append(row)
        size += clen
    if batch:
        client.table("chapters").upsert(batch, on_conflict="work_id,n").execute()
    # Count only chapters that actually carry text. Callers gate "mark offline"
    # on this, so a work whose bodies came back empty (a throttled / gated fetch)
    # is NOT flagged downloaded — it would otherwise show "ready to read" with
    # nothing inside and never get retried.
    return sum(1 for r in rows if (r["content"] or "").strip())


def fetch_stale_offline_works(
    client: Client, limit: int | None = None
) -> list[dict]:
    """Works flagged offline=true but with NO fetched chapter text — marked
    "downloaded" while actually empty (a failed / partial fetch). The app shows
    these as "ready to read" though they hold nothing, so the fast lane re-fetches
    them. Returns [{source, source_work_id, source_url}] across every source.
    """
    flagged = (
        client.table("works")
        .select("id,source,source_work_id,source_url")
        .eq("offline", True)
        .eq("hidden", False)
        .execute()
        .data
        or []
    )
    if not flagged:
        return []
    ids = [w["id"] for w in flagged]
    have_text = _work_ids_with_fetched_text(client, ids)
    stale = [
        {
            "source": w.get("source") or "ao3",
            "source_work_id": w.get("source_work_id"),
            "source_url": w.get("source_url"),
        }
        for w in flagged
        if w["id"] not in have_text and w.get("source_work_id")
    ]
    return stale[:limit] if limit else stale


# ---- AO3 series (follow / download-all queue) ------------------------------
def fetch_followed_series(client: Client) -> list[dict]:
    """Rows in followed_series: series the user asked to download / follow."""
    resp = (
        client.table("followed_series")
        .select("id,series_id,series_name,follow,last_checked,created_at,work_count")
        .order("created_at")
        .execute()
    )
    return list(resp.data or [])


def mark_series_checked(
    client: Client, series_id: str, *, name: str | None = None, count: int | None = None
) -> None:
    """Stamp a followed series as just-enumerated (and refresh its name + total).

    `count` is the series' TOTAL number of works as seen on AO3's index — stored
    so the app can show "X of Y downloaded" (Y may exceed what we could fetch when
    some works are registered-users-only).
    """
    patch: dict = {"last_checked": datetime.now(timezone.utc).isoformat()}
    if name:
        patch["series_name"] = name
    if count is not None:
        patch["work_count"] = int(count)
    client.table("followed_series").update(patch).eq("series_id", series_id).execute()


def delete_series_follow(client: Client, series_id: str) -> None:
    """Drop a followed_series row (used after a one-shot 'download all')."""
    client.table("followed_series").delete().eq("series_id", series_id).execute()


# ---- What's New retention (keep the feed to a recent window) ----------------
def expire_chapter_updates(client: Client, *, older_than_days: int = 5) -> int:
    """Delete 'new chapter' feed entries older than the window. Only removes the
    What's New NOTICE — the chapter text stays in `chapters`, fully readable."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
    resp = client.table("chapter_updates").delete().lt("created_at", cutoff).execute()
    return len(resp.data or [])


def chapter_updates_to_prune(rows: list[dict], complete_ids: set) -> list:
    """Pure: which chapter_updates ids to delete so the feed keeps only the newest
    chapter notice per still-updating work. `rows` are [{id, work_id, chapter_n}];
    `complete_ids` is the set of work ids that are complete. Drops every notice for
    a completed work (the feed is for ongoing works) and collapses multiple notices
    for one work down to its highest chapter_n. Unit-tested without a DB."""
    newest: dict = {}
    for r in rows:
        wid = r.get("work_id")
        n = int(r.get("chapter_n") or 0)
        if wid is not None and n > newest.get(wid, -1):
            newest[wid] = n
    out = []
    for r in rows:
        wid = r.get("work_id")
        n = int(r.get("chapter_n") or 0)
        if wid in complete_ids or n != newest.get(wid):
            out.append(r.get("id"))
    return [i for i in out if i is not None]


def prune_chapter_updates(client: Client) -> int:
    """Keep the new-chapter feed to ONE notice (the newest chapter) per ONGOING
    work. Drops notices for completed works (the feed is for still-updating works)
    and collapses multi-chapter floods — a corrected chapter count once made the
    refresh pass record a whole work's backlog as 'new'. DB-only; idempotent;
    chapter text stays in `chapters`. Returns the number of notices removed."""
    rows = (
        client.table("chapter_updates").select("id,work_id,chapter_n").execute().data
        or []
    )
    if not rows:
        return 0
    work_ids = list({r["work_id"] for r in rows if r.get("work_id")})
    complete: set = set()
    for i in range(0, len(work_ids), 100):
        batch = work_ids[i : i + 100]
        wr = (
            client.table("works").select("id,status").in_("id", batch).execute().data
            or []
        )
        for w in wr:
            if (w.get("status") or "").strip().lower() == "complete":
                complete.add(w["id"])
    ids = chapter_updates_to_prune(rows, complete)
    for i in range(0, len(ids), 100):
        client.table("chapter_updates").delete().in_("id", ids[i : i + 100]).execute()
    return len(ids)


def age_out_saved_matches(client: Client, *, older_than_days: int = 5) -> int:
    """Age recently-added works out of the 'New works' feed after the window by
    flipping origin -> 'bookmark'. Covers every lane the user can add a work
    through: 'tag' (saved from Discovery), 'link' (added by URL) and 'upload'
    (imported file). They leave What's New but stay in the library (which lists
    works of any origin)."""
    cutoff = (datetime.now(timezone.utc) - timedelta(days=older_than_days)).isoformat()
    resp = (
        client.table("works")
        .update({"origin": "bookmark"})
        .in_("origin", ["tag", "link", "upload"])
        .lt("created_at", cutoff)
        .execute()
    )
    return len(resp.data or [])


def set_work_series(
    client: Client,
    source_work_id: str,
    series_id: str,
    series_name: str,
    series_index: float | None,
) -> None:
    """Tag an already-stored AO3 work with its series + position (auto-grouping)."""
    patch: dict = {"ao3_series_id": series_id, "ao3_series_name": series_name}
    if series_index is not None:
        patch["ao3_series_index"] = series_index
    (
        client.table("works")
        .update(patch)
        .eq("source", "ao3")
        .eq("source_work_id", source_work_id)
        .execute()
    )


def fetch_offline_ao3_ids(client: Client) -> set[str]:
    """source_work_ids of AO3 works already downloaded (offline), for dedup."""
    resp = (
        client.table("works")
        .select("source_work_id")
        .eq("source", "ao3")
        .eq("offline", True)
        .execute()
    )
    return {r["source_work_id"] for r in (resp.data or []) if r.get("source_work_id")}
