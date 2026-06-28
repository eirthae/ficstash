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
