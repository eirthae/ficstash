import { supabase, hasSupabase } from './supabase.js';
import { hashStr, COVER_PALETTES } from '../data/sample.js';

// ============================================================================
// Tracked tag groups — the one part of the app that writes to Supabase.
// A "group" is one or more AO3 tags tracked together (match_mode 'all' = a work
// must carry EVERY tag; 'any' = at least one). tracked_groups is anon-writable;
// tag_matches is filled by the worker and the app only reads it (plus flipping
// the per-match "seen" flag to clear the fresh badges).
// ============================================================================

function paletteIndexFor(seed) {
  return hashStr(seed || '') % COVER_PALETTES.length;
}

// tracked_groups row → TagTile shape, with live counts folded in.
function mapGroup(g, counts = { total: 0, fresh: 0 }) {
  const tags = Array.isArray(g.tags) ? g.tags : [];
  const names = tags.map((t) => t.name).filter(Boolean);
  const name = g.label || names.join(' + ') || 'Untitled group';
  const kind = tags.length === 1 ? tags[0].kind || 'freeform' : 'group';
  return {
    id: g.id,
    name,
    label: g.label || '',
    tags,
    names,
    matchMode: g.match_mode || 'all',
    kind,
    count: counts.total,
    fresh: counts.fresh,
    palette: g.palette ?? 0,
  };
}

// tag_matches row → the "work" shape SuggestionCard expects.
function mapMatch(row) {
  return {
    id: row.id,
    matchId: row.id,
    source: row.source,
    sourceWorkId: row.source_work_id,
    title: row.title,
    author: row.author,
    fandom: row.fandom,
    summary: row.summary,
    tags: Array.isArray(row.tags) ? row.tags : [],
    words: row.words,
    chapters: row.chapters,
    status: row.status,
    palette: row.palette,
    seen: row.seen,
    fresh: !row.seen,
  };
}

export async function fetchTrackedGroups() {
  if (!hasSupabase) return null; // not configured → caller falls back to sample
  const { data: groups, error } = await supabase
    .from('tracked_groups')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;

  // One extra read to tally total/fresh matches per group, client-side.
  const { data: matches, error: mErr } = await supabase
    .from('tag_matches')
    .select('group_id,seen');
  if (mErr) throw mErr;

  const counts = {};
  for (const m of matches || []) {
    const c = counts[m.group_id] || (counts[m.group_id] = { total: 0, fresh: 0 });
    c.total += 1;
    if (!m.seen) c.fresh += 1;
  }
  return (groups || []).map((g) => mapGroup(g, counts[g.id]));
}

export async function createGroup({ label = '', tags, matchMode = 'all' }) {
  if (!hasSupabase) throw new Error('Supabase not configured');
  const clean = (tags || [])
    .map((t) => ({ name: t.name, id: t.id ?? '', kind: t.kind || 'freeform' }))
    .filter((t) => t.name);
  if (!clean.length) throw new Error('A group needs at least one tag');
  const seed = label || clean.map((t) => t.name).join(' + ');
  const { data, error } = await supabase
    .from('tracked_groups')
    .insert({
      label,
      tags: clean,
      match_mode: matchMode === 'any' ? 'any' : 'all',
      palette: paletteIndexFor(seed),
    })
    .select()
    .single();
  if (error) throw error;
  return mapGroup(data);
}

export async function deleteGroup(id) {
  if (!hasSupabase) return;
  const { error } = await supabase.from('tracked_groups').delete().eq('id', id);
  if (error) throw error;
}

export async function fetchMatches(groupId) {
  if (!hasSupabase) return null;
  const { data, error } = await supabase
    .from('tag_matches')
    .select('*')
    .eq('group_id', groupId)
    .order('first_seen_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapMatch);
}

// Flip a single match to "seen" (used when the user dismisses one suggestion).
export async function markMatchSeen(matchId) {
  if (!hasSupabase) return;
  const { error } = await supabase
    .from('tag_matches')
    .update({ seen: true })
    .eq('id', matchId);
  if (error) throw error;
}

// Mark every fresh match in a group as seen and stamp the group as viewed.
export async function markGroupSeen(groupId) {
  if (!hasSupabase) return;
  const { error } = await supabase
    .from('tag_matches')
    .update({ seen: true })
    .eq('group_id', groupId)
    .eq('seen', false);
  if (error) throw error;
  await supabase
    .from('tracked_groups')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', groupId);
}

// Day bucket + relative time used by the What's New feed.
function dayBucket(iso) {
  if (!iso) return { day: 'This week', time: '' };
  const then = new Date(iso);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diffDays = Math.floor((startOfToday - new Date(then.getFullYear(), then.getMonth(), then.getDate())) / 86400000);
  const day = diffDays <= 0 ? 'Today' : diffDays === 1 ? 'Yesterday' : 'This week';
  const secs = Math.max((now - then) / 1000, 0);
  let time;
  if (secs < 3600) time = `${Math.max(1, Math.floor(secs / 60))}m ago`;
  else if (secs < 86400) time = `${Math.floor(secs / 3600)}h ago`;
  else time = `${Math.floor(secs / 86400)}d ago`;
  return { day, time };
}

// Fresh (unseen) matches across every group, for the What's New "matches" tab.
export async function fetchNewMatches() {
  if (!hasSupabase) return null;
  const { data: groups, error: gErr } = await supabase
    .from('tracked_groups')
    .select('id,label,tags');
  if (gErr) throw gErr;
  const labelById = {};
  for (const g of groups || []) {
    const names = (Array.isArray(g.tags) ? g.tags : []).map((t) => t.name).filter(Boolean);
    labelById[g.id] = g.label || names.join(' + ') || 'Tracked tag';
  }

  const { data, error } = await supabase
    .from('tag_matches')
    .select('*')
    .eq('seen', false)
    .order('first_seen_at', { ascending: false });
  if (error) throw error;

  return (data || []).map((row) => {
    const { day, time } = dayBucket(row.first_seen_at);
    return {
      id: row.id,
      matchId: row.id,
      day,
      time,
      tag: labelById[row.group_id] || 'Tracked tag',
      title: row.title,
      author: row.author,
      fandom: row.fandom,
      summary: row.summary,
      tags: Array.isArray(row.tags) ? row.tags : [],
      words: row.words,
      chapters: row.chapters,
      status: row.status,
      palette: row.palette,
      sourceWorkId: row.source_work_id,
    };
  });
}

// Live AO3 tag suggestions via the tag-autocomplete edge function.
export async function autocompleteTags(term) {
  const t = (term || '').trim();
  if (!hasSupabase || t.length < 2) return [];
  const { data, error } = await supabase.functions.invoke('tag-autocomplete', {
    body: { term: t },
  });
  if (error) throw error;
  return (data?.tags || [])
    .map((x) => ({ name: x.name, id: x.id ?? '', kind: x.kind || 'freeform' }))
    .filter((x) => x.name);
}
