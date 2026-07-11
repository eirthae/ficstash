import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normGroup, matchRow, bookMatchRow, workRow, chapterRows, paletteFor,
  newChapters, chapterUpdateRows, seriesFetchPlan, isDefinitiveFailure,
} from './ondevice-pure.js';

// ---- isDefinitiveFailure (Failed-stash gating) -----------------------------
test('isDefinitiveFailure: 404 / cannot-find are definitive, throttle/network are not', () => {
  assert.equal(isDefinitiveFailure('AO3 HTTP 404'), true);
  assert.equal(isDefinitiveFailure('InvalidIdError: Cannot find work'), true);
  assert.equal(isDefinitiveFailure('Scribble Hub HTTP 404'), true);
  assert.equal(isDefinitiveFailure('AO3 HTTP 525'), false);       // transient → keep retrying
  assert.equal(isDefinitiveFailure('network request failed'), false);
  assert.equal(isDefinitiveFailure(''), false);
  assert.equal(isDefinitiveFailure(null), false);
});

// ---- normGroup -------------------------------------------------------------
test('normGroup handles a mapGroup() shape (camelCase)', () => {
  const g = normGroup({
    id: 'g1', source: 'ao3', matchMode: 'any', status: 'complete',
    tags: [{ name: 'Hockey', kind: 'fandom' }, { name: 'Fluff', kind: 'freeform' }],
    excludedTags: [{ name: 'Explicit' }],
  });
  assert.equal(g.id, 'g1');
  assert.equal(g.matchMode, 'any');
  assert.equal(g.status, 'complete');
  assert.deepEqual(g.include, ['Hockey', 'Fluff']);
  assert.deepEqual(g.excluded, ['Explicit']);
  assert.equal(g.langCode, null);
});

test('normGroup handles a raw tracked_groups row (snake_case) + defaults', () => {
  const g = normGroup({ id: 'g2', tags: [{ name: 'Angst' }], excluded_tags: [], match_mode: undefined });
  assert.equal(g.source, 'ao3');     // default
  assert.equal(g.matchMode, 'all');  // default
  assert.equal(g.status, 'all');     // default
  assert.deepEqual(g.include, ['Angst']);
});

test('normGroup splits out a language tag as langCode (not an include)', () => {
  const g = normGroup({ id: 'g3', tags: [{ name: 'Armenian', id: 'hy', kind: 'language' }] });
  assert.equal(g.langCode, 'hy');
  assert.deepEqual(g.include, []);
});

test('normGroup exposes slug ids for romance.io (includeIds/excludeIds)', () => {
  const g = normGroup({
    id: 'r1', source: 'romanceio',
    tags: [{ name: 'enemies to lovers', id: 'from hate to love', kind: 'topic' }],
    excluded_tags: [{ name: 'cheating', id: 'cheating', kind: 'topic' }],
  });
  assert.deepEqual(g.includeIds, ['from hate to love']);
  assert.deepEqual(g.excludeIds, ['cheating']);
});

// ---- bookMatchRow ----------------------------------------------------------
test('bookMatchRow builds a metadata-only romance.io match (series → fandom, steam/rating tags)', () => {
  const row = bookMatchRow('grp', {
    sourceWorkId: 'abc', title: 'The Long Game', author: 'Rachel Reid',
    summary: 'hockey', series: 'Game Changers', rating: 4.6, steam: 'Explicit and plentiful',
  });
  assert.equal(row.source, 'romanceio');
  assert.equal(row.source_work_id, 'abc');
  assert.equal(row.fandom, 'Game Changers'); // series shown in the fandom slot
  assert.equal(row.status, 'complete');
  assert.equal(row.words, 0);
  assert.deepEqual(row.tags, [{ t: '★ 4.6', k: 'freeform' }, { t: 'Explicit and plentiful', k: 'rating' }]);
});

// ---- matchRow --------------------------------------------------------------
test('matchRow builds the tag_matches shape and passes {t,k} tags through', () => {
  const row = matchRow('grp', {
    sourceId: '123', title: 'A Work', author: 'me', fandom: 'Hockey',
    summary: 'sum', tags: [{ t: 'Fluff', k: 'freeform' }], words: 5000, status: 'ongoing',
  });
  assert.equal(row.group_id, 'grp');
  assert.equal(row.source, 'ao3');
  assert.equal(row.source_work_id, '123');
  assert.deepEqual(row.tags, [{ t: 'Fluff', k: 'freeform' }]);
  assert.equal(row.words, 5000);
  assert.equal(row.chapters, null);           // not provided → null (worker parity)
  assert.equal(typeof row.palette, 'number');
  // user-state columns are omitted so DB defaults apply + batch keys stay uniform
  for (const k of ['seen', 'first_seen_at', 'dismissed', 'later', 'wanted', 'saved']) {
    assert.equal(k in row, false, `${k} must be omitted`);
  }
});

test('matchRow coerces a numeric id to string and defaults title', () => {
  const row = matchRow('g', { sourceId: 999 });
  assert.equal(row.source_work_id, '999');
  assert.equal(row.title, 'Untitled');
});

// ---- workRow ---------------------------------------------------------------
test('workRow builds the works shape, follow derived from status, offline set', () => {
  const row = workRow({
    sourceId: '42', title: 'T', author: 'a', fandom: 'F', summary: 's',
    tags: [{ t: 'x', k: 'freeform' }], words: 1000, chapters: 3, chaptersTotal: 5, status: 'ongoing',
  }, 'tag');
  assert.equal(row.source, 'ao3'); // no parsed.source → AO3 default (regression guard)
  assert.equal(row.source_work_id, '42');
  assert.equal(row.chapters, 3);
  assert.equal(row.chapters_total, 5);
  assert.equal(row.status, 'ongoing');
  assert.equal(row.follow, true);   // ongoing → followed
  assert.equal(row.offline, true);
  assert.equal(row.hidden, false);
  assert.equal(row.origin, 'tag');
  assert.equal(row.pairing, '');
});

