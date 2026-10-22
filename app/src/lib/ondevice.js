import { supabase, hasSupabase } from './supabase.js';
import { searchTags, searchLanguage, fetchWork, seriesWorks, isAo3Url, workIdFromUrl } from './sources/ao3.js';
import { fetchWork as fetchScribbleWork } from './sources/scribblehub.js';
import { searchRomanceBooks, slugsForNames } from './sources/romanceio.js';
import { statusMatches, passesGlobalPrefs, excludedForShelf } from './shelving.js';
import {
  normGroup, matchRow, bookMatchRow, workRow, chapterRows,
  newChapters, chapterUpdateRows, seriesFetchPlan, isDefinitiveFailure,
} from './ondevice-pure.js';

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

// Keys-only tombstone of dismissed works ("source:id"), so on-device discovery never
// re-adds one the user swiped away (dismiss hard-deletes the tag_matches row). Best-
// effort: empty set if the table isn't there yet.
async function readDismissedKeys() {
  const keys = new Set();
  try {
    const PAGE = 1000;
    for (let start = 0; ; start += PAGE) {
      const { data, error } = await supabase
        .from('dismissed_matches').select('source,source_work_id').range(start, start + PAGE - 1);
      if (error) break;
      for (const r of data || []) keys.add(`${r.source}:${r.source_work_id}`);
      if (!data || data.length < PAGE) break;
    }
  } catch (e) { /* table may not exist yet */ }
  return keys;
}

// ---- discovery -------------------------------------------------------------

// Search AO3 for one group on-device and upsert its matches to Supabase. Returns
// the number of rows written. ONE page (~20 newest-updated works), for instant
// results when a group is created or edited — it never touches last_checked, so
// the worker's all-time seed still happens. AO3-only; other sources are skipped
// (the worker still handles them).
export async function discoverGroup(group, prefs, dismissed) {
  if (!hasSupabase) return 0;
  const g = normGroup(group);
  prefs = prefs || (await readPrefs());
  if (dismissed === undefined) dismissed = await readDismissedKeys();
  if (g.source === 'romanceio') return discoverRomanceGroup(g, prefs, dismissed);
  if (g.source !== 'ao3') return 0;
  if (!g.langCode && !g.include.length) return 0;

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
    // Let it out instead of returning 0. searchTags/searchLanguage already throw
    // only when AO3 could not be READ (and return [] for a genuinely empty
    // result), and swallowing that here made "AO3 is 525ing" look identical to
    // "nothing new" — which the per-group Sync button has to tell apart to say
    // anything true. Every other caller (createGroup / createLanguageGroup /
    // updateGroup / discoverAll) already wraps this in its own try/catch and
    // treats discovery as best-effort, so nothing else changes.
    const err = new Error('AO3 did not answer');
    err.code = 'source_unavailable';
    err.cause = e;
    throw err;
  }

  const written = await writeAo3Matches(g, metas, prefs, shelfExcl, dismissed, new Set());
  // Deliberately does NOT stamp last_checked. This fetch is ONE page — the ~20
  // most recently updated works — purely so a new group opens with something in
  // it. last_checked is the worker's window anchor, and stamping it here told the
  // worker "already checked", which killed the all-time back-catalogue seed: an
  // app-created group was capped at those 20 works forever, because the worker's
  // first-run branch never ran for it. It also defeated updateGroup, which
  // explicitly nulls last_checked so the worker re-seeds against new criteria,
  // only for this to immediately set it again.
  //
  // The split is: the app gives instant results, the worker owns the window.
  return written;
}

// De-dupe a batch of AO3 blurbs, drop the ones this group doesn't want, and write
// what's left. `seen` is passed in so a multi-page run shares one de-dupe set
// across pages. Returns the number of rows written.
//
// Shared by the one-page discover and the all-time catch-up on purpose: "what
// counts as a match for this group" is one rule, and having it written twice is
// how the two would quietly start disagreeing.
async function writeAo3Matches(g, metas, prefs, shelfExcl, dismissed, seen) {
  const keep = [];
  for (const m of metas) {
    if (!m.sourceId || seen.has(m.sourceId)) continue;
    seen.add(m.sourceId);
    // The group's completion-status filter, then the global language/exclude
    // prefs (language groups are exempt — there the search IS the filter), then
    // the dismissed tombstone so a swiped-away work never comes back.
    if (!statusMatches(m, g.status)) continue;
    if (!passesGlobalPrefs(m, { excludedTags: shelfExcl, languages: prefs.languages }, !!g.langCode)) continue;
    if (dismissed && dismissed.has(`ao3:${m.sourceId}`)) continue;
    keep.push(matchRow(g.id, m));
  }
  if (keep.length) {
    const { error } = await supabase
      .from('tag_matches')
      .upsert(keep, { onConflict: 'group_id,source,source_work_id' });
    if (error) throw error;
  }
  return keep.length;
}

