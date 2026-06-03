"""Phase E spike — can we get past NovelUpdates' Cloudflare wall from CI?

A plain requests GET returns a Cloudflare "Just a moment..." managed challenge
(403, ~5.5KB) for every NovelUpdates URL from a GitHub Actions IP. Before we
park Phase E we want a decisive answer to the one remaining question: can a
lightweight, dependency-only solver (cloudscraper) clear that challenge? If yes,
a discovery-only NU source is viable. If no, NU needs a full headless browser
(FlareSolverr / Playwright) — infeasible in this simple worker — and we park it.

Throwaway: deleted once the build/skip call is made.
"""

from __future__ import annotations

import re
import sys

URLS = [
    ("homepage", "https://www.novelupdates.com/"),
    ("genre-page", "https://www.novelupdates.com/genre/fantasy/"),
]
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
INTERSTITIAL = ("just a moment", "attention required", "access denied", "enable javascript")


def title(body: str) -> str:
    m = _TITLE_RE.search(body)
    return (m.group(1).strip() if m else "")[:80]


def looks_blocked(status: int, body: str) -> bool:
    t = title(body).lower()
    return status in (403, 503) or any(s in t for s in INTERSTITIAL)


def main() -> int:
    try:
        import cloudscraper
    except Exception as exc:  # noqa: BLE001
        print(f"cloudscraper import failed: {exc}")
        return 1

    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "desktop": True}
    )
    any_ok = False
    print("== NovelUpdates cloudscraper spike ==\n")
    for label, url in URLS:
        try:
            resp = scraper.get(url, timeout=40)
            blocked = looks_blocked(resp.status_code, resp.text)
            verdict = "BLOCKED" if blocked else "OK"
            print(f"[{label}] {url}")
            print(f"    status={resp.status_code} bytes={len(resp.text)} title={title(resp.text)!r} -> {verdict}\n")
            # Confirm real content on the genre page: series links present?
            if label == "genre-page" and not blocked:
                n = len(set(re.findall(r"https://www\.novelupdates\.com/series/[^\"#?]+", resp.text)))
                print(f"    distinct /series/ links: {n}")
                if n > 0:
                    any_ok = True
        except Exception as exc:  # noqa: BLE001
            print(f"[{label}] EXCEPTION ({type(exc).__name__}: {exc})\n")

    print("=" * 48)
    if any_ok:
        print("VERDICT: cloudscraper cleared the wall and the genre page has series")
        print("links — a discovery-only NovelUpdates source is viable on CI.")
        return 0
    print("VERDICT: cloudscraper could NOT clear NovelUpdates' challenge. NU needs a")
    print("headless browser we won't run here — park Phase E.")
    return 1


if __name__ == "__main__":
    sys.exit(main())
