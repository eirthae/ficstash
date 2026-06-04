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
