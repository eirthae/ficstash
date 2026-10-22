import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';

// parseSearchResults runs on the WebView's DOMParser at runtime; linkedom
// supplies one here, the same way scribblehub.test.js does.
globalThis.DOMParser = DOMParser;
const { parseSearchResults } = await import('./ao3.js');

// Every tag-group match in the app comes through this function, and it had NO
// test at all — which is how on-device discovery managed to write zero rows for
// four months without a single test going red. A parser that silently returns []
// is indistinguishable from "this tag has nothing new", so the failure mode is
// invisible by construction. These tests make it visible.

// A real AO3 search blurb, structured as AO3 serves it.
const BLURB = `
<ol class="work index group">
  <li class="work blurb group" id="work_12345" role="article">
    <div class="header module">
      <h4 class="heading">
        <a href="/works/12345">Read Receipts</a> by
        <a rel="author" href="/users/after_hours">after_hours</a>
      </h4>
      <h5 class="fandoms heading"><a class="tag" href="/t/x">Hockey RPF</a></h5>
    </div>
    <ul class="tags commas">
      <li class="relationships"><a class="tag" href="/t/r">Shane Hollander/Ilya Rozanov</a></li>
      <li class="characters"><a class="tag" href="/t/c">Ilya Rozanov</a></li>
      <li class="freeforms"><a class="tag" href="/t/f">Texting</a></li>
    </ul>
    <blockquote class="userstuff summary"><p>They text a lot.</p></blockquote>
    <p class="datetime">14 Aug 2025</p>
    <dl class="stats">
      <dd class="language" lang="en">English</dd>
      <dd class="words">9,800</dd>
      <dd class="chapters">3/?</dd>
    </dl>
  </li>
</ol>`;

test('a search blurb becomes a match with everything the feed needs', () => {
  const [w] = parseSearchResults(BLURB);
  assert.equal(w.sourceId, '12345');
  assert.equal(w.title, 'Read Receipts');
  assert.equal(w.author, 'after_hours');
  assert.equal(w.fandom, 'Hockey RPF');
  assert.equal(w.summary, 'They text a lot.');
  assert.equal(w.words, 9800);
  assert.equal(w.status, 'ongoing');          // 3/? is unfinished
  assert.equal(w.chapters, 3);                // posted count — see below
  assert.equal(w.chaptersTotal, null);
  assert.equal(w.updated, '2025-08-14');      // the blurb date the feed sorts by
  assert.equal(w.url, 'https://archiveofourown.org/works/12345');
  assert.deepEqual(w.tags, [
    { t: 'Shane Hollander/Ilya Rozanov', k: 'relationship' },
    { t: 'Ilya Rozanov', k: 'character' },
    { t: 'Texting', k: 'freeform' },
  ]);
});

test('a finished work reads as complete', () => {
  const [w] = parseSearchResults(BLURB.replace('3/?', '12/12'));
  assert.equal(w.status, 'complete');
  assert.equal(w.chapters, 12);
  assert.equal(w.chaptersTotal, 12);
});

// The four-month bug, from the parser's side. `chapters` was simply never
// emitted here, matchRow turned the missing value into an explicit null, and
// tag_matches.chapters is NOT NULL — so Postgres rejected every row the app
// tried to write, for every group, since June. A blurb with no stats at all
// must still yield a usable number rather than nothing.
test('every parsed match carries a chapter count — the column is NOT NULL', () => {
  for (const [stat, expected] of [['3/?', 3], ['12/12', 12], ['1/1', 1]]) {
    const [w] = parseSearchResults(BLURB.replace('3/?', stat));
    assert.equal(typeof w.chapters, 'number', `${stat} should give a numeric count`);
    assert.equal(w.chapters, expected);
  }
  // A blurb with no stats block at all: still a number, never null/undefined.
  const [bare] = parseSearchResults(BLURB.replace(/<dl class="stats">[\s\S]*?<\/dl>/, ''));
  assert.equal(typeof bare.chapters, 'number');
  assert.equal(bare.chapters, 0);
});

test('several blurbs all come through', () => {
  const two = BLURB.replace('</ol>', BLURB.replace(/<\/?ol[^>]*>/g, '').replace(/12345/g, '67890') + '</ol>');
  assert.equal(parseSearchResults(two).length, 2);
});

test("AO3's own 'no results' page parses as empty, not as a crash", () => {
  const none = '<div id="main"><h2 class="heading">No results found</h2></div>';
  assert.deepEqual(parseSearchResults(none), []);
});

// The failure that actually bit us: AO3 serving an error page instead of
// results. Empty is the only honest answer here, but the CALLER has to treat it
// as a failure, not as "nothing new" — searchTags does that by checking the HTTP
// status before it ever gets here. If that check is ever dropped, a Cloudflare
// error page becomes a silently empty tag again.
test('a Cloudflare error page yields no matches rather than throwing', () => {
  const err = '<html><head><title>archiveofourown.org | 525: SSL handshake failed</title></head>'
    + '<body><h1>Error 525</h1><p>SSL handshake failed</p></body></html>';
  assert.deepEqual(parseSearchResults(err), []);
});

test('junk and empty input are survivable', () => {
  assert.deepEqual(parseSearchResults(''), []);
  assert.deepEqual(parseSearchResults(null), []);
  assert.deepEqual(parseSearchResults('<li class="work blurb group">no heading</li>'), []);
});
