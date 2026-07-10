import { supabase, hasSupabase } from './supabase.js';
import { hashStr, COVER_PALETTES } from '../data/sample.js';
import { fetchJson } from './fetch.js';
import { discoverGroup, saveMatchNow } from './ondevice.js';
import { kickSave } from './sync.js';

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
  const excludedTags = Array.isArray(g.excluded_tags) ? g.excluded_tags : [];
  const names = tags.map((t) => t.name).filter(Boolean);
  const name = g.label || names.join(' + ') || 'Untitled group';
  // A "Browse by language" group is a single tag with kind 'language' whose id
  // is AO3's language_id code; the worker searches it by language, not by tags.
  const langTag = tags.find((t) => t.kind === 'language');
  const kind = langTag ? 'language' : tags.length === 1 ? tags[0].kind || 'freeform' : 'group';
  return {
    id: g.id,
    name,
    label: g.label || '',
    source: g.source || 'ao3',
    tags,
    names,
    excludedTags,
    excludedNames: excludedTags.map((t) => t.name).filter(Boolean),
    matchMode: g.match_mode || 'all',
    status: g.status || 'all', // 'all' | 'ongoing' | 'complete' (completion filter)
    kind,
    language: langTag ? langTag.id || langTag.name : null,
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
    wanted: !!row.wanted,
    saved: !!row.saved,
    dismissed: !!row.dismissed,
    later: !!row.later,
  };
}

// "Save to library" = download the work NOW, on-device (residential IP), and
// store it in Supabase. We still set wanted=true first so the worker remains a
// fallback (and handles non-AO3 sources) if the on-device fetch misses.
export async function requestSave(matchId) {
  if (!hasSupabase) return;
  // maybeSingle (not single): an update that matches no row must NOT throw — the
  // old requestSave was a silent no-op there, and a throw would make a save fail
  // silently ("not appearing"). null data → fall through to the worker kick.
  const { data, error } = await supabase
    .from('tag_matches')
    .update({ wanted: true, seen: true })
    .eq('id', matchId)
    .select('source, source_work_id')
    .maybeSingle();
  if (error) throw error;
  if (data && data.source === 'ao3' && data.source_work_id) {
    saveMatchNow(data.source_work_id).catch(() => {}); // on-device (residential IP)
  } else {
    kickSave().catch(() => {}); // non-AO3 (Royal Road, …) or unresolved → worker
  }
}

export async function fetchTrackedGroups() {
  if (!hasSupabase) return null; // not configured → caller falls back to sample
  const { data: groups, error } = await supabase
    .from('tracked_groups')
    .select('*')
    .order('created_at', { ascending: true });
  if (error) throw error;

  // One extra read to tally total/fresh matches per group, client-side. The
  // tally must match what opening the group actually shows (see fetchMatches):
  // dismissed (hidden), saved (already in the library), and later (moved to the
  // Later stash) matches all drop out of the feed, so they don't count here —
  // otherwise a group reads "12 tracked" but opens to 2.
  // Page through ALL matches — a single select is capped at PostgREST's 1000-row
  // default, so a big library silently under-counted every tile. We .range() until
  // a short page comes back, so the per-group tally is complete.
  const counts = {};
  const PAGE = 1000;
  for (let start = 0; ; start += PAGE) {
    const { data: page, error: mErr } = await supabase
      .from('tag_matches')
      .select('group_id,seen,dismissed,saved,later')
      .range(start, start + PAGE - 1);
    if (mErr) throw mErr;
    for (const m of page || []) {
      if (m.dismissed || m.saved || m.later) continue;
      const c = counts[m.group_id] || (counts[m.group_id] = { total: 0, fresh: 0 });
      c.total += 1;
      if (!m.seen) c.fresh += 1;
    }
    if (!page || page.length < PAGE) break;
  }
  return (groups || []).map((g) => mapGroup(g, counts[g.id]));
}

export async function createGroup({ label = '', tags, excludedTags = [], matchMode = 'all', source = 'ao3', status = 'all' }) {
  if (!hasSupabase) throw new Error('Supabase not configured');
  const cleanTags = (list) => (list || [])
    .map((t) => ({ name: t.name, id: t.id ?? '', kind: t.kind || 'freeform' }))
    .filter((t) => t.name);
  const clean = cleanTags(tags);
  const excluded = cleanTags(excludedTags);
  if (!clean.length) throw new Error('A group needs at least one tag');
  const seed = label || clean.map((t) => t.name).join(' + ');
  const { data, error } = await supabase
    .from('tracked_groups')
    .insert({
      label,
      source,
      tags: clean,
      excluded_tags: excluded,
      match_mode: matchMode === 'any' ? 'any' : 'all',
      status: ['ongoing', 'complete'].includes(status) ? status : 'all',
      palette: paletteIndexFor(seed),
    })
    .select()
    .single();
  if (error) throw error;
  // Discover its matches now, on-device, so the new tile opens populated (the
  // BookStash "instant results" feel). Best-effort — never fail group creation.
  try { await discoverGroup(data); } catch (e) { /* discovery is best-effort */ }
  return mapGroup(data);
}