test('workRow unfollows a complete work and includes series fields when present', () => {
  const row = workRow({
    sourceId: '7', title: 'T', status: 'complete',
    ao3SeriesId: '88', series: 'My Series', seriesIndex: 2, chaptersTotal: 4,
  }, 'link');
  assert.equal(row.follow, false);  // complete → not followed
  assert.equal(row.ao3_series_id, '88');
  assert.equal(row.ao3_series_name, 'My Series');
  assert.equal(row.ao3_series_index, 2);
  assert.equal(row.origin, 'link');
});

test('workRow honors parsed.source (Scribble Hub stores as scribblehub)', () => {
  const row = workRow({
    source: 'scribblehub', sourceId: '2318244', title: 'A Story', author: 'w',
    tags: [{ t: 'Fantasy', k: 'freeform' }], words: 5000, chapters: 12, status: 'ongoing',
  }, 'tag');
  assert.equal(row.source, 'scribblehub');
  assert.equal(row.source_work_id, '2318244');
  assert.equal(row.follow, true);
  assert.equal(row.offline, true);
});

// ---- chapterRows -----------------------------------------------------------
test('chapterRows maps bodies and gates `fetched` on real text', () => {
  const rows = chapterRows('w1', [
    { n: 1, title: 'One', words: 10, content: '<p>hi</p>' },
    { n: 2, title: '', words: 0, content: '   ' },   // whitespace-only → not fetched
    { n: 3, title: '', words: 0, content: '' },       // empty → not fetched, title defaulted
  ]);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].work_id, 'w1');
  assert.equal(rows[0].fetched, true);
  assert.equal(rows[1].fetched, false);
  assert.equal(rows[2].fetched, false);
  assert.equal(rows[2].title, 'Chapter 3');
});

test('chapterRows on empty input is empty', () => {
  assert.deepEqual(chapterRows('w', []), []);
  assert.deepEqual(chapterRows('w', null), []);
});

// ---- paletteFor ------------------------------------------------------------
test('paletteFor is a stable non-negative index', () => {
  const a = paletteFor('Hockey');
  const b = paletteFor('Hockey');
  assert.equal(a, b);
  assert.ok(a >= 0 && Number.isInteger(a));
});

// ---- newChapters (getting new chapters on an ongoing work) ------------------
const work5of7 = {
  chaptersData: Array.from({ length: 7 }, (_, i) => ({ n: i + 1, title: `Ch ${i + 1}`, words: 100, content: `<p>c${i + 1}</p>` })),
};
test('newChapters returns only chapters beyond the stored count', () => {
  const fresh = newChapters(5, work5of7);
  assert.deepEqual(fresh.map((c) => c.n), [6, 7]);
});
test('newChapters returns [] when nothing is new (caught up / shrunk)', () => {
  assert.deepEqual(newChapters(7, work5of7), []);
  assert.deepEqual(newChapters(9, work5of7), []);
});
test('newChapters treats a 0/blank stored count as "all are new"', () => {
  assert.equal(newChapters(0, work5of7).length, 7);
  assert.equal(newChapters(undefined, work5of7).length, 7);
  assert.deepEqual(newChapters(2, { chaptersData: null }), []);
});

// ---- chapterUpdateRows (the New-chapters feed write) -----------------------
test('chapterUpdateRows builds the chapter_updates shape from new chapters', () => {
  const rows = chapterUpdateRows(
    { id: 'w-uuid', source: 'ao3', source_work_id: '123' },
    [{ n: 6, title: 'Six', words: 90 }, { n: 7, title: '', words: 0 }],
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { work_id: 'w-uuid', source: 'ao3', source_work_id: '123', chapter_n: 6, title: 'Six', words: 90 });
  assert.equal(rows[1].title, 'Chapter 7'); // blank title defaulted
});

// ---- seriesFetchPlan (new work in a series + download all) -----------------
const series = [
  { id: '11', title: 'Part 1' }, { id: '12', title: 'Part 2' },
  { id: '13', title: 'Part 3' }, { id: '14', title: 'Part 4' },
];
test('seriesFetchPlan: download-all from empty fetches every work, indexed in order', () => {
  const plan = seriesFetchPlan(series, new Set());
  assert.deepEqual(plan.toFetch.map((e) => [e.id, e.index]), [['11', 1], ['12', 2], ['13', 3], ['14', 4]]);
  assert.equal(plan.have.length, 0);
  assert.equal(plan.hitCap, false);
});
test('seriesFetchPlan: only the NEW work is fetched; owned ones are re-tagged with their index', () => {
  const plan = seriesFetchPlan(series, new Set(['11', '12', '13']));
  assert.deepEqual(plan.toFetch.map((e) => e.id), ['14']);
  assert.equal(plan.toFetch[0].index, 4); // keeps its position in the series
  assert.deepEqual(plan.have.map((e) => e.id), ['11', '12', '13']);
});
test('seriesFetchPlan caps the fetch count and flags hitCap', () => {
  const plan = seriesFetchPlan(series, new Set(), 2);
  assert.deepEqual(plan.toFetch.map((e) => e.id), ['11', '12']);
  assert.equal(plan.hitCap, true);
});
