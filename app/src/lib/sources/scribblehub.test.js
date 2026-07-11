import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import { shIdFromUrl, seriesUrl, parseSeries, parseToc, parseChapter } from './scribblehub.js';

// scribblehub.js parses with the WebView's DOMParser at runtime; linkedom supplies
// a compatible one for node --test. (fetchWork itself is native-only, not tested here.)
globalThis.DOMParser = DOMParser;

// ---- pure url / id logic ---------------------------------------------------
test('shIdFromUrl pulls the story id from /series/, /read/, and bare ids', () => {
  assert.equal(shIdFromUrl('https://www.scribblehub.com/series/2318244/some-title/'), '2318244');
  assert.equal(shIdFromUrl('https://www.scribblehub.com/read/862913-hp-arcane/chapter/1175961/'), '862913');
  assert.equal(shIdFromUrl('2318244'), '2318244');
  assert.equal(shIdFromUrl('https://example.com/nope'), '');
  assert.equal(shIdFromUrl(''), '');
});

test('seriesUrl builds the canonical series URL from an id or a URL', () => {
  assert.equal(seriesUrl('2318244'), 'https://www.scribblehub.com/series/2318244/');
  assert.equal(seriesUrl('https://www.scribblehub.com/series/2318244/x/'), 'https://www.scribblehub.com/series/2318244/');
});

// ---- series metadata parsing ----------------------------------------------
test('parseSeries pulls title/author/summary/genres/cover/canonical + ongoing default', () => {
  const html = `<html><head>
    <link rel="canonical" href="https://www.scribblehub.com/series/2318244/real-slug/"></head><body>
    <div class="fic_title">My Story Title</div>
    <span class="auth_name_fic">Author Name</span>
    <div class="wi_fic_desc">A description here.</div>
    <a class="fic_genre">Fantasy</a><a class="fic_genre">Action</a>
    <div class="fic_image"><img src="https://cdn.example/cover.jpg"></div>
    </body></html>`;
  const m = parseSeries(html, '2318244');
  assert.equal(m.title, 'My Story Title');
  assert.equal(m.author, 'Author Name');
  assert.equal(m.summary, 'A description here.');
  assert.deepEqual(m.tags, [{ t: 'Fantasy', k: 'freeform' }, { t: 'Action', k: 'freeform' }]);
  assert.equal(m.cover, 'https://cdn.example/cover.jpg');
  assert.equal(m.canonical, 'https://www.scribblehub.com/series/2318244/real-slug/');
  assert.equal(m.status, 'ongoing');
});

test('parseSeries detects a completed story and tolerates missing fields', () => {
  const m = parseSeries('<div class="fic_title">T</div><div class="fic_stats">Completed</div>', '1');
  assert.equal(m.status, 'complete');
  assert.equal(m.author, 'Unknown'); // missing → default, no throw
});

// ---- table of contents parsing --------------------------------------------
test('parseToc extracts a.toc_a chapters in order', () => {
  const html = `<div>
    <a class="toc_a" href="https://www.scribblehub.com/read/2318244-x/chapter/100/">Chapter 1</a>
    <a class="toc_a" href="https://www.scribblehub.com/read/2318244-x/chapter/101/">Chapter 2</a>
    <a class="other" href="/nope/">Not a chapter</a></div>`;
  const toc = parseToc(html);
  assert.equal(toc.length, 2);
  assert.equal(toc[0].title, 'Chapter 1');
  assert.equal(toc[0].url, 'https://www.scribblehub.com/read/2318244-x/chapter/100/');
  assert.equal(toc[1].title, 'Chapter 2');
});

// ---- chapter body parsing --------------------------------------------------
test('parseChapter returns #chp_raw prose, strips scripts, counts words', () => {
  const html = `<div id="chp_raw"><p>Hello brave new world.</p><script>evil()</script><ins class="adsbygoogle"></ins></div>`;
  const c = parseChapter(html);
  assert.match(c.html, /<p>Hello brave new world\.<\/p>/);
  assert.doesNotMatch(c.html, /evil\(\)/);       // script removed
  assert.doesNotMatch(c.html, /adsbygoogle/);    // ad removed
  assert.equal(c.words, 4);
});

test('parseChapter with no #chp_raw returns empty (missing element is safe)', () => {
  const c = parseChapter('<div>no chapter body here</div>');
  assert.equal(c.html, '');
  assert.equal(c.words, 0);
});
