import { hashStr, COVER_PALETTES } from '../data/sample.js';

// Pure builders for the rows the on-device engine writes to Supabase — kept free
// of supabase.js / native imports so node --test can pin the exact column shapes
// (they must match what the worker writes, or cloud rows render wrong).

export function paletteFor(seed) {
  return hashStr(seed || '') % COVER_PALETTES.length;
}

// Normalize a mapGroup() shape OR a raw tracked_groups row into discovery fields.
export function normGroup(g) {
  const tags = Array.isArray(g.tags) ? g.tags : [];
  const langTag = tags.find((t) => t && t.kind === 'language');
  const include = tags.filter((t) => !t || t.kind !== 'language').map((t) => t && t.name).filter(Boolean);
  const excluded = (g.excludedTags || g.excluded_tags || []).map((t) => (t && t.name) || '').filter(Boolean);
  return {
    id: g.id,
    source: g.source || 'ao3',
    matchMode: g.matchMode || g.match_mode || 'all',
    status: g.status || 'all',
    label: g.label || '',
    langCode: langTag ? (langTag.id || langTag.name) : null,
    include,
    excluded,
  };
}

// A discovered work (parseSearchResults shape) → a tag_matches row. Worker's exact
// shape minus seen/first_seen_at/dismissed/later, so DB defaults apply and prior
// user state survives re-runs (PostgREST also needs every row in a batch to share
// keys, so the omission must be uniform).
export function matchRow(groupId, m) {
  return {
    group_id: groupId,
    source: 'ao3',
    source_work_id: String(m.sourceId),
    title: m.title || 'Untitled',
    author: m.author || '',
    fandom: m.fandom || '',
    summary: m.summary || '',
    tags: Array.isArray(m.tags) ? m.tags : [],
    words: m.words || 0,
    chapters: m.chapters ?? null,
    status: m.status || 'ongoing',
    source_updated: null,
    palette: paletteFor(m.fandom || m.title),
  };
}

// A parsed full work (parseWork shape) → a works row (worker's upsert_work shape).
export function workRow(parsed, origin) {
  const row = {
    source: 'ao3',
    source_work_id: String(parsed.sourceId),
    title: parsed.title,
    author: parsed.author || '',
    fandom: parsed.fandom || '',
    pairing: '',
    summary: parsed.summary || '',
    tags: Array.isArray(parsed.tags) ? parsed.tags : [],
    words: parsed.words || 0,
    chapters: parsed.chapters || 0,
    chapters_total: parsed.chaptersTotal ?? null,
    status: parsed.status || 'ongoing',
    palette: paletteFor(parsed.fandom || parsed.title),
    follow: parsed.status !== 'complete',
    offline: true,
    hidden: false,
  };
  if (origin) row.origin = origin;
  if (parsed.ao3SeriesId) {
    row.ao3_series_id = parsed.ao3SeriesId;
    row.ao3_series_name = parsed.series || '';
    if (parsed.seriesIndex != null) row.ao3_series_index = parsed.seriesIndex;
  }
  return row;
}

// Parsed chapters → chapters rows (worker's upsert_chapters shape). `fetched` is
// gated on real text so an empty/gated fetch never reads as a downloaded chapter.
export function chapterRows(workId, chaptersData) {
  return (chaptersData || []).map((c) => ({
    work_id: workId,
    n: c.n,
    title: c.title || `Chapter ${c.n}`,
    words: c.words || 0,
    content: c.content || '',
    fetched: !!(c.content && c.content.trim()),
  }));
}

// ---- refresh (new chapters on an ongoing work) -----------------------------

// The chapters of a freshly re-fetched work that are NEW vs what we already have
// stored (chapter n beyond the stored count). Drives "getting new chapters".
export function newChapters(storedCount, parsedWork) {
  const stored = Math.max(0, Number(storedCount) || 0);
  const all = (parsedWork && parsedWork.chaptersData) || [];
  return all.filter((c) => c && c.n > stored);
}

// New chapters → chapter_updates rows (the "New chapters" feed), worker shape.
// `work` carries the stored work's id + source_work_id (the feed joins back to it).
export function chapterUpdateRows(work, newChs) {
  return (newChs || []).map((c) => ({
    work_id: work.id,
    source: work.source || 'ao3',
    source_work_id: String(work.source_work_id ?? work.sourceWorkId ?? ''),
    chapter_n: c.n,
    title: c.title || `Chapter ${c.n}`,
    words: c.words || 0,
  }));
}

// ---- series (download-all / new works in a followed series) ----------------

// Decide what to fetch for a series: given its works in order [{id,title}] and the
// set of source_work_ids already in the library, split into what we already have
// (re-tagged with their series index) and what to fetch (capped for politeness).
// Drives both "download all works in series" and "a new work added to a series".
export function seriesFetchPlan(seriesList, existingIds, cap = 12) {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds || []);
  const have = [];
  const toFetch = [];
  let hitCap = false;
  (seriesList || []).forEach((w, i) => {
    if (!w || !w.id) return;
    const entry = { id: String(w.id), index: i + 1, title: w.title || '' };
    if (existing.has(entry.id)) { have.push(entry); return; }
    if (toFetch.length >= cap) { hitCap = true; return; }
    toFetch.push(entry);
  });
  return { toFetch, have, hitCap };
}