// Start a "Browse by language" group: one kind:'language' tag whose id is AO3's
// language_id code (e.g. 'hy' Armenian). The worker fills tag_matches via a
// language search, so it reuses the whole save/dismiss flow tag groups use.
export async function createLanguageGroup({ code, name, label = '' }) {
  if (!hasSupabase) throw new Error('Supabase not configured');
  if (!code) throw new Error('A language needs a code');
  const { data, error } = await supabase
    .from('tracked_groups')
    .insert({
      label: label || name || code,
      tags: [{ name: name || code, id: code, kind: 'language' }],
      match_mode: 'all',
      palette: paletteIndexFor(code),
    })
    .select()
    .single();
  if (error) throw error;
  try { await discoverGroup(data); } catch (e) { /* discovery is best-effort */ }
  return mapGroup(data);
}

// Append a tag to an existing tracked group (from a tappable tag in a fic's
// detail page). No-op if the group already carries a tag with the same name.
export async function addTagToGroup(groupId, tag) {
  if (!hasSupabase) throw new Error('Supabase not configured');
  const t = { name: tag.name, id: tag.id ?? '', kind: tag.kind || 'freeform' };
  if (!t.name) throw new Error('Tag needs a name');
  const { data, error } = await supabase
    .from('tracked_groups')
    .select('tags')
    .eq('id', groupId)
    .single();
  if (error) throw error;
  const existing = Array.isArray(data.tags) ? data.tags : [];
  if (existing.some((x) => (x.name || '').toLowerCase() === t.name.toLowerCase())) return;
  const { error: uErr } = await supabase
    .from('tracked_groups')
    .update({ tags: [...existing, t] })
    .eq('id', groupId);
  if (uErr) throw uErr;
}

export async function deleteGroup(id) {
  if (!hasSupabase) return;
  const { error } = await supabase.from('tracked_groups').delete().eq('id', id);
  if (error) throw error;
}

// Edit an existing tag group: replace its tags / excludes / status / match mode,
// then RESET its discovery — drop the matches it found under the old rules and
// null `last_checked` so the worker re-seeds the back-catalogue against the new
// criteria on the next sync (a changed include/exclude set means old matches may
// no longer fit). `source` is fixed (the tag vocabularies differ per source).
export async function updateGroup(groupId, { label = '', tags, excludedTags = [], matchMode = 'all', status = 'all' }) {
  if (!hasSupabase) throw new Error('Supabase not configured');
  const cleanTags = (list) => (list || [])
    .map((t) => ({ name: t.name, id: t.id ?? '', kind: t.kind || 'freeform' }))
    .filter((t) => t.name);
  const clean = cleanTags(tags);
  if (!clean.length) throw new Error('A group needs at least one tag');
  const { data, error } = await supabase
    .from('tracked_groups')
    .update({
      label,
      tags: clean,
      excluded_tags: cleanTags(excludedTags),
      match_mode: matchMode === 'any' ? 'any' : 'all',
      status: ['ongoing', 'complete'].includes(status) ? status : 'all',
      last_checked: null,
    })
    .eq('id', groupId)
    .select()
    .single();
  if (error) throw error;
  await supabase.from('tag_matches').delete().eq('group_id', groupId);
  // Re-discover against the new criteria, on-device, so the tile refills now.
  try { await discoverGroup(data); } catch (e) { /* discovery is best-effort */ }
  return mapGroup(data);
}

