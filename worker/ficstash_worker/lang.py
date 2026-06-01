"""Language allowlist — keep only works in languages the user reads.

AO3 stores each work's language as its native-script name (English, 日本語,
Русский, հայերեն, 中文-普通话 國語, ...). We filter every import — bookmarks,
subscriptions, history, and tag-match discovery — down to a small allowlist so
the library never surfaces works in languages the user can't read.

Defaults to Armenian, English, Japanese, Russian; override with the
comma-separated ALLOWED_LANGUAGES env var (use the English keys below, e.g.
"english,japanese"). A work whose language we can't determine (blank/"Unknown")
is kept — we only drop a work when it positively names a disallowed language.
"""

from __future__ import annotations

import os

# English key -> every spelling AO3 might show (native + English), normalized
# to lowercase. Add aliases here if AO3 reports an unexpected variant.
_ALIASES: dict[str, set[str]] = {
    "armenian": {"armenian", "հայերեն"},
    "english": {"english"},
    "japanese": {"japanese", "日本語"},
    "russian": {"russian", "русский"},
}

# Languages we never drop on: blank means "not fetched yet"; AO3 returns the
# literal "Unknown" when its blurb omits the language field.
_UNKNOWN = {"", "unknown"}


def _normalize(s: str) -> str:
    return (s or "").strip().lower()


def allowed_language_set() -> set[str]:
    """Build the set of accepted language strings from env (or the default 4)."""
    raw = os.environ.get("ALLOWED_LANGUAGES", "").strip()
    keys = (
        [k.strip().lower() for k in raw.split(",") if k.strip()]
        if raw
        else list(_ALIASES.keys())
    )
    accepted: set[str] = set()
    for k in keys:
        accepted |= _ALIASES.get(k, {k})
    return accepted


def language_allowed(language: str, accepted: set[str] | None = None) -> bool:
    """True if a work's language is in the allowlist (or is unknown/blank)."""
    lang = _normalize(language)
    if lang in _UNKNOWN:
        return True  # don't drop on missing data
    if accepted is None:
        accepted = allowed_language_set()
    return lang in accepted
