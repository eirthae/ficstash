"""Phase D spike — is Scribble Hub reachable from GitHub Actions IPs?

Before building a Scribble Hub source we need to know whether the site serves
its public HTML to a datacenter IP (GitHub Actions) or hides behind a Cloudflare
"are you human" challenge. Cloudflare challenges typically come back as a 403, a
503, or a 200 whose body is the JS interstitial ("Just a moment…", "cf-mitigated",
"challenge-platform"). This script fetches a few public pages, prints the status,
size and a verdict for each, and exits non-zero if NOTHING came back clean — so
the workflow's pass/fail tells us at a glance whether Phase D is viable on CI.

This is throwaway: it imports nothing from the worker package and is deleted once
we've made the build/skip decision. Run locally or via the spike workflow.
"""

from __future__ import annotations

import sys

import requests

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}
TIMEOUT = 25

# A small spread of public pages: the homepage, the Series Finder (the discovery
# surface a real source would scrape), and one concrete series page.
URLS = [
    ("homepage", "https://www.scribblehub.com/"),
    (
        "series-finder",
        "https://www.scribblehub.com/series-finder/?sf=1&sort=ratings&order=desc&pg=1",
    ),
    ("series-page", "https://www.scribblehub.com/series/1/the-bibliophile/"),
]

# Substrings that betray a Cloudflare / bot-wall interstitial rather than content.
CHALLENGE_MARKERS = (
    "just a moment",
    "challenge-platform",
    "cf-mitigated",
    "cf_chl",
    "attention required",
    "enable javascript and cookies",
    "/cdn-cgi/challenge",
)


def classify(status: int, body: str) -> str:
    low = body.lower()
    hit = next((m for m in CHALLENGE_MARKERS if m in low), None)
    if hit:
        return f"CHALLENGE (marker: {hit!r})"
    if status == 403:
        return "BLOCKED (403)"
    if status in (429, 503):
        return f"RATE/UNAVAILABLE ({status})"
    if 200 <= status < 300 and len(body) > 2000:
        return "OK"
    if 200 <= status < 300:
        return f"OK-ish but thin ({len(body)} bytes)"
    return f"UNEXPECTED ({status})"


def main() -> int:
    session = requests.Session()
    session.headers.update(HEADERS)
    any_ok = False
    print("== Scribble Hub CI-reachability spike ==\n")
    for label, url in URLS:
        try:
            resp = session.get(url, timeout=TIMEOUT)
            verdict = classify(resp.status_code, resp.text)
        except Exception as exc:  # noqa: BLE001 — spike: report any failure
            verdict = f"EXCEPTION ({type(exc).__name__}: {exc})"
            resp = None
        size = len(resp.text) if resp is not None else 0
        code = resp.status_code if resp is not None else "—"
        print(f"[{label}] {url}")
        print(f"    status={code} bytes={size} -> {verdict}\n")
        if verdict == "OK":
            any_ok = True

    print("=" * 48)
    if any_ok:
        print("VERDICT: at least one page came back as real HTML — Phase D looks")
        print("viable on CI. Build the Scribble Hub source.")
        return 0
    print("VERDICT: nothing came back clean — Scribble Hub is challenging/blocking")
    print("GitHub Actions IPs. Phase D needs a different fetch path (or skip).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
