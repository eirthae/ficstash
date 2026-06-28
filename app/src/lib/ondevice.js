import { supabase, hasSupabase } from './supabase.js';
import { searchTags, searchLanguage, fetchWork, isAo3Url, workIdFromUrl } from './sources/ao3.js';
import { statusMatches, passesGlobalPrefs, excludedForShelf } from './shelving.js';
import { normGroup, matchRow, workRow, chapterRows } from './ondevice-pure.js';

// ============================================================================
// On-device sync engine — FicStash's answer to "AO3 blocks our servers."
//
// AO3 Cloudflare-525s datacenter IPs (Supabase edge functions, the GitHub
// Actions worker) but answers a residential device. So the AO3 fetch happens
// HERE, on the phone (native HTTP, no login, residential IP), and the results are
// written straight to Supabase — which stays the cloud store, so the library
// still follows you to a new device. This is BookStash's on-device model with
// Supabase as the database instead of local IndexedDB.
//
// v1 covers the two AO3-blocked halves:
//   * discovery — search a tracked group's tags → upsert tag_matches
//   * download  — a tapped Save / pasted AO3 link → fetch the work → works+chapters
// Ongoing-chapter refresh, series and non-AO3 sources stay on the worker (which
// now retries AO3's 525s, see b82a05a) until their own on-device passes land.
//
// Native HTTP only: the AO3 calls work on-device, not in a browser preview (CORS).
// Every Supabase write is is_owner()-gated by RLS (migration 0023). Pure row/
// filter logic lives in ondevice-pure.js + shelving.js (node-tested).
// ============================================================================

const SPACE_MS = 1500; // polite gap between AO3 requests (volunteer nonprofit)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Global discovery prefs (preferred languages + per-shelf excluded tags), mapped
// to the {languages, excludedTags} shape shelving.js expects. Missing → permissive.
async function readPrefs() {
  try {
    const { data } = await supabase
      .from('discovery_prefs')
      .select('languages,excluded_tags')
      .limit(1)
      .maybeSingle();
    return { languages: data?.languages || [], excludedTags: data?.excluded_tags || {} };
  } catch (e) {
    return { languages: [], excludedTags: {} };
  }
}

// ---- discovery -------------------------------------------------------------

// Search AO3 for one group on-device and upsert its matches to Supabase. Returns
// the number of rows written (0 on a miss — and no last_checked burn, since
// on-device always fetches newest, never a date window). AO3-only; other sources
// are skipped (the worker still handles them).
export async function discoverGroup(group, prefs) {
  if (!hasSupabase) return 0;
  const g = normGroup(group);
  if (g.source !== 'ao3') return 0;
  if (!g.langCode && !g.include.length) return 0;
  prefs = prefs || (await readPrefs());

  // Per-group excludes + this shelf's global excludes (deduped), handed to AO3 as
  // excluded_tag_names so it drops them server-side.
  const shelfExcl = excludedForShelf(prefs, 'ao3'); // [{name}|string]
  const excludeNames = [...g.excluded, ...shelfExcl.map((t) => (t && t.name) || t)]
    .filter((n, i, a) => n && a.indexOf(n) === i);

  let metas = [];
  try {
    if (g.langCode) {
      metas = await searchLanguage(g.langCode);
    } else if (g.matchMode === 'any' && g.include.length > 1) {
      for (const t of g.include) { metas.push(...await searchTags([t], excludeNames)); await sleep(800); }
    } else {
      metas = await searchTags(g.include, excludeNames);
    }
  } catch (e) {
    return 0;
  }

  // De-dupe by work id, then the group's completion-status filter + the global
  // language/exclude prefs (language groups are exempt — the search IS the filter).
  const seen = new Set();
  metas = metas.filter((m) => {
    if (!m.sourceId || seen.has(m.sourceId)) return false;
    seen.add(m.sourceId);
    return true;
  });
  metas = metas.filter((m) => statusMatches(m, g.status));
  metas = metas.filter((m) => passesGlobalPrefs(m, { excludedTags: shelfExcl, languages: prefs.languages }, !!g.langCode));

  const rows = metas.map((m) => matchRow(g.id, m));
  if (rows.length) {
    const { error } = await supabase
      .from('tag_matches')
      .upsert(rows, { onConflict: 'group_id,source,source_work_id' });
    if (error) throw error;
  }
  try { await supabase.from('tracked_groups').update({ last_checked: new Date().toISOString() }).eq('id', g.id); } catch (e) {}
  return rows.length;
}

