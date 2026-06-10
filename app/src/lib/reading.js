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

// Resume position — remember which chapter you were on and how far down it you'd
// scrolled, per work, in localStorage. On reopening the work the reader jumps
// back to that chapter and scroll offset (≈ the paragraph you left off on). Kept
// local: a frequent, personal, offline action that needs no round-trip.
const POS_KEY = 'fs-readpos';

export function getReadingPos(workId) {
  if (!workId) return null;
  try { const m = JSON.parse(localStorage.getItem(POS_KEY) || '{}'); return m[workId] || null; }
  catch { return null; }
}

export function saveReadingPos(workId, { chapter, pct }) {
  if (!workId || !chapter) return;
  try {
    const m = JSON.parse(localStorage.getItem(POS_KEY) || '{}');
    m[workId] = { chapter, pct: Math.max(0, Math.min(1, pct || 0)), at: new Date().toISOString() };
    localStorage.setItem(POS_KEY, JSON.stringify(m));
  } catch { /* storage unavailable — non-fatal */ }
}
