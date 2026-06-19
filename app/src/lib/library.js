import { supabase, hasSupabase } from './supabase.js';
import { DEMO_CHAPTERS } from '../data/sample.js';

// Map a Supabase `works` row (snake_case) to the shape the UI expects.
function mapWork(row) {
  return {
    id: row.id,
    source: row.source,
    sourceWorkId: row.source_work_id,
    sourceUrl: row.source_url || '',
    origin: row.origin || 'bookmark',
    follow: !!row.follow,
    createdAt: row.created_at,        // when it entered the library (for "Last added")
    sourceUpdated: row.source_updated, // real last-updated time (for "Last updated")
    title: row.title,
    customTitle: row.custom_title || '',  // user rename override (Books)
    seriesName: row.series_name || '',    // manual/auto series grouping (Books)
    seriesIndex: row.series_index,        // reading order within the series
    externalUrl: row.external_url || '',  // user-set open-at-source link
    ao3SeriesId: row.ao3_series_id || '',     // AO3 series this work belongs to
    ao3SeriesName: row.ao3_series_name || '', // for auto-grouping the Fics shelf
    ao3SeriesIndex: row.ao3_series_index,     // part # within the AO3 series
    author: row.author,
    fandom: row.fandom,
    pairing: row.pairing,
    summary: row.summary,
    tags: Array.isArray(row.tags) ? row.tags : [],
    words: row.words,
    chapters: row.chapters,
    chaptersTotal: row.chapters_total ?? null, // null = AO3 "/?" unknown end; never fall back to the chapter count (reads as complete)
    status: row.status,
    updated: row.updated_label,
    progress: row.progress,
    lastChapter: row.last_chapter,
    palette: row.palette,
    frozen: row.frozen,
    frozenDate: row.frozen_date,
    restricted: !!row.restricted, // AO3 members-only work the guest worker can't fetch
    workSkin: row.work_skin || '', // AO3 work-skin CSS (chat/texting styling), sanitized at render
    unread: row.unread,
    offline: row.offline,
    bookmarked: row.bookmarked,
    subscribed: row.subscribed,
    inHistory: row.in_history,
    historyReadAt: row.history_read_at,
  };
}

function mapChapter(row) {
  return {
    n: row.n,
    title: row.title,
    words: row.words,
    content: row.content,
    state: row.fetched ? 'done' : 'idle',
  };
}

export async function fetchWorks() {
  if (!hasSupabase) return null; // signal: not configured → caller uses sample data
  const { data, error } = await supabase
    .from('works')
    .select('*')
    .eq('hidden', false)
    .order('source_updated', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return (data || []).map(mapWork);
}

// Day bucket for the What's New feeds (Today / Yesterday / This week + "Xh ago").
function dayBucketLocal(iso) {
  if (!iso) return { day: 'This week', time: '' };
  const then = new Date(iso); const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((startOfToday - new Date(then.getFullYear(), then.getMonth(), then.getDate())) / 86400000);
  const day = diffDays <= 0 ? 'Today' : diffDays === 1 ? 'Yesterday' : 'This week';
  const secs = Math.max((now - then) / 1000, 0);
  const time = secs < 3600 ? `${Math.max(1, Math.floor(secs / 60))}m ago` : secs < 86400 ? `${Math.floor(secs / 3600)}h ago` : `${Math.floor(secs / 86400)}d ago`;
  return { day, time };
}

// Works the user SAVED from Discovery that have actually been fetched into the
// library (origin 'tag'). This is the "Saved" feed in What's New — the things
// you chose, now downloaded — not the raw discovery match stream.
export async function fetchSavedWorks() {
  if (!hasSupabase) return null;
  const { data, error } = await supabase
    .from('works')
    .select('*')
    .eq('hidden', false)
    .in('origin', ['tag', 'link', 'upload']) // recently-added works, however added
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data || []).map((row) => {
    const w = mapWork(row);
    const { day, time } = dayBucketLocal(row.created_at);
    return { ...w, day, time, fresh: !!w.unread };
  });
}

// All downloaded works belonging to an AO3 series, in reading order (part #).
// Powers the Series screen and the reader's prev/next-in-series navigation.
export async function fetchSeriesWorks(ao3SeriesId) {
  if (!hasSupabase || !ao3SeriesId) return [];
  const { data, error } = await supabase
    .from('works')
    .select('*')
    .eq('ao3_series_id', String(ao3SeriesId))
    .eq('hidden', false);
  if (error) throw error;
  return (data || [])
    .map(mapWork)
    .sort((a, b) => (a.ao3SeriesIndex ?? 1e9) - (b.ao3SeriesIndex ?? 1e9) || (a.title || '').localeCompare(b.title || ''));
}

// "Remove from library" = hide the work. We don't hard-delete: the work may
// still be bookmarked on AO3, and a delete would just reappear on the next sync.
// Setting hidden=true is durable — the app filters it out and the worker skips
// re-adding it. Reading state and the downloaded copy stay in the DB untouched.
export async function removeWork(workId) {
  if (!hasSupabase) return;
  const { error } = await supabase
    .from('works')
    .update({ hidden: true })
    .eq('id', workId);
  if (error) throw error;
}

// Distinct series/collection names already in the library, for autocompleting
// the series field so books slot into an existing collection (no retyping/typos).
export async function fetchSeriesNames() {
  if (!hasSupabase) return [];
  const { data, error } = await supabase
    .from('works')
    .select('series_name')
    .not('series_name', 'is', null)
    .eq('hidden', false);
  if (error) return [];
  const set = new Set();
  for (const r of data || []) { const s = (r.series_name || '').trim(); if (s) set.add(s); }
  return [...set].sort((a, b) => a.localeCompare(b));
}

// Edit Books-shelf fields the app owns: custom title (rename), series name +
// reading-order index (manual grouping), and an external "open at source" link.
// Only these columns are writable here; pass undefined to leave one unchanged.
export async function updateWorkFields(workId, fields) {
  if (!hasSupabase) return;
  const allowed = ['custom_title', 'series_name', 'series_index', 'external_url'];
  const patch = {};
  for (const k of allowed) if (fields[k] !== undefined) patch[k] = fields[k];
  if (!Object.keys(patch).length) return;
  const { error } = await supabase.from('works').update(patch).eq('id', workId);
  if (error) throw error;
}

// Live offline-library tally: how many works have full text stored (offline)
// vs the total tracked. Two head-only count queries, no rows transferred.
export async function fetchOfflineStats() {
  if (!hasSupabase) return null;
  const total = await supabase
    .from('works')
    .select('*', { count: 'exact', head: true })
    .eq('hidden', false);
  if (total.error) throw total.error;
  const dl = await supabase
    .from('works')
    .select('*', { count: 'exact', head: true })
    .eq('hidden', false)
    .eq('offline', true);
  if (dl.error) throw dl.error;
  return { downloaded: dl.count ?? 0, total: total.count ?? 0 };
}

export async function fetchChapters(workId) {
  if (!hasSupabase) return DEMO_CHAPTERS[workId] || null; // demo preview (e.g. the chatfic)
  const { data, error } = await supabase
    .from('chapters')
    .select('*')
    .eq('work_id', workId)
    .order('n', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapChapter);
}
