// Pure library/shelf logic — extracted from the screens so it's unit-testable
// (node --test can't import JSX). Library.jsx, WhatsNew.jsx, library.js and
// sync.js import from here; shelving.test.js covers it.

// Fandom name without the author suffix ("Heated Rivalry – Rachel Reid" → "Heated Rivalry").
export function fandomName(work) {
  return ((work && work.fandom) || 'Other').split('–')[0].split(' - ')[0].trim() || 'Other';
}

// Which group a fic sits under on the Fics shelf: the user's manual override
// (customGroup) if they set one, else its fandom. This is how a reader consolidates
// AO3's many fandom tags into one recognizable bucket (e.g. Batman + Superman → DCU).
export function ficGroupName(work) {
  const cg = ((work && work.customGroup) || '').trim();
  return cg || fandomName(work);
}

// Lowercased tag texts of a work (tags are [{ t, k }] or strings), for search + filtering.
export function workTagSet(work) {
  return (Array.isArray(work && work.tags) ? work.tags : [])
    .map((t) => (typeof t === 'string' ? t : (t && (t.t || t.name)) || '').toLowerCase())
    .filter(Boolean);
}

// Which shelf a work belongs to. Uploaded EPUB/HTML/TXT → Books (stored as
// source/origin 'upload'); AO3 → Fics; anything else → Stories.
export function shelfOf(work) {
  if (!work) return 'fics';
  if ((work.origin || '') === 'upload' || work.source === 'upload') return 'books';
  if (work.source === 'ao3') return 'fics';
  return 'stories';
}

// ---- "have I actually read this?" ------------------------------------------
// Built on the LOCAL reading positions (fs-readpos), because the works table's
// `progress` / `last_chapter` columns exist but nothing ever writes to them —
// the reader only saves locally. Per-device by nature: a fresh install sees the
// whole shelf as unread.

// Roughly two paragraphs. An absolute word count, not a percentage: 2 paragraphs
// is ~5% of a 4k one-shot but ~0.25% of an 84k epic, so no single percentage
// means "barely started" across a real library.
export const UNREAD_WORDS = 250;

// Fraction of a work you've read, from the per-chapter scroll fractions.
// Divides by the chapter count so reading one chapter of twenty reads as ~5%,
// not 100%. Falls back to the furthest chapter visited when the work's chapter
// count is missing, so a bad count can't make a barely-read work look finished.
export function readFraction(work, entry) {
  const pcts = (entry && entry.chapters) || {};
  const visited = Object.keys(pcts);
  if (!visited.length) return 0;
  const total = Math.max(
    Number(work && work.chapters) || 0,
    ...visited.map((n) => Number(n) || 0),
    1,
  );
  const sum = visited.reduce((acc, n) => acc + (Number(pcts[n]) || 0), 0);
  return Math.min(1, sum / total);
}

// Estimated words read. `words` is the whole work, so this scales the fraction.
export function readWords(work, entry) {
  return readFraction(work, entry) * (Number(work && work.words) || 0);
}

// Unread = never opened, or opened and abandoned within ~2 paragraphs.
// The fraction guard keeps a very short work you actually finished from
// qualifying: a 200-word drabble read end to end is under UNREAD_WORDS but is
// plainly read.
export function isUnread(work, entry) {
  return readWords(work, entry) < UNREAD_WORDS && readFraction(work, entry) < 0.5;
}

