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

const {
  getReadingPos, getChapterPos, saveReadingPos, initReadingStore,
  getReadingTime, addReadingTime, mergeReading, absorbRemoteReadingTime,
} = await import('./reading.js');

// The store keeps an in-memory cache so the library can sort synchronously, so a
// reset means clearing the backing store AND re-hydrating — which is exactly what
// the app does at startup.
beforeEach(async () => { globalThis.localStorage.clear(); await initReadingStore(); });

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

test('migrates the legacy { chapter, pct } shape on read', async () => {
  // Seeded from OUTSIDE the store, so it needs a hydrate to be picked up — the
  // same path a real cold start takes.
  globalThis.localStorage.setItem('fs-readpos', JSON.stringify({ w9: { chapter: 4, pct: 0.6 } }));
  await initReadingStore();
  assert.deepEqual(getReadingPos('w9'), { chapter: 4, pct: 0.6 });
  assert.equal(getChapterPos('w9', 4), 0.6);
});

test('saveReadingPos ignores calls with no chapter', () => {
  saveReadingPos('w1', { chapter: 0, pct: 0.5 });
  assert.equal(getReadingPos('w1'), null);
});

// ---- time spent -------------------------------------------------------------

test('addReadingTime accumulates across sessions', () => {
  addReadingTime('w1', 30);
  addReadingTime('w1', 95);
  assert.equal(Math.round(getReadingTime().w1), 125);
});

test('addReadingTime(0) creates a record, marking the work as tracked', () => {
  // This is what separates "opened since we tracked time, and bounced" from
  // "opened long ago, before any of this existed".
  addReadingTime('w2', 0);
  assert.equal(getReadingTime().w2, 0);
  assert.ok('w2' in getReadingTime());
});

test('addReadingTime(0) never clobbers time already banked', () => {
  addReadingTime('w3', 60);
  addReadingTime('w3', 0);
  assert.equal(getReadingTime().w3, 60);
});

// ---- merge ------------------------------------------------------------------
// Preferences is the durable copy, but localStorage can hold writes made after
// the last successful Preferences write, so neither side wins outright.

test('mergeReading keeps the higher time from either copy', () => {
  const out = mergeReading('fs-readtime', { a: 300, b: 10 }, { a: 60, c: 5 });
  assert.deepEqual(out, { a: 300, b: 10, c: 5 });
});

test('mergeReading unions chapter positions, keeping the furthest in each', () => {
  const a = { w1: { chapters: { 1: 1, 2: 0.2 }, last: 2, at: '2026-01-01' } };
  const b = { w1: { chapters: { 2: 0.9, 3: 0.4 }, last: 3, at: '2026-02-01' } };
  const out = mergeReading('fs-readpos', a, b);
  assert.deepEqual(out.w1.chapters, { 1: 1, 2: 0.9, 3: 0.4 });
  assert.equal(out.w1.last, 3); // the newer entry decides where to resume
});

test('mergeReading keeps the latest open timestamp', () => {
  const out = mergeReading('fs-lastread', { a: '2026-01-01' }, { a: '2026-08-01', b: '2026-03-01' });
  assert.deepEqual(out, { a: '2026-08-01', b: '2026-03-01' });
});

test('absorbRemoteReadingTime pulls history back from the work rows', () => {
  // The reinstall case: the device store is empty, the cloud copy is not.
  assert.equal(absorbRemoteReadingTime([{ id: 'w7', readSeconds: 420 }]), true);
  assert.equal(getReadingTime().w7, 420);
});

test('absorbRemoteReadingTime never lowers a local value', () => {
  addReadingTime('w8', 500);
  assert.equal(absorbRemoteReadingTime([{ id: 'w8', readSeconds: 100 }]), false);
  assert.equal(getReadingTime().w8, 500);
});