// AO3 serves 20 works per search page, so a short page is the last page.
const AO3_PAGE_SIZE = 20;
// Hard ceiling on an all-time catch-up: 25 pages ≈ 500 works per query. At the
// 1.5s politeness gap that's ~40 seconds of fetching, which is about as long as
// anyone will hold a phone still — and it keeps a 40,000-work fandom tag from
// turning one tap into an hour of hammering a volunteer-run site.
const ALLTIME_MAX_PAGES = 25;

// Walk a group's search back through the pages instead of taking only the newest
// one — the back catalogue, not today's updates.
//
// This is the seed the WORKER is supposed to do on a group's first run, and
// can't: AO3 Cloudflare-525s its datacenter IP, so a group can sit on the ~20
// works the app grabbed at creation for weeks. Running it here, from the phone's
// residential IP, is the only way it reliably happens at all.
//
// Reports progress per page and checks shouldStop() between pages so a long run
// stays interruptible. Partial progress is kept: everything written before a
// stop or an AO3 failure stays written, and the result says where it ended.
// Returns { written, pages, failed, stopped, capped } — `capped` meaning it ran
// into ALLTIME_MAX_PAGES rather than reaching the end, so there IS more back
// there. Worth telling the user, because a second run starts from page 1 again:
// there's no resume, and pretending otherwise would be a lie.
export async function discoverGroupAllTime(group, { onProgress, shouldStop } = {}) {
  const idle = { written: 0, pages: 0, failed: false, stopped: false, capped: false };
  if (!hasSupabase) return idle;
  const g = normGroup(group);
  if (g.source !== 'ao3') return idle;
  if (!g.langCode && !g.include.length) return idle;

  const prefs = await readPrefs();
  const dismissed = await readDismissedKeys();
  const shelfExcl = excludedForShelf(prefs, 'ao3');
  const excludeNames = [...g.excluded, ...shelfExcl.map((t) => (t && t.name) || t)]
    .filter((n, i, a) => n && a.indexOf(n) === i);

  // An "any" group is several searches, not one — AO3 has no OR — so each of its
  // tags gets its own page walk. One shared `seen` set means a work tagged with
  // two of them is still only written once.
  const queries = g.langCode ? [null]
    : (g.matchMode === 'any' && g.include.length > 1 ? g.include.map((t) => [t]) : [g.include]);
  const seen = new Set();
  let written = 0;
  let pages = 0;
  let capped = false;

  for (const q of queries) {
    for (let page = 1; page <= ALLTIME_MAX_PAGES; page++) {
      if (shouldStop && shouldStop()) return { written, pages, failed: false, stopped: true, capped };
      let metas;
      try {
        metas = q === null ? await searchLanguage(g.langCode, page) : await searchTags(q, excludeNames, page);
      } catch (e) {
        // Keep what we already wrote and say where it stopped — a catch-up that
        // got 300 of 500 works is worth far more than a thrown-away run.
        return { written, pages, failed: true, stopped: false, capped };
      }
      pages += 1;
      written += await writeAo3Matches(g, metas, prefs, shelfExcl, dismissed, seen);
      onProgress && onProgress({ pages, written });
      if (metas.length < AO3_PAGE_SIZE) break; // short page = end of the results
      if (page === ALLTIME_MAX_PAGES) { capped = true; break; }
      await sleep(SPACE_MS);
    }
  }
  // Same rule as discoverGroup: no last_checked stamp. Even a full back-catalogue
  // walk is not the worker's incremental window, and claiming it would stop the
  // nightly run from ever looking at this group again.
  return { written, pages, failed: false, stopped: false, capped };
}

