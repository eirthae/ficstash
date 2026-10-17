import { Preferences } from '@capacitor/preferences';

// What you've read — opens, per-chapter scroll positions, and time spent.
//
// Persisted through Capacitor Preferences (SharedPreferences-backed), with
// localStorage kept as a synchronous mirror. This matters: Android's WebView
// drops localStorage between cold starts — the same thing that used to reset the
// reader's font and margins (see App.jsx) — and when it took reading state with
// it, the library's Unread sort quietly re-listed everything you'd already read.
// Preferences survives; localStorage is only a fast cache for synchronous reads.
//
// Reads stay synchronous (the library sorts during render), so an in-memory
// cache is the source of truth. initReadingStore() hydrates it from Preferences
// at startup; until then the mirror answers.

const KEY = 'fs-lastread';    // { [workId]: iso }        — when you last opened it
const POS_KEY = 'fs-readpos'; // { [workId]: {chapters:{n:pct}, last, at} }
const TIME_KEY = 'fs-readtime'; // { [workId]: seconds }  — active time spent reading

const cache = { [KEY]: null, [POS_KEY]: null, [TIME_KEY]: null };

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch { return {}; }
}

function store(key) {
  if (cache[key] === null) cache[key] = readLocal(key);
  return cache[key];
}

function put(key, value) {
  cache[key] = value;
  let json;
  try { json = JSON.stringify(value); } catch { return; }
  try { localStorage.setItem(key, json); } catch { /* storage unavailable */ }
  Preferences.set({ key, value: json }).catch(() => { /* best-effort */ });
}

// Union two copies of a reading store without losing progress from either side.
// Preferences is the durable copy, but localStorage can hold writes made after
// the last successful Preferences write, so neither wins outright: we merge, and
// for conflicts keep whichever value represents MORE reading. Pure + tested.
export function mergeReading(key, a = {}, b = {}) {
  const out = { ...(a || {}) };
  for (const id of Object.keys(b || {})) {
    const mine = out[id];
    const theirs = b[id];
    if (mine === undefined) { out[id] = theirs; continue; }
    if (key === TIME_KEY) {
      out[id] = Math.max(Number(mine) || 0, Number(theirs) || 0);
    } else if (key === KEY) {
      out[id] = String(theirs) > String(mine) ? theirs : mine; // latest open wins
    } else {
      const chapters = { ...((mine && mine.chapters) || {}) };
      for (const n of Object.keys((theirs && theirs.chapters) || {})) {
        chapters[n] = Math.max(Number(chapters[n]) || 0, Number(theirs.chapters[n]) || 0);
      }
      const newer = String((theirs && theirs.at) || '') > String((mine && mine.at) || '') ? theirs : mine;
      out[id] = { chapters, last: (newer && newer.last) ?? null, at: (newer && newer.at) ?? null };
    }
  }
  return out;
}

// Hydrate from Preferences at startup. Call once; the app re-renders after it
// resolves so the library sorts on the durable copy rather than the mirror.
export async function initReadingStore() {
  for (const key of [KEY, POS_KEY, TIME_KEY]) {
    const local = readLocal(key);
    try {
      const { value } = await Preferences.get({ key });
      const durable = value ? (JSON.parse(value) || {}) : null;
      // No durable copy yet = first run after this change: seed it from whatever
      // localStorage still holds, so existing history is preserved, not reset.
      const merged = durable ? mergeReading(key, durable, local) : local;
      cache[key] = merged;
      if (!durable || JSON.stringify(merged) !== value) {
        try { localStorage.setItem(key, JSON.stringify(merged)); } catch { /* ignore */ }
        Preferences.set({ key, value: JSON.stringify(merged) }).catch(() => {});
      }
    } catch {
      cache[key] = local; // Preferences unavailable (browser preview) → mirror only
    }
  }
}

// ---- opens ------------------------------------------------------------------

export function getLastRead() {
  return store(KEY);
}

export function markRead(workId) {
  if (!workId) return;
  put(KEY, { ...store(KEY), [workId]: new Date().toISOString() });
}

// ---- time spent -------------------------------------------------------------

export function getReadingTime() {
  return store(TIME_KEY);
}

// Seconds of ACTIVE reading banked against a work, accumulated across sessions.
// `seconds` may be 0: the reader banks a zero on open so the work has a record,
// which is how "opened since time tracking existed, and bounced" is told apart
// from "opened long ago, before we tracked anything at all".
export function addReadingTime(workId, seconds) {
  if (!workId) return;
  const s = Math.max(0, Number(seconds) || 0);
  const map = store(TIME_KEY);
  const next = (Number(map[workId]) || 0) + s;
  if (s === 0 && map[workId] !== undefined) return; // nothing to record
  put(TIME_KEY, { ...map, [workId]: next });
}

// ---- scroll positions -------------------------------------------------------
// A position per CHAPTER (not one per work) so leaving a chapter near the end,
// reading ahead, then coming back returns you to where you were — not the top.
// `last` points at the chapter to resume on reopen.
// (Older builds stored { chapter, pct } — entry() migrates that on the fly.)

function entry(m, workId) {
  const e = m[workId];
  if (e && e.chapters) return e;
  if (e && e.chapter) return { chapters: { [e.chapter]: e.pct || 0 }, last: e.chapter, at: e.at };
  return { chapters: {}, last: null, at: null };
}

// Every work's reading entry at once, normalised, keyed by work id. The library's
// Unread sort needs progress for the whole shelf, and calling getReadingPos per
// work would re-walk the store once per row.
export function getReadingMap() {
  const raw = store(POS_KEY);
  const out = {};
  for (const workId of Object.keys(raw)) out[workId] = entry(raw, workId);
  return out;
}

// Where to resume the work as a whole (latest chapter touched + its scroll).
export function getReadingPos(workId) {
  if (!workId) return null;
  const e = entry(store(POS_KEY), workId);
  if (!e.last) return null;
  return { chapter: e.last, pct: e.chapters[e.last] || 0 };
}

// Saved scroll fraction for a SPECIFIC chapter (0 if never visited).
export function getChapterPos(workId, chapter) {
  if (!workId || !chapter) return 0;
  return entry(store(POS_KEY), workId).chapters[chapter] || 0;
}

export function saveReadingPos(workId, { chapter, pct }) {
  if (!workId || !chapter) return;
  const map = store(POS_KEY);
  const e = entry(map, workId);
  const chapters = { ...e.chapters, [chapter]: Math.max(0, Math.min(1, pct || 0)) };
  put(POS_KEY, { ...map, [workId]: { chapters, last: chapter, at: new Date().toISOString() } });
}

// Fold the durable per-work copy (works.read_seconds) back into the device
// store. Runs after the library loads, so a reinstall — or a second device —
// recovers its reading history instead of showing the whole shelf as unread.
// Max wins: the device may have read more since the last successful push.
export function absorbRemoteReadingTime(works) {
  const map = store(TIME_KEY);
  let changed = false;
  const next = { ...map };
  for (const w of works || []) {
    const remote = Number(w && w.readSeconds) || 0;
    if (!w || !w.id || remote <= 0) continue;
    if ((Number(next[w.id]) || 0) < remote) { next[w.id] = remote; changed = true; }
  }
  if (changed) put(TIME_KEY, next);
  return changed;
}
