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
