// Date formatting for story cards. Pure + node-testable (no DOM, no imports).

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A work's last-updated date → a short label for a card's meta row.
//
// AO3 stores this as a plain date ("2025-08-14"), so we parse the parts by hand
// rather than letting Date() decide: `new Date('2025-08-14')` is parsed as UTC
// midnight and then rendered in local time, which shows the previous day for
// anyone west of Greenwich — an off-by-one on every card.
//
// Recent dates read as "3d ago" (the useful thing in a discovery feed); older
// ones as "14 Aug", with the year only when it isn't the current one.
// Returns '' for missing/unparseable input so callers can just omit the element.
export function fmtUpdated(value, now = new Date()) {
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';

  const then = new Date(y, mo - 1, d);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((startOfToday - then) / 86400000);

  if (days < 0) return 'today';       // clock skew / a date ahead of us
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return y === now.getFullYear()
    ? `${d} ${MONTH_NAMES[mo - 1]}`
    : `${d} ${MONTH_NAMES[mo - 1]} ${y}`;
}

// Sort comparators for the discovery feed. Kept here (pure) so the ordering is
// unit-tested rather than buried in a component.
//
// Rows discovered before we captured dates have none; they sort last in BOTH
// directions, because floating undated rows to the top of "Oldest" would bury
// the genuinely old works the sort exists to surface.
export const MATCH_SORTS = {
  newest: byDate(-1),
  oldest: byDate(1),
  longest: (a, b) => (b.words || 0) - (a.words || 0),
  shortest: (a, b) => (a.words || 0) - (b.words || 0),
};

// `dir` 1 = ascending (oldest first), -1 = descending (newest first). The undated
// check runs BEFORE dir is applied, so those rows sink to the bottom either way —
// swapping the comparator's arguments instead would have floated them to the top
// of one of the two directions.
function byDate(dir) {
  return (a, b) => {
    const ad = a.sourceUpdated || '';
    const bd = b.sourceUpdated || '';
    if (!ad && !bd) return 0;
    if (!ad) return 1;
    if (!bd) return -1;
    return ad < bd ? -dir : ad > bd ? dir : 0;
  };
}

// Apply a named sort, leaving the server order alone for an unknown key.
export function sortMatches(matches, key) {
  const cmp = MATCH_SORTS[key];
  if (!cmp) return matches;
  // Undated rows stay last on 'oldest' too, so slice+sort rather than mutate.
  return [...matches].sort(cmp);
}