export async function fetchMatches(groupId) {
  if (!hasSupabase) return null;
  const { data, error } = await supabase
    .from('tag_matches')
    .select('*')
    .eq('group_id', groupId)
    .eq('dismissed', false)
    .eq('saved', false)
    .eq('later', false)
    .order('first_seen_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapMatch);
}

// Swipe LEFT = "Later": keep the match's blurb/tags but don't download it. It
// drops out of the group feed and What's New and shows up in the Later stash,
// where the user can still Save it, dismiss it, or put it back.
export async function markLater(matchId) {
  if (!hasSupabase) return;
  const { error } = await supabase
    .from('tag_matches')
    .update({ later: true, seen: true })
    .eq('id', matchId);
  if (error) throw error;
}

// Take a match back out of the Later stash (returns it to its group feed).
export async function unmarkLater(matchId) {
  if (!hasSupabase) return;
  const { error } = await supabase
    .from('tag_matches')
    .update({ later: false })
    .eq('id', matchId);
  if (error) throw error;
}

// Everything in the Later stash: kept (later), not yet saved, not dismissed.
export async function fetchLaterMatches() {
  if (!hasSupabase) return null;
  const { data, error } = await supabase
    .from('tag_matches')
    .select('*')
    .eq('later', true)
    .eq('saved', false)
    .eq('dismissed', false)
    .order('first_seen_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(mapMatch);
}

// Flip a single match to "seen" (clears its fresh badge, e.g. on open).
export async function markMatchSeen(matchId) {
  if (!hasSupabase) return;
  const { error } = await supabase
    .from('tag_matches')
    .update({ seen: true })
    .eq('id', matchId);
  if (error) throw error;
}

// Permanently hide a match — the user dropped it. Distinct from `seen`: a
// dismissed work is filtered out of group results and the What's New feed and
// stays gone across reloads and worker re-runs.
export async function dismissMatch(matchId) {
  if (!hasSupabase) return;
  // A dismissal is GLOBAL: hide this work under every tracked tag, not just this
  // one — a work that also matches another tag shouldn't reappear there once you
  // swipe it away. Look up the work, then dismiss all its match rows. (The worker
  // also propagates this each sync, so older duplicates get cleaned up too.)
  const { data: row } = await supabase
    .from('tag_matches').select('source,source_work_id').eq('id', matchId).maybeSingle();
  const q = supabase.from('tag_matches').update({ dismissed: true, seen: true });
  const { error } = row?.source_work_id
    ? await q.eq('source', row.source).eq('source_work_id', row.source_work_id)
    : await q.eq('id', matchId);
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
    .eq('dismissed', false)
    .eq('later', false)
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
      wanted: !!row.wanted,
      saved: !!row.saved,
    };
  });
}

// The "New chapters" feed: chapters the refresh pass appended to ongoing works
// you already had offline. These are real, downloaded chapters (so they open
// immediately), joined with their work for the reader. Newest-first.
export async function fetchNewChapters() {
  if (!hasSupabase) return null; // not configured → caller uses sample data
  const { data, error } = await supabase
    .from('chapter_updates')
    .select('*, works(*)')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) throw error;
  return (data || [])
    .filter((row) => row.works && !row.works.hidden)
    .map((row) => {
      const w = row.works || {};
      const { day, time } = dayBucket(row.created_at);
      return {
        id: row.id,
        workId: row.work_id,
        chapterN: row.chapter_n,
        chapter: row.title || `Chapter ${row.chapter_n}`,
        title: w.title || '',
        fandom: w.fandom || '',
        words: row.words || 0,
        day,
        time,
        fresh: !row.seen,
        fetched: true, // refresh pass already downloaded these
        work: {
          id: w.id, source: w.source, sourceWorkId: w.source_work_id, sourceUrl: w.source_url || '',
          title: w.title, author: w.author, fandom: w.fandom, summary: w.summary,
          tags: Array.isArray(w.tags) ? w.tags : [], words: w.words, chapters: w.chapters,
          chaptersTotal: w.chapters_total ?? null, status: w.status, palette: w.palette,
          offline: w.offline, lastChapter: w.last_chapter, progress: w.progress, origin: w.origin,
        },
      };
    });
}

export async function markChapterUpdateSeen(id) {
  if (!hasSupabase || !id) return;
  const { error } = await supabase.from('chapter_updates').update({ seen: true }).eq('id', id);
  if (error) throw error;
}

// Live AO3 tag suggestions — call AO3's autocomplete JSON directly from the
// device (native HTTP), like BookStash. No Supabase proxy. On failure returns []
// and the picker's "Add what you typed" fallback still lets you track any tag.
export async function autocompleteTags(term) {
  const q = (term || '').trim();
  if (q.length < 2) return [];
  try {
    const url = `https://archiveofourown.org/autocomplete/tag?term=${encodeURIComponent(q)}`;
    const r = await fetchJson(url);
    if (!r || r.status < 200 || r.status >= 300 || !Array.isArray(r.data)) return [];
    return r.data
      .map((d) => (typeof d === 'string' ? d : ((d && (d.name ?? d.id)) || '')))
      .filter(Boolean)
      .map((n) => ({ name: n, id: '', kind: 'freeform' }));
  } catch (e) {
    return [];
  }
}
