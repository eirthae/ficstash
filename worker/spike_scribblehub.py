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

import re
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

# A small spread of public pages: the homepage and the Series Finder (the
# discovery surface a real source would scrape). The Series Finder is the one
# that matters — that's what a Scribble Hub source would page through.
URLS = [
    ("homepage", "https://www.scribblehub.com/"),
    (
        "series-finder",
        "https://www.scribblehub.com/series-finder/?sf=1&sort=ratings&order=desc&pg=1",
    ),
]

# A real Cloudflare interstitial is a *small* page whose <title> says so and
# whose body has no site content. The "/cdn-cgi/challenge-platform/" beacon
# script, by contrast, is injected on perfectly normal pages, so its mere
# presence means nothing — only the interstitial title + a tiny body do.
INTERSTITIAL_TITLES = ("just a moment", "attention required", "access denied")
# Markers that the Series Finder actually rendered its listing.
CONTENT_MARKERS = (
    "search_main_box",   # each result row's container
    "fic_title",         # a series title link
    "search_title",      # the Series Finder heading block
    "series-finder",     # finder form / pagination links
)
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)


def page_title(body: str) -> str:
    m = _TITLE_RE.search(body)
    return (m.group(1).strip() if m else "")[:80]


# The Series Finder's genre checkboxes carry the numeric ids the search expects.
# Pull them so we can hardcode an accurate {name: id} table in the real source.
_GENRE_INPUT_RE = re.compile(
    r'<input[^>]*name="genre\[\]"[^>]*value="(\d+)"[^>]*>', re.I
)


def dump_genres(body: str) -> None:
    print("---- genre filter options (name -> id) ----")
    found: list[tuple[str, str]] = []
    # The finder lists each genre as a checkbox followed by its label text. Be
    # liberal: capture any value="N" near the word "genre", then any data-id.
    for m in re.finditer(
        r'data-id="(\d+)"[^>]*>\s*([^<]{2,40}?)\s*<', body
    ):
        found.append((m.group(2).strip(), m.group(1)))
    # De-dup, keep first occurrence order.
    seen: set[str] = set()
    uniq = [(n, i) for n, i in found if not (i in seen or seen.add(i))]
    for name, gid in uniq[:80]:
        print(f"    {name!r}: {gid}")
    if not uniq:
        print("    (no data-id pairs found — dump a slice of the genre section)")
        idx = body.lower().find("genre")
        print(body[idx : idx + 1500] if idx >= 0 else body[:1500])
    print("---- end genre options ----")


def classify(status: int, body: str) -> str:
    low = body.lower()
    title = page_title(body).lower()
    if any(t in title for t in INTERSTITIAL_TITLES):
        return f"CHALLENGE (interstitial title: {title!r})"
    if status == 403 and len(body) < 20000:
        return "BLOCKED (403, no content)"
    if status in (429, 503):
        return f"RATE/UNAVAILABLE ({status})"
    found = [m for m in CONTENT_MARKERS if m in low]
    if 200 <= status < 300 and found:
        return f"OK (content markers: {found})"
    if 200 <= status < 300 and len(body) > 40000:
        # Large 2xx body without our markers — real page, markup just shifted.
        return f"OK-ish (large body {len(body)}B, markers absent)"
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
        title = page_title(resp.text) if resp is not None else ""
        print(f"[{label}] {url}")
        print(f"    status={code} bytes={size} title={title!r}")
        print(f"    -> {verdict}\n")
        # The Series Finder is the page that decides viability.
        if label == "series-finder" and verdict.startswith("OK"):
            any_ok = True
            dump_genres(resp.text)

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
