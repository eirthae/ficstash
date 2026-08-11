import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCardTags, isPriorityTag, tidySummary } from './cardtags.js';

const T = (t, k = 'freeform') => ({ t, k });

test('drops the group\'s own tags (case-insensitive)', () => {
  const work = [T('Soulmates AU'), T('Slow Burn'), T('Fluff')];
  const shown = pickCardTags(work, ['soulmates au']).map((x) => x.t);
  assert.deepEqual(shown, ['Slow Burn', 'Fluff']);
});

test('floats content-warning tags to the front', () => {
  const work = [T('Fluff'), T('Slow Burn'), T('Major Character Death')];
  const shown = pickCardTags(work, [], 3).map((x) => x.t);
  assert.equal(shown[0], 'Major Character Death');
});

test('Dead Dove and Hurt/No Comfort are prioritized', () => {
  assert.ok(isPriorityTag(T('Dead Dove: Do Not Eat')));
  assert.ok(isPriorityTag(T('Hurt/No Comfort')));
  assert.ok(!isPriorityTag(T('Domestic Fluff')));
});

test('limits to N and de-dupes', () => {
  const work = [T('A'), T('A'), T('B'), T('C'), T('D')];
  const shown = pickCardTags(work, [], 3).map((x) => x.t);
  assert.deepEqual(shown, ['A', 'B', 'C']);
});

test('handles string tags and missing input', () => {
  assert.deepEqual(pickCardTags(['x', 'y'], ['x']), ['y']);
  assert.deepEqual(pickCardTags(null), []);
});

// ---- tidySummary -----------------------------------------------------------
// The worker stores AO3's summary verbatim, and `.summary` renders with
// white-space:pre-line, so leading newlines showed up as a huge blank gap
// between the byline and the text.

test('tidySummary strips the leading newlines that opened the gap', () => {
  assert.equal(tidySummary('\n\n\nShane at the Sochi Olympics.'), 'Shane at the Sochi Olympics.');
  assert.equal(tidySummary('   \n  \nA fic.'), 'A fic.');
});

test('tidySummary keeps deliberate paragraph breaks', () => {
  assert.equal(tidySummary('One.\n\nTwo.'), 'One.\n\nTwo.');
  assert.equal(tidySummary('One.\nTwo.'), 'One.\nTwo.');
});

test('tidySummary caps runs of blank lines at one', () => {
  assert.equal(tidySummary('One.\n\n\n\n\nTwo.'), 'One.\n\nTwo.');
});

test('tidySummary removes trailing whitespace, including per line', () => {
  assert.equal(tidySummary('One.   \n\nTwo.  \n\n  '), 'One.\n\nTwo.');
});

test('tidySummary normalises CRLF so Windows-stored rows collapse too', () => {
  assert.equal(tidySummary('\r\n\r\n\r\nOne.\r\n\r\n\r\n\r\nTwo.'), 'One.\n\nTwo.');
});

test('tidySummary handles null/undefined/empty without throwing', () => {
  for (const v of [null, undefined, '', '   \n\n  ']) assert.equal(tidySummary(v), '');
});
