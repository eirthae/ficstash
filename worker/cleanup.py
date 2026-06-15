"""Targeted cleanup of old/stale works (NOT a full purge).

DRY RUN by default: prints a breakdown of the library by origin + restricted +
hidden, so you can see what's there before deleting anything. Set the env flags
to actually hide matching works:

  HIDE_BOOKMARKS=1   hide works from the original bookmark import (origin='bookmark')
  HIDE_RESTRICTED=1  hide AO3 members-only works the logged-out worker can't fetch

Hiding sets works.hidden = true. That removes them from the library AND from the
worker's refresh passes (both query hidden=false), so stale works stop blocking
syncs. It's reversible — the rows stay; nothing is hard-deleted.

Run via the "Cleanup stale works" workflow (reads SUPABASE_URL +
SUPABASE_SERVICE_ROLE_KEY from secrets), or locally with those env vars set.
"""

from __future__ import annotations

import os

from ficstash_worker.supabase_io import make_client


def _flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def main() -> None:
    db = make_client()
    rows = list(
        db.table("works")
        .select("id,origin,restricted,status,hidden,source")
        .execute().data or []
    )
    total = len(rows)
    visible = [r for r in rows if not r.get("hidden")]
    by_origin: dict[str, int] = {}
    for r in visible:
        o = r.get("origin") or "(none)"
        by_origin[o] = by_origin.get(o, 0) + 1
    restricted = [r for r in visible if r.get("restricted")]

    print(f"Works total: {total}  |  visible: {len(visible)}  |  hidden: {total - len(visible)}")
    print("Visible by origin:")
    for o in sorted(by_origin):
        print(f"  {o}: {by_origin[o]}")
    print(f"Visible restricted (members-only, unfetchable): {len(restricted)}")

    hide_bookmarks = _flag("HIDE_BOOKMARKS")
    hide_restricted = _flag("HIDE_RESTRICTED")
    if not hide_bookmarks and not hide_restricted:
        print("\nDRY RUN — nothing changed. Set HIDE_BOOKMARKS=1 and/or HIDE_RESTRICTED=1 to hide.")
        return

    targets = {}
    for r in visible:
        rid = r.get("id")
        if not rid:
            continue
        if hide_bookmarks and (r.get("origin") or "") == "bookmark":
            targets[rid] = "bookmark"
        elif hide_restricted and r.get("restricted"):
            targets[rid] = "restricted"
    print(f"\nHiding {len(targets)} work(s) "
          f"(bookmarks={hide_bookmarks}, restricted={hide_restricted})…")
    done = 0
    for rid in targets:
        try:
            db.table("works").update({"hidden": True}).eq("id", rid).execute()
            done += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  {rid} failed: {type(exc).__name__}: {exc}")
    print(f"Hidden {done}/{len(targets)}. They're now out of the library + refresh passes.")


if __name__ == "__main__":
    main()
