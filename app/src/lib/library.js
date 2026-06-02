import { supabase, hasSupabase } from './supabase.js';

// Map a Supabase `works` row (snake_case) to the shape the UI expects.
function mapWork(row) {
  return {
    id: row.id,
    source: row.source,
    sourceWorkId: row.source_work_id,
    title: row.title,
    author: row.author,
    fandom: row.fandom,
    pairing: row.pairing,
    summary: row.summary,
    tags: Array.isArray(row.tags) ? row.tags : [],
    words: row.words,
    chapters: row.chapters,
    chaptersTotal: row.chapters_total ?? row.chapters,
    status: row.status,
    updated: row.updated_label,
    progress: row.progress,
    lastChapter: row.last_chapter,
    palette: row.palette,
    frozen: row.frozen,
    frozenDate: row.frozen_date,
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
  if (!hasSupabase) return null;
  const { data, error } = await supabase
    .from('chapters')
    .select('*')
    .eq('work_id', workId)
    .order('n', { ascending: true });
  if (error) throw error;
  return (data || []).map(mapChapter);
}
