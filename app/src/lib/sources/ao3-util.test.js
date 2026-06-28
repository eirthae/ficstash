import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAo3Url, workIdFromUrl, fullWorkUrl, workUrl, parseChapterStat, searchUrl, languageSearchUrl,
} from './ao3-util.js';

// ---- parseChapterStat ------------------------------------------------------
test('parseChapterStat reads have/total and derives status', () => {
  assert.deepEqual(parseChapterStat('5/12'), { chapters: 5, total: 12, status: 'ongoing' });
  assert.deepEqual(parseChapterStat('12/12'), { chapters: 12, total: 12, status: 'complete' });
  assert.deepEqual(parseChapterStat('3/?'), { chapters: 3, total: null, status: 'ongoing' });
  assert.deepEqual(parseChapterStat('1,234/1,234'), { chapters: 1234, total: 1234, status: 'complete' });
  assert.deepEqual(parseChapterStat(''), { chapters: 0, total: null, status: 'ongoing' });
  assert.deepEqual(parseChapterStat(null), { chapters: 0, total: null, status: 'ongoing' });
});

// ---- isAo3Url --------------------------------------------------------------
test('isAo3Url recognises AO3 links only', () => {
  assert.equal(isAo3Url('https://archiveofourown.org/works/123'), true);
  assert.equal(isAo3Url('http://www.archiveofourown.org/works/1'), true);
  assert.equal(isAo3Url('https://royalroad.com/fiction/1'), false);
  assert.equal(isAo3Url(''), false);
  assert.equal(isAo3Url(null), false);
});

// ---- workIdFromUrl ---------------------------------------------------------
test('workIdFromUrl pulls the work id from any AO3 work URL', () => {
  assert.equal(workIdFromUrl('https://archiveofourown.org/works/456'), '456');
  assert.equal(workIdFromUrl('https://archiveofourown.org/works/789/chapters/22'), '789');
  assert.equal(workIdFromUrl('https://archiveofourown.org/collections/x/works/321'), '321');
  assert.equal(workIdFromUrl('https://archiveofourown.org/series/5'), '');
  assert.equal(workIdFromUrl(''), '');
});

// ---- url builders ----------------------------------------------------------
test('fullWorkUrl pre-consents the adult gate and asks for the whole work', () => {
  assert.equal(fullWorkUrl('9'), 'https://archiveofourown.org/works/9?view_full_work=true&view_adult=true');
  assert.equal(workUrl('9'), 'https://archiveofourown.org/works/9');
});

test('searchUrl ANDs includes, subtracts excludes, sorts newest-first', () => {
  const u = searchUrl(['hockey', 'enemies to lovers'], ['Explicit'], 2);
  const q = new URL(u).searchParams;
  assert.equal(q.get('work_search[other_tag_names]'), 'hockey,enemies to lovers');
  assert.equal(q.get('work_search[excluded_tag_names]'), 'Explicit');
  assert.equal(q.get('work_search[sort_column]'), 'created_at');
  assert.equal(q.get('page'), '2');
});

test('searchUrl omits excluded + page when not given', () => {
  const u = searchUrl(['fluff']);
  const q = new URL(u).searchParams;
  assert.equal(q.get('work_search[other_tag_names]'), 'fluff');
  assert.equal(q.has('work_search[excluded_tag_names]'), false);
  assert.equal(q.has('page'), false);
});

test('languageSearchUrl filters by language_id, newest-first', () => {
  const q = new URL(languageSearchUrl('hy')).searchParams;
  assert.equal(q.get('work_search[language_id]'), 'hy');
  assert.equal(q.get('work_search[sort_column]'), 'created_at');
});
