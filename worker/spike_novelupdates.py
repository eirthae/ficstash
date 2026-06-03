"""Phase E spike — is NovelUpdates reachable from GitHub Actions IPs?

NovelUpdates is an aggregator/index (it links out to translators' sites rather
than hosting text), so a NovelUpdates source would be discovery-only: TAG_SEARCH
+ WORK_URL, no download. But NU is known to sit behind Cloudflare and is more
aggressive than Royal Road / Scribble Hub, so before building anything we need
to know whether a plain datacenter-IP GET gets real HTML or a challenge.

This probes the homepage, a genre page and the series-finder, classifies each
(real content vs Cloudflare interstitial), and — if content comes back — dumps
the series-link shape and genre slugs so the real source can be built without
guessing. Throwaway: deleted once the build/skip call is made.
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

URLS = [
    ("homepage", "https://www.novelupdates.com/"),
    ("genre-page", "https://www.novelupdates.com/genre/fantasy/"),
    (
        "series-finder",
        "https://www.novelupdates.com/series-finder/?sf=1&gr=1&sort=sdate&order=desc",
    ),
]

INTERSTITIAL_TITLES = ("just a moment", "attention required", "access denied")
CONTENT_MARKERS = ("search_main_box", "bdrank", "ranknum", "seriesimg", "search_title")
_TITLE_RE = re.compile(r"<title[^>]*>(.*?)</title>", re.I | re.S)
_SERIES_LINK_RE = re.compile(r'href="(https://www\.novelupdates\.com/series/[^"#?]+)"')
_GENRE_LINK_RE = re.compile(
    r'href="https://www\.novelupdates\.com/genre/([a-z0-9-]+)/"[^>]*>([^<]{2,40})<', re.I
)


def page_title(body: str) -> str:
    m = _TITLE_RE.search(body)
    return (m.group(1).strip() if m else "")[:80]


def classify(status: int, body: str) -> str:
    title = page_title(body).lower()
    if any(t in title for t in INTERSTITIAL_TITLES):
        return f"CHALLENGE (interstitial title: {title!r})"
    if status == 403 and len(body) < 20000:
        return "BLOCKED (403, no content)"
    if status in (429, 503):
        return f"RATE/UNAVAILABLE ({status})"
    low = body.lower()
    found = [m for m in CONTENT_MARKERS if m in low]
    if 200 <= status < 300 and found:
        return f"OK (content markers: {found})"
    if 200 <= status < 300 and len(body) > 40000:
        return f"OK-ish (large body {len(body)}B, markers absent)"
    if 200 <= status < 300:
        return f"OK-ish but thin ({len(body)} bytes)"
    return f"UNEXPECTED ({status})"


def dump_series_links(body: str) -> None:
    print("---- genre-page series links ----")
    links: list[str] = []
    seen: set[str] = set()
    for m in _SERIES_LINK_RE.finditer(body):
        u = m.group(1)
        if u not in seen:
            seen.add(u)
            links.append(u)
    print(f"    distinct /series/ links: {len(links)}")
    for u in links[:8]:
        print(f"      {u}")
    # Pagination shape.
    pg = sorted(set(re.findall(r"/genre/[a-z0-9-]+/(?:page/)?(\d+)/?", body)), key=int)
    print(f"    page numbers referenced: {pg[:12]}")
    # Is there a genre RSS feed?
    feed = "/genre/fantasy/feed/" in body or "feed" in body.lower()[:5000]
    print(f"    'feed' referenced near top: {feed}")
    print("---- end genre-page series links ----")


def dump_genre_slugs(body: str) -> None:
    print("---- genre name -> slug ----")
    pairs: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in _GENRE_LINK_RE.finditer(body):
        slug, name = m.group(1), m.group(2).strip()
        if slug in seen or slug == "feed":
            continue
        seen.add(slug)
        pairs.append((name, slug))
    print(f"    distinct genres: {len(pairs)}")
    for name, slug in pairs[:60]:
        print(f"    {name!r}: {slug!r}")
    print("---- end genre name -> slug ----")


def main() -> int:
    session = requests.Session()
    session.headers.update(HEADERS)
    any_ok = False
    print("== NovelUpdates CI-reachability spike ==\n")
    for label, url in URLS:
        try:
            resp = session.get(url, timeout=TIMEOUT)
            verdict = classify(resp.status_code, resp.text)
        except Exception as exc:  # noqa: BLE001
            verdict = f"EXCEPTION ({type(exc).__name__}: {exc})"
            resp = None
        size = len(resp.text) if resp is not None else 0
        code = resp.status_code if resp is not None else "—"
        title = page_title(resp.text) if resp is not None else ""
        print(f"[{label}] {url}")
        print(f"    status={code} bytes={size} title={title!r}")
        print(f"    -> {verdict}\n")
        if label == "genre-page" and verdict.startswith("OK") and resp is not None:
            any_ok = True
            dump_series_links(resp.text)
            dump_genre_slugs(resp.text)

    print("=" * 48)
    if any_ok:
        print("VERDICT: genre page came back as real HTML — a discovery-only")
        print("NovelUpdates source is viable on CI.")
        return 0
    print("VERDICT: nothing usable came back — NovelUpdates is challenging/blocking")
    print("GitHub Actions IPs. Phase E needs a different path (or skip).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
