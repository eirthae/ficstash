import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normGroup, matchRow, workRow, chapterRows, paletteFor } from './ondevice-pure.js';

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