// Discover one romance.io Books group on-device: query the site's books API by the
// group's include topic slugs, hiding the group's excludes + this shelf's global
// excludes (mapped to slugs) + the permanent non-binary-MC default-exclude list
// (merged inside searchRomanceBooks). Books are metadata-only — upsert them as
// tag_matches that link out. normGroup carries slugs in includeIds/excludeIds.
async function discoverRomanceGroup(g, prefs, dismissed) {
  if (!g.includeIds.length) return 0;
  const shelfExcl = excludedForShelf(prefs, 'books'); // [{name}|string]
  const exclude = [...new Set([...g.excludeIds, ...slugsForNames(shelfExcl)])];

  let books = [];
  try { books = await searchRomanceBooks(g.includeIds, exclude); } catch (e) { return 0; }

  const seen = new Set();
  books = books.filter((b) => b.sourceWorkId && !seen.has(b.sourceWorkId) && (seen.add(b.sourceWorkId), true));
  if (dismissed && dismissed.size) books = books.filter((b) => !dismissed.has(`romanceio:${b.sourceWorkId}`));

  const rows = books.map((b) => bookMatchRow(g.id, b));
  if (rows.length) {
    const { error } = await supabase
      .from('tag_matches')
      .upsert(rows, { onConflict: 'group_id,source,source_work_id' });
    if (error) throw error;
  }
  // Same as discoverGroup: one page for instant results, no stamp — the worker
  // owns last_checked and therefore the all-time seed.
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
  const dismissed = await readDismissedKeys(); // fetched once for the whole pass
  // AO3 (on-device HTML scrape) + romance.io (on-device books API). Other sources
  // stay on the worker. Both go through discoverGroup, which branches by source.
  const onDeviceGroups = groups.filter((g) => ['ao3', 'romanceio'].includes(g.source || 'ao3'));
  let newMatches = 0, checked = 0;
  for (const g of onDeviceGroups) {
    if (checked) await sleep(SPACE_MS);
    checked += 1;
    if (onProgress) onProgress({ done: checked, total: onDeviceGroups.length, title: g.label || 'group' });
    try { newMatches += await discoverGroup(g, prefs, dismissed); } catch (e) { /* non-fatal */ }
  }
  return { newMatches, groups: onDeviceGroups.length };
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

// Fetch one work on-device and store it (work + chapters) in Supabase. `source`
// picks the fetcher: AO3 (default) or Scribble Hub — both are Cloudflare-walled to
// datacenter IPs but answer the phone, so both download here, on the device.
// Returns { ok, restricted?, empty?, workId? }. Does NOT mark tag_matches saved —
// the caller decides (a Save marks the match; a link import marks the request).
export async function downloadWork(sourceWorkId, { origin = 'tag', source = 'ao3' } = {}) {
  if (!hasSupabase) return { ok: false };
  const wid = String(sourceWorkId || '').match(/\d+/)?.[0];
  if (!wid) return { ok: false };
  let parsed;
  try {
    parsed = source === 'scribblehub' ? await fetchScribbleWork(wid) : await fetchWork(wid);
  } catch (e) {
    const msg = String(e && e.message || e);
    // A 404 / "cannot find" means the work was removed at the source — a DEFINITIVE
    // failure (won't ever succeed), vs a transient 525/throttle/network error.
    return { ok: false, error: msg, notFound: isDefinitiveFailure(msg) };
  }
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
async function markMatchesSaved(sourceWorkId, source = 'ao3') {
  try {
    await supabase
      .from('tag_matches')
      .update({ saved: true, wanted: false })
      .eq('source', source)
      .eq('source_work_id', String(sourceWorkId));
  } catch (e) { /* non-fatal */ }
}

// Re-download an AO3 work already in the library, on-device, with the current
// pipeline (captures the work skin + inlines images). For the per-work "Re-fetch"
// action — fixes chat/texting/image works that were fetched by an older build.
// origin:null so the upsert keeps the work's existing origin lane.
export async function refetchWork(sourceWorkId, source = 'ao3') {
  return downloadWork(sourceWorkId, { origin: null, source });
}

// Hand a members-only work to the WORKER instead of failing it.
//
// A logged-out on-device fetch can never read a restricted work, but the worker
// signs in with your AO3 account and can. Marking it failed was wrong twice
// over: it set wanted=false, so the worker's saves pass never saw it, and it
// parked the work in the Failed stash — where a save you made simply never
// appeared unless you went looking. It stays WANTED, with a reason explaining
// who will fetch it, and the device stops retrying it itself.
export async function markMatchNeedsAccount(sourceWorkId, source = 'ao3') {
  try {
    await supabase
      .from('tag_matches')
      .update({
        wanted: true,
        failed: false,
        fail_reason: 'Members-only — waiting for the worker to fetch it with your AO3 account',
      })
      .eq('source', source)
      .eq('source_work_id', String(sourceWorkId));
  } catch (e) { /* non-fatal */ }
}

const NEEDS_ACCOUNT = /members-only|restricted/i;

// Flag a match as failed (across every group it matched) so it leaves the wanted-
// retry loop and shows in the app's Failed stash. Only DEFINITIVE failures call this.
async function markMatchFailed(sourceWorkId, source, reason) {
  try {
    await supabase
      .from('tag_matches')
      .update({ failed: true, wanted: false, fail_reason: reason || null })
      .eq('source', source)
      .eq('source_work_id', String(sourceWorkId));
  } catch (e) { /* non-fatal */ }
}

// Save a single match NOW (a tapped Save), on-device. On success the match flips
// to saved and the work is in the library. `source` = 'ao3' | 'scribblehub'. A
// DEFINITIVE failure (removed at source / members-only) flags the match failed so
// it stops retrying and appears in the Failed stash; a transient miss (empty/
// throttle) is left wanted to auto-retry on the next pull-to-refresh.
export async function saveMatchNow(sourceWorkId, source = 'ao3') {
  const r = await downloadWork(sourceWorkId, { origin: 'tag', source });
  if (r.ok) await markMatchesSaved(sourceWorkId, source);
  else if (r.restricted) await markMatchNeedsAccount(sourceWorkId, source);
  else if (r.notFound) await markMatchFailed(sourceWorkId, source, 'Removed at the source (not found)');
  return r;
}

// Serial save queue. Tapping Save several times in a row fired several downloadWork
// fetches AT ONCE — AO3 (a volunteer nonprofit) rate-limits concurrent bursts hard,
// so most came back empty/525 and only the first save actually persisted. We funnel
// every tapped AO3 save through ONE worker that fetches them one at a time, spaced,
// so a rapid burst of saves all download instead of throttling each other. A save
// that still misses stays wanted=true and is retried by downloadWanted on the next
// pull-to-refresh. Best-effort + fire-and-forget; the queue is in-memory (the durable
// record is tag_matches.wanted in Supabase).
const _saveQueue = [];        // [{ wid, source }]
const _saveQueued = new Set(); // keys `source:wid`, for dedupe
let _saveDraining = false;

async function _drainSaveQueue() {
  if (_saveDraining) return;
  _saveDraining = true;
  try {
    while (_saveQueue.length) {
      const { wid, source } = _saveQueue.shift();
      try { await saveMatchNow(wid, source); } catch (e) { /* stays wanted → retried on sync */ }
      _saveQueued.delete(`${source}:${wid}`);
      if (_saveQueue.length) await sleep(SPACE_MS); // polite gap between fetches
    }
  } finally {
    _saveDraining = false;
  }
}

// Queue a tapped on-device save (AO3 or Scribble Hub) for serial, spaced download.
// Deduped, so double-taps and a re-tap of an already-queued work don't fetch twice.
export function enqueueSave(sourceWorkId, source = 'ao3') {
  const wid = String(sourceWorkId || '').match(/\d+/)?.[0];
  if (!wid) return;
  const key = `${source}:${wid}`;
  if (_saveQueued.has(key)) return;
  _saveQueued.add(key);
  _saveQueue.push({ wid, source });
  _drainSaveQueue();
}

// Download every wanted-but-unsaved on-device match (AO3 + Scribble Hub) on the
// device — the pull-to-refresh retry. This is what rescues saves that missed
// (including SH stories the worker can't fetch at all: Cloudflare 403s its IP).
export async function downloadWanted({ onProgress } = {}) {
  if (!hasSupabase) return { saved: 0, failed: 0 };
  let wanted = [];
  try {
    const { data } = await supabase
      .from('tag_matches')
      .select('source, source_work_id, fail_reason')
      .in('source', ['ao3', 'scribblehub'])
      .eq('wanted', true)
      .eq('saved', false);
    const seen = new Set();
    wanted = (data || []).filter((r) => {
      const k = `${r.source}:${r.source_work_id}`;
      if (!r.source_work_id || seen.has(k)) return false;
      seen.add(k); return true;
    });
  } catch (e) { wanted = []; }
  let saved = 0, failed = 0, i = 0;
  for (const w of wanted) {
    if (i) await sleep(SPACE_MS);
    i += 1;
    if (onProgress) onProgress({ done: i, total: wanted.length, title: w.source_work_id });
    try {
      // Already known to need the AO3 account: re-fetching it here would fail
      // identically every time. Counted as failed so syncNow escalates once to
      // the worker, which is the only thing that CAN read it.
      if (NEEDS_ACCOUNT.test(w.fail_reason || '')) { failed += 1; continue; }
      const r = await saveMatchNow(w.source_work_id, w.source);
      if (r.ok) saved += 1; else failed += 1;
    } catch (e) { failed += 1; }
  }
  return { saved, failed };
}

// ---- AO3 link import (pasted /works/ URL) ----------------------------------

// Fetch any queued AO3 link requests on-device and resolve them (done/restricted,
// or left queued to retry). Non-AO3 requests are left untouched for the worker.
//
// SINGLE-FLIGHT: requestUrl fires this on every AO3 add, so pasting/importing a
// batch of links used to spawn many concurrent runs that hit AO3 all at once and
// got throttled (works stuck 'queued'). We coalesce concurrent calls onto one
// in-flight run, which processes the whole queue one at a time, spaced.
let _linksInFlight = null;
export function processAo3Links(opts = {}) {
  if (_linksInFlight) return _linksInFlight;
  _linksInFlight = _processAo3Links(opts).finally(() => { _linksInFlight = null; });
  return _linksInFlight;
}

async function _processAo3Links({ onProgress } = {}) {
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

// ---- refresh ongoing works → pull new chapters -----------------------------

// Re-check each followed, ongoing AO3 work for new chapters on-device. For any
// work that gained chapters: append the new ones, bump the work's counts/status,
// and record each in the "New chapters" feed (chapter_updates). Capped per run for
// politeness — the rest get picked up on the next pull.
export async function refreshOngoing({ onProgress, cap = 30 } = {}) {
  if (!hasSupabase) return { updated: 0, newChapters: 0 };
  let works = [];
  try {
    const { data } = await supabase
      .from('works')
      .select('id, source_work_id, chapters, status')
      .eq('source', 'ao3')
      .eq('offline', true)
      .eq('hidden', false)
      .eq('follow', true)
      .limit(cap);
    works = data || [];
  } catch (e) { works = []; }
  let updated = 0, newCh = 0, i = 0;
  for (const w of works) {
    if (i) await sleep(SPACE_MS);
    i += 1;
    if (onProgress) onProgress({ done: i, total: works.length, title: w.source_work_id });
    let parsed;
    try { parsed = await fetchWork(w.source_work_id); } catch (e) { continue; }
    if (!parsed || parsed.restricted) continue;
    const fresh = newChapters(w.chapters || 0, parsed);
    if (fresh.length) {
      try {
        await writeChapters(w.id, fresh);
        await supabase.from('works').update({
          chapters: parsed.chapters, words: parsed.words,
          chapters_total: parsed.chaptersTotal ?? null,
          status: parsed.status, follow: parsed.status !== 'complete',
        }).eq('id', w.id);
        const rows = chapterUpdateRows({ id: w.id, source: 'ao3', source_work_id: w.source_work_id }, fresh);
        if (rows.length) await supabase.from('chapter_updates').upsert(rows, { onConflict: 'work_id,chapter_n' });
        updated += 1; newCh += fresh.length;
      } catch (e) { /* non-fatal */ }
    } else if (parsed.status === 'complete' && w.status !== 'complete') {
      try { await supabase.from('works').update({ status: 'complete', follow: false, chapters_total: parsed.chapters }).eq('id', w.id); } catch (e) {}
    }
  }
  return { updated, newChapters: newCh };
}

// ---- followed / download-all series → fetch their works --------------------

// Every source_work_id already in the library (for the series plan).
async function existingAo3Ids() {
  try {
    const { data } = await supabase.from('works').select('source_work_id').eq('source', 'ao3');
    return new Set((data || []).map((r) => r.source_work_id).filter(Boolean));
  } catch (e) { return new Set(); }
}

// Process every followed/queued series on-device: enumerate it on AO3, download
// the works we don't have yet (capped), tag each with the series so the shelf
// auto-groups it, and re-tag works we already have. A one-shot "Download all"
// (follow=false) drops its queue row once everything's pulled.
export async function processFollowedSeries({ onProgress } = {}) {
  if (!hasSupabase) return { seriesAdded: 0 };
  let series = [];
  try {
    const { data } = await supabase
      .from('followed_series')
      .select('id, series_id, series_name, follow')
      .order('created_at', { ascending: true });
    series = data || [];
  } catch (e) { series = []; }
  let added = 0, si = 0;
  for (const s of series) {
    if (si) await sleep(SPACE_MS);
    si += 1;
    if (onProgress) onProgress({ done: si, total: series.length, title: s.series_name || s.series_id });
    let list = [];
    try { list = await seriesWorks(s.series_id); } catch (e) { continue; }
    if (!list.length) continue;
    const plan = seriesFetchPlan(list, await existingAo3Ids(), 12);
    // Re-tag works we already have with this series + their position.
    for (const e of plan.have) {
      try {
        await supabase.from('works')
          .update({ ao3_series_id: String(s.series_id), ao3_series_name: s.series_name || '', ao3_series_index: e.index })
          .eq('source', 'ao3').eq('source_work_id', e.id);
      } catch (_) { /* non-fatal */ }
    }
    for (const e of plan.toFetch) {
      await sleep(SPACE_MS);
      let parsed;
      try { parsed = await fetchWork(e.id); } catch (err) { continue; }
      if (!parsed || parsed.restricted) continue;
      parsed.ao3SeriesId = String(s.series_id);
      parsed.series = s.series_name || parsed.series;
      parsed.seriesIndex = e.index;
      try {
        const { data, error } = await supabase
          .from('works').upsert(workRow(parsed, 'tag'), { onConflict: 'source,source_work_id' })
          .select('id').single();
        if (error) continue;
        await writeChapters(data.id, parsed.chaptersData);
        added += 1;
      } catch (err) { /* skip one work */ }
    }
    try { await supabase.from('followed_series').update({ last_checked: new Date().toISOString(), work_count: list.length }).eq('id', s.id); } catch (_) {}
    // A one-shot download (not a follow) is done once everything's pulled.
    if (!s.follow && !plan.hitCap) {
      try { await supabase.from('followed_series').delete().eq('id', s.id); } catch (_) {}
    }
  }
  return { seriesAdded: added };
}

// ---- the on-device pull-to-refresh -----------------------------------------
// The full on-device pass: discover across tracked AO3 groups, fetch pending AO3
// links + wanted saves, pull followed series, and refresh ongoing works for new
// chapters — all on the phone, written to Supabase. Returns a small summary.
// Pull-to-refresh: finish what YOU just asked for, and nothing else.
//
// This used to run the entire nightly sweep on the phone — every tracked group
// re-searched, all ~108 followed series re-enumerated, every ongoing work
// re-checked — which is minutes of hammering AO3 from a handset, usually on
// mobile data. But a pull-to-refresh is almost always "I tapped Save a few
// minutes ago and it still isn't here", so now it only completes pending
// downloads: links you pasted and works you saved from a tag.
//
// Discovery, series follows and new-chapter checks belong to the scheduled
// worker, which has the time budget, the rate-limit spacing and an AO3 login.
// They're still exported for the paths that genuinely need them (creating or
// editing a group re-discovers that one group; series.js drives a "download
// all" tap), just not from a pull.
export async function runSync({ onProgress } = {}) {
  if (!hasSupabase) return { ok: false, error: 'Not connected' };
  let saved = 0, savesFailed = 0;
  try {
    const links = await processAo3Links({ onProgress });
    const dl = await downloadWanted({ onProgress });
    saved = links.done + dl.saved;
    // Works the device couldn't get (empty — likely members-only/adult that a
    // logged-out fetch can't read). syncNow escalates these to the logged-in worker.
    savesFailed = (links.failed || 0) + (dl.failed || 0);
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
  // newMatches/seriesAdded/newChapters stay in the shape for callers that read
  // them; a pull no longer produces any, by design.
  return { ok: true, newMatches: 0, saved, savesFailed, seriesAdded: 0, newChapters: 0 };
}
