"""Small pure helpers with no external dependencies, so they can be unit-tested
without a Supabase client, network, or any third-party package installed."""

from __future__ import annotations


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
