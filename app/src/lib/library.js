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
    .order('source_updated', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return (data || []).map(mapWork);
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
