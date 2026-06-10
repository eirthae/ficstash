// Local "last read" tracking — when the user opens a work in the reader we stamp
// the time here (per device, in localStorage). The library's "Last read" sort
// reads this map so the works you've actually opened float to the top of their
// shelf. Kept local (not in Supabase) because it's a personal, offline action
// and needs no round-trip.
const KEY = 'fs-lastread';

export function getLastRead() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

export function markRead(workId) {
  if (!workId) return;
  try {
    const m = getLastRead();
    m[workId] = new Date().toISOString();
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch { /* storage unavailable — non-fatal */ }
}

// Resume position — remember how far down EACH chapter you'd scrolled, per work,
// in localStorage. We keep a position per chapter (not just one per work) so that
// leaving a chapter near the end, reading ahead, then coming BACK returns you to
// where you were — not the top. `last` points at the chapter to resume on reopen.
// Kept local: a frequent, personal, offline action that needs no round-trip.
//
// Shape: { [workId]: { chapters: { [n]: pct }, last: n, at: iso } }
// (Older builds stored { chapter, pct } — read() migrates that on the fly.)
const POS_KEY = 'fs-readpos';

function readAll() {
  try { return JSON.parse(localStorage.getItem(POS_KEY) || '{}'); } catch { return {}; }
}
function entry(m, workId) {
  const e = m[workId];
  if (e && e.chapters) return e;
  if (e && e.chapter) return { chapters: { [e.chapter]: e.pct || 0 }, last: e.chapter, at: e.at }; // migrate legacy
  return { chapters: {}, last: null, at: null };
}

// Where to resume the work as a whole (latest chapter touched + its scroll).
export function getReadingPos(workId) {
  if (!workId) return null;
  const e = entry(readAll(), workId);
  if (!e.last) return null;
  return { chapter: e.last, pct: e.chapters[e.last] || 0 };
}

// Saved scroll fraction for a SPECIFIC chapter (0 if never visited).
export function getChapterPos(workId, chapter) {
  if (!workId || !chapter) return 0;
  return entry(readAll(), workId).chapters[chapter] || 0;
}

export function saveReadingPos(workId, { chapter, pct }) {
  if (!workId || !chapter) return;
  try {
    const m = readAll();
    const e = entry(m, workId);
    e.chapters[chapter] = Math.max(0, Math.min(1, pct || 0));
    e.last = chapter;
    e.at = new Date().toISOString();
    m[workId] = e;
    localStorage.setItem(POS_KEY, JSON.stringify(m));
  } catch { /* storage unavailable — non-fatal */ }
}