// Discover across every tracked AO3 group (pull-to-refresh / app open / on track).
export async function discoverAll({ onProgress } = {}) {
  if (!hasSupabase) return { newMatches: 0, groups: 0 };
  let groups = [];
  try {
    const { data } = await supabase
      .from('tracked_groups')
      .select('id,label,tags,excluded_tags,match_mode,source,status')
      .order('created_at', { ascending: true });
    groups = data || [];
  } catch (e) { groups = []; }
  const prefs = await readPrefs();
  const aoGroups = groups.filter((g) => (g.source || 'ao3') === 'ao3');
  let newMatches = 0, checked = 0;
  for (const g of aoGroups) {
    if (checked) await sleep(SPACE_MS);
    checked += 1;
    if (onProgress) onProgress({ done: checked, total: aoGroups.length, title: g.label || 'group' });
    try { newMatches += await discoverGroup(g, prefs); } catch (e) { /* non-fatal */ }
  }
  return { newMatches, groups: aoGroups.length };
}

// ---- download (a work → works + chapters) ----------------------------------

// Insert a work's chapters in size-bounded batches so one big/image-heavy work
// doesn't trip Postgres's statement timeout (mirrors the worker's batching).
async function writeChapters(workId, chaptersData) {
  const rows = chapterRows(workId, chaptersData);
  if (!rows.length) return 0;
  const MAX_BATCH = 1_500_000;
  let batch = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const { error } = await supabase.from('chapters').upsert(batch, { onConflict: 'work_id,n' });
    if (error) throw error;
    batch = []; size = 0;
  };
  for (const r of rows) {
    const len = (r.content || '').length;
    if (batch.length && size + len > MAX_BATCH) await flush();
    batch.push(r); size += len;
  }
  await flush();
  return rows.filter((r) => (r.content || '').trim()).length;
}

// Fetch one AO3 work on-device and store it (work + chapters) in Supabase.
// Returns { ok, restricted?, empty?, workId? }. Does NOT mark tag_matches saved —
// the caller decides (a Save marks the match; a link import marks the request).
export async function downloadWork(sourceWorkId, { origin = 'tag' } = {}) {
  if (!hasSupabase) return { ok: false };
  const wid = String(sourceWorkId || '').match(/\d+/)?.[0];
  if (!wid) return { ok: false };
  let parsed;
  try { parsed = await fetchWork(wid); } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  if (parsed && parsed.restricted) return { ok: false, restricted: true };
  if (!parsed || !(parsed.chaptersData || []).some((c) => c.content && c.content.trim())) {
    return { ok: false, empty: true }; // gated/throttled — leave it to retry
  }
  const { data, error } = await supabase
    .from('works')
    .upsert(workRow(parsed, origin), { onConflict: 'source,source_work_id' })
    .select('id')
    .single();
  if (error) throw error;
  await writeChapters(data.id, parsed.chaptersData);
  return { ok: true, workId: data.id };
}

// Flag every tag_matches row for a work as saved (across all groups it matched),
// mirroring the worker's mark_matches_saved.
async function markMatchesSaved(sourceWorkId) {
  try {
    await supabase
      .from('tag_matches')
      .update({ saved: true, wanted: false })
      .eq('source', 'ao3')
      .eq('source_work_id', String(sourceWorkId));
  } catch (e) { /* non-fatal */ }
}

