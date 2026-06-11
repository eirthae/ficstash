import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal in-memory localStorage so reading.js runs under `node --test`.
globalThis.localStorage = (() => {
  let store = {};
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { store = {}; },
  };
})();

const { getReadingPos, getChapterPos, saveReadingPos } = await import('./reading.js');

beforeEach(() => globalThis.localStorage.clear());

test('saveReadingPos / getChapterPos round-trips per chapter', () => {
  saveReadingPos('w1', { chapter: 2, pct: 0.4 });
  saveReadingPos('w1', { chapter: 5, pct: 0.9 });
  assert.equal(getChapterPos('w1', 2), 0.4);
  assert.equal(getChapterPos('w1', 5), 0.9);
  assert.equal(getChapterPos('w1', 3), 0); // never visited
});

test('reading a later chapter does not lose an earlier chapter position', () => {
  // The bug this fixes: ch2 near the end, read ahead to ch3, come back to ch2.
  saveReadingPos('w1', { chapter: 2, pct: 0.95 });
  saveReadingPos('w1', { chapter: 3, pct: 0.1 });
  assert.equal(getChapterPos('w1', 2), 0.95); // ch2 still remembered
});

test('getReadingPos resumes at the last chapter touched + its scroll', () => {
  saveReadingPos('w1', { chapter: 2, pct: 0.5 });
  saveReadingPos('w1', { chapter: 7, pct: 0.3 });
  assert.deepEqual(getReadingPos('w1'), { chapter: 7, pct: 0.3 });
});

test('pct is clamped to [0,1] and unknown work resumes to null', () => {
  saveReadingPos('w1', { chapter: 1, pct: 5 });
  assert.equal(getChapterPos('w1', 1), 1);
  saveReadingPos('w1', { chapter: 1, pct: -3 });
  assert.equal(getChapterPos('w1', 1), 0);
  assert.equal(getReadingPos('nope'), null);
});

test('migrates the legacy { chapter, pct } shape on read', () => {
  globalThis.localStorage.setItem('fs-readpos', JSON.stringify({ w9: { chapter: 4, pct: 0.6 } }));
  assert.deepEqual(getReadingPos('w9'), { chapter: 4, pct: 0.6 });
  assert.equal(getChapterPos('w9', 4), 0.6);
});

test('saveReadingPos ignores calls with no chapter', () => {
  saveReadingPos('w1', { chapter: 0, pct: 0.5 });
  assert.equal(getReadingPos('w1'), null);
});