// Sort a list without mutating it. Timestamps are ISO strings (sort as text).
// 'default' keeps the incoming order.
//
// 'unread' is the odd one out: it's a grouping, not an ordering. Unread works
// float to the top (newest-added first — what you'd actually reach for next) and
// everything already started keeps its last-read order below.
export function sortWorks(list, sort, lastRead = {}, readingPos = {}) {
  const arr = [...(list || [])];
  if (sort === 'added') arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  else if (sort === 'updated') arr.sort((a, b) => (b.sourceUpdated || '').localeCompare(a.sourceUpdated || ''));
  else if (sort === 'title') arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else if (sort === 'read') arr.sort((a, b) => (lastRead[b.id] || '').localeCompare(lastRead[a.id] || ''));
  else if (sort === 'unread') {
    arr.sort((a, b) => {
      const au = isUnread(a, readingPos[a.id]);
      const bu = isUnread(b, readingPos[b.id]);
      if (au !== bu) return au ? -1 : 1;
      if (au) return (b.createdAt || '').localeCompare(a.createdAt || '');
      return (lastRead[b.id] || '').localeCompare(lastRead[a.id] || '');
    });
  }
  return arr;
}

// How many of these you haven't read — for the sort menu's count and the divider.
export function countUnread(list, readingPos = {}) {
  return (list || []).reduce((n, w) => n + (isUnread(w, readingPos[w.id]) ? 1 : 0), 0);
}

// Order section groups by the active sort: A–Z by name, 'default' by size, else
// by the group's most-recent item (added / updated / read). Mutates + returns.
export function orderGroups(groups, sort, lastRead = {}) {
  if (sort === 'title') {
    groups.sort((a, b) => a.name.localeCompare(b.name));
  } else if (sort === 'default') {
    groups.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));
  } else {
    const recency = (g) => g.items.reduce((m, x) => {
      const v = sort === 'read' ? (lastRead[x.id] || '') : sort === 'updated' ? (x.sourceUpdated || '') : (x.createdAt || '');
      return v > m ? v : m;
    }, '');
    groups.sort((a, b) => recency(b).localeCompare(recency(a)));
  }
  return groups;
}

// Group AO3 fics BY FANDOM, with multi-work series collapsed into one series
// entry inside their fandom. Each section = { name, series:[{seriesId, name,
// items}], loose:[works], items:[all] }. A series is filed under the fandom of
// its first work (by part); a single-work series stays a loose card.
export function groupFics(works, sort = 'default', lastRead = {}) {
  const seriesByKey = new Map();
  const looseAll = [];
  for (const w of works || []) {
    const sid = (w.ao3SeriesId || '').trim();
    const sname = (w.ao3SeriesName || '').trim();
    if (!sid || !sname) { looseAll.push(w); continue; }
    let s = seriesByKey.get(sid);
    if (!s) { s = { seriesId: sid, name: sname, items: [] }; seriesByKey.set(sid, s); }
    s.items.push(w);
  }
  const byFandom = new Map();
  const ensure = (name) => {
    let g = byFandom.get(name);
    if (!g) { g = { name, series: [], loose: [], items: [] }; byFandom.set(name, g); }
    return g;
  };
  for (const w of looseAll) { const g = ensure(ficGroupName(w)); g.loose.push(w); g.items.push(w); }
  for (const s of seriesByKey.values()) {
    s.items.sort((a, b) => (a.ao3SeriesIndex ?? 1e9) - (b.ao3SeriesIndex ?? 1e9) || (a.title || '').localeCompare(b.title || ''));
    if (s.items.length < 2) { const w = s.items[0]; const g = ensure(ficGroupName(w)); g.loose.push(w); g.items.push(w); continue; }
    const g = ensure(ficGroupName(s.items[0]));
    g.series.push(s); g.items.push(...s.items);
  }
  const groups = [...byFandom.values()];
  for (const g of groups) {
    g.loose = sortWorks(g.loose, sort, lastRead);
    g.series.sort((a, b) => a.name.localeCompare(b.name));
  }
  orderGroups(groups, sort, lastRead);
  return groups;
}