// Save a single AO3 match NOW (a tapped Save), on-device. On success the match
// flips to saved and the work is in the library.
export async function saveMatchNow(sourceWorkId) {
  const r = await downloadWork(sourceWorkId, { origin: 'tag' });
  if (r.ok) await markMatchesSaved(sourceWorkId);
  return r;
}

// Download every wanted-but-unsaved AO3 match on-device (pull-to-refresh).
export async function downloadWanted({ onProgress } = {}) {
  if (!hasSupabase) return { saved: 0, failed: 0 };
  let wanted = [];
  try {
    const { data } = await supabase
      .from('tag_matches')
      .select('source_work_id')
      .eq('source', 'ao3')
      .eq('wanted', true)
      .eq('saved', false);
    wanted = [...new Set((data || []).map((r) => r.source_work_id).filter(Boolean))];
  } catch (e) { wanted = []; }
  let saved = 0, failed = 0, i = 0;
  for (const wid of wanted) {
    if (i) await sleep(SPACE_MS);
    i += 1;
    if (onProgress) onProgress({ done: i, total: wanted.length, title: wid });
    try {
      const r = await saveMatchNow(wid);
      if (r.ok) saved += 1; else failed += 1;
    } catch (e) { failed += 1; }
  }
  return { saved, failed };
}

// ---- AO3 link import (pasted /works/ URL) ----------------------------------

// Fetch any queued AO3 link requests on-device and resolve them (done/restricted,
// or left queued to retry). Non-AO3 requests are left untouched for the worker.
export async function processAo3Links({ onProgress } = {}) {
  if (!hasSupabase) return { done: 0, failed: 0 };
  let reqs = [];
  try {
    const { data } = await supabase
      .from('requested_urls')
      .select('id,url,status')
      .in('status', ['queued', 'error'])
      .order('created_at', { ascending: true });
    reqs = (data || []).filter((r) => isAo3Url(r.url) && workIdFromUrl(r.url));
  } catch (e) { reqs = []; }
  let done = 0, failed = 0, i = 0;
  for (const req of reqs) {
    if (i) await sleep(SPACE_MS);
    i += 1;
    if (onProgress) onProgress({ done: i, total: reqs.length, title: req.url });
    const wid = workIdFromUrl(req.url);
    try {
      await supabase.from('requested_urls').update({ status: 'fetching' }).eq('id', req.id);
      const r = await downloadWork(wid, { origin: 'link' });
      if (r.ok) {
        await supabase.from('requested_urls').update({ status: 'done', source: 'ao3', source_work_id: wid }).eq('id', req.id);
        done += 1;
      } else if (r.restricted) {
        await supabase.from('requested_urls').update({ status: 'restricted', error: 'Restricted to AO3 members — open it on AO3.' }).eq('id', req.id);
        failed += 1;
      } else {
        // empty/throttled → back to queued so it retries next pull
        await supabase.from('requested_urls').update({ status: 'queued' }).eq('id', req.id);
        failed += 1;
      }
    } catch (e) {
      try { await supabase.from('requested_urls').update({ status: 'error', error: String(e && e.message || e).slice(0, 200) }).eq('id', req.id); } catch (_) {}
      failed += 1;
    }
  }
  return { done, failed };
}

// ---- the on-device pull-to-refresh -----------------------------------------
// Discover across all tracked AO3 groups, then fetch any pending AO3 links and
// wanted saves — all on the phone, written to Supabase. Returns a small summary.
export async function runSync({ onProgress } = {}) {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  let newMatches = 0, saved = 0;
  try {
    const d = await discoverAll({ onProgress });
    newMatches = d.newMatches;
    const links = await processAo3Links({ onProgress });
    const dl = await downloadWanted({ onProgress });
    saved = links.done + dl.saved;
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  return { ok: true, newMatches, saved };
}
