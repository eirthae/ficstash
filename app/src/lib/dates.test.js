import test from 'node:test';
import assert from 'node:assert/strict';
import { fmtUpdated, sortMatches } from './dates.js';

const NOW = new Date(2026, 7, 11); // 11 Aug 2026, local

test('fmtUpdated reads recent dates as relative', () => {
  assert.equal(fmtUpdated('2026-08-11', NOW), 'today');
  assert.equal(fmtUpdated('2026-08-10', NOW), 'yesterday');
  assert.equal(fmtUpdated('2026-08-08', NOW), '3d ago');
  assert.equal(fmtUpdated('2026-07-20', NOW), '22d ago');
});

test('fmtUpdated reads older dates as a day + month, year only when not this one', () => {
  assert.equal(fmtUpdated('2026-01-14', NOW), '14 Jan');
  assert.equal(fmtUpdated('2025-08-14', NOW), '14 Aug 2025');
});

test('fmtUpdated does not shift the day across timezones', () => {
  // new Date('2025-08-14') is UTC midnight; rendering that in any timezone west
  // of Greenwich yields the 13th. Parsing the parts by hand avoids the off-by-one.
  assert.match(fmtUpdated('2025-08-14', NOW), /^14 Aug/);
});

test('fmtUpdated returns empty for junk so the card can omit the element', () => {
  assert.equal(fmtUpdated(null, NOW), '');
  assert.equal(fmtUpdated('', NOW), '');
  assert.equal(fmtUpdated('not a date', NOW), '');
  assert.equal(fmtUpdated('2025-13-01', NOW), ''); // month 13
});

test('fmtUpdated treats a future date as today rather than "-2d ago"', () => {
  assert.equal(fmtUpdated('2026-08-13', NOW), 'today');
});

const rows = [
  { title: 'old', sourceUpdated: '2024-01-01', words: 5000 },
  { title: 'new', sourceUpdated: '2026-08-10', words: 100 },
  { title: 'mid', sourceUpdated: '2025-06-15', words: 90000 },
  { title: 'undated', sourceUpdated: null, words: 50 },
];
const titles = (key) => sortMatches(rows, key).map((r) => r.title);

test('newest puts the most recently updated first', () => {
  assert.deepEqual(titles('newest'), ['new', 'mid', 'old', 'undated']);
});

test('oldest reverses the dated rows', () => {
  assert.deepEqual(titles('oldest'), ['old', 'mid', 'new', 'undated']);
});

test('undated rows sink to the bottom in BOTH directions', () => {
  // The bug this guards: reusing one comparator with swapped arguments floats
  // undated rows to the TOP of whichever direction it was not written for.
  assert.equal(titles('newest').at(-1), 'undated');
  assert.equal(titles('oldest').at(-1), 'undated');
});

test('longest and shortest sort by word count', () => {
  assert.deepEqual(titles('longest'), ['mid', 'old', 'new', 'undated']);
  assert.deepEqual(titles('shortest'), ['undated', 'new', 'old', 'mid']);
});

test('sortMatches does not mutate its input and passes unknown keys through', () => {
  const before = rows.map((r) => r.title);
  sortMatches(rows, 'newest');
  assert.deepEqual(rows.map((r) => r.title), before);
  assert.equal(sortMatches(rows, 'nonsense'), rows);
});
