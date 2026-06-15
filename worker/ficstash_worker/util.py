"""Small pure helpers with no external dependencies, so they can be unit-tested
without a Supabase client, network, or any third-party package installed."""

from __future__ import annotations


def is_ao3_series_url(url: str | None) -> bool:
    """Whether a pasted link is an AO3 *series* URL (…/series/<id>).

    Series links aren't importable as a single work — FanFicFare only handles
    …/works/<id> — so the link queue drops them rather than failing each run.
    Series are handled separately via follow / download-all. Work links (and any
    other site) are unaffected.
    """
    u = (url or "").lower()
    return "archiveofourown.org" in u and "/series/" in u


def is_phantom_link_error(name: str | None, message: str | None) -> bool:
    """Whether a failed link points to a work that doesn't exist (a made-up /
    404 / invalid-id "phantom") and should be dropped from the queue.

    Conservative: keep (return False) anything that looks transient or site-side
    — rate limit, network/timeout, 5xx, Cloudflare 403 — so a real work isn't
    silently deleted over a temporary hiccup. Only drop on clear "doesn't exist"
    signals, and keep unknown failures by default.
    """
    text = f"{name or ''} {message or ''}".lower()
    keep = (
        "403", "cloudflare", "forbidden", "timeout", "timed out", "connection",
        "temporarily", "ratelimit", "rate limit", "429", "502", "503", "504",
        "reset by peer", "max retries",
    )
    if any(k in text for k in keep):
        return False
    drop = ("404", "not found", "invalid", "no such", "does not exist", "page not found", "missing")
    return any(d in text for d in drop)


def is_following(status: str | None) -> bool:
    """Whether a work should be auto-followed for new-chapter refreshes.

    FicStash follows every still-updating work by default (so the refresh pass
    re-checks it for new chapters each sync) and unfollows complete ones (there
    is nothing left to fetch). `follow` is therefore derived from status, not a
    manual toggle. Unknown/blank statuses default to followed — safer to check
    a work we don't need than to silently stop updating one that's ongoing.
    """
    return (status or "").strip().lower() != "complete"


def status_matches(work_status: str | None, group_status: str | None) -> bool:
    """Whether a work passes a tracked group's completion-status filter.

    group_status 'all' (or anything unrecognised) matches everything; 'complete'
    keeps only finished works; 'ongoing' keeps only still-in-progress ones.
    Used by the discovery pass to drop non-matching works for AO3 (belt) and
    Royal Road / Scribble Hub (sole filter).
    """
    gs = (group_status or "all").strip().lower()
    if gs not in ("complete", "ongoing"):
        return True
    is_complete = (work_status or "").strip().lower() == "complete"
    return is_complete == (gs == "complete")