// Library search + advanced tag filter. query matches title/author/fandom/tags;
// include = must carry ALL; exclude = must carry NONE.
export function filterWorks(works, { query = '', include = [], exclude = [] } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const inc = (include || []).map((t) => String(t).toLowerCase());
  const exc = (exclude || []).map((t) => String(t).toLowerCase());
  if (!q && !inc.length && !exc.length) return [...(works || [])];
  return (works || []).filter((w) => {
    if (q) {
      const inText = [w.title, w.customTitle, w.author, w.fandom, w.pairing].some((s) => (s || '').toLowerCase().includes(q));
      if (!inText && !workTagSet(w).some((t) => t.includes(q))) return false;
    }
    if (inc.length || exc.length) {
      const set = workTagSet(w);
      if (inc.length && !inc.every((t) => set.includes(t))) return false;
      if (exc.length && exc.some((t) => set.includes(t))) return false;
    }
    return true;
  });
}

// What's New "Saved" type bucket for a work: AO3 / Stories (RR+SH+link) / Books.
export function savedTypeOf(w) {
  return (w.origin === 'upload' || w.source === 'upload' || w.source === 'books')
    ? 'books' : w.source === 'ao3' ? 'ao3' : 'stories';
}

// Global discovery filter predicate: drop a match if it carries a globally
// excluded tag, or (for non-language groups) if a preferred-language allowlist is
// set and the match isn't in one. Excluded tags compare by name; match tags are
// {t,k} (or {name}/string). Returns true = keep.
export function passesGlobalPrefs(work, { excludedTags = [], languages = [] } = {}, isLanguageGroup = false) {
  const norm = (t) => ((t && (t.name ?? t.t)) ?? t ?? '').toString().toLowerCase();
  const exclSet = new Set((excludedTags || []).map(norm).filter(Boolean));
  const langSet = new Set((languages || []).flatMap((l) => [l && l.native, l && l.english].filter(Boolean).map((s) => s.toLowerCase())));
  if (exclSet.size && (work.tags || []).some((t) => exclSet.has(norm(t)))) return false;
  if (!isLanguageGroup && langSet.size && work.language && !langSet.has(work.language.toLowerCase())) return false;
  return true;
}

// Which Discovery shelf a tracked group's source belongs to. Discovery filters
// are scoped per shelf: AO3 → 'ao3', Royal Road / Scribble Hub → 'sites'
// (Stories), Books → 'books'.
export function discoveryShelfForSource(source) {
  return (source === 'books' || source === 'romanceio') ? 'books' : source === 'ao3' ? 'ao3' : 'sites';
}

// The globally-excluded tags for one Discovery shelf. Accepts the per-shelf
// object ({ao3,sites,books}) and the legacy flat array (treated as AO3-only,
// since the old single global filter only applied to AO3 discovery).
export function excludedForShelf(prefs, shelf) {
  const e = prefs && prefs.excludedTags;
  if (Array.isArray(e)) return shelf === 'ao3' ? e : [];
  if (e && typeof e === 'object') return Array.isArray(e[shelf]) ? e[shelf] : [];
  return [];
}

// Discovery completion-status predicate. status 'all' matches everything;
// 'complete'/'ongoing' match the work's own completion.
export function statusMatches(work, status) {
  if (status !== 'ongoing' && status !== 'complete') return true;
  const isComplete = ((work && work.status) || '').toLowerCase() === 'complete';
  return isComplete === (status === 'complete');
}

// Downloaded works of an AO3 series, in reading order (operates on mapped works).
export function seriesWorksFrom(works, ao3SeriesId) {
  if (!ao3SeriesId) return [];
  return (works || [])
    .filter((w) => (w.ao3SeriesId || '') === String(ao3SeriesId))
    .sort((a, b) => (a.ao3SeriesIndex ?? 1e9) - (b.ao3SeriesIndex ?? 1e9) || (a.title || '').localeCompare(b.title || ''));
}

// Saved-from-Discovery works (origin 'tag'), newest first (operates on mapped works).
export function savedWorksFrom(works) {
  return (works || [])
    .filter((w) => (w.origin || '') === 'tag')
    .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
}
