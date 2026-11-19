import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';
import {
  rrSlug, royalRoadSearchUrl, shGenreId, scribbleHubStart,
  parseRoyalRoadList, parseScribbleHubList, filterSiteResults, siteMatchRow, siteForHost,
} from './sitesearch-pure.js';

const doc = (html) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');

// ---- URLs --------------------------------------------------------------------
test('Royal Road search uses stored slugs and maps excluded names through the taxonomy', () => {
  const url = royalRoadSearchUrl(
    [{ name: 'Male Gay Romance', id: 'gay_romance' }],
    ['Portal Fantasy / Isekai', 'Harem', 'Some New Tag'],
  );
  const p = new URL(url).searchParams;
  assert.deepEqual(p.getAll('tagsAdd'), ['gay_romance']);
  assert.deepEqual(p.getAll('tagsRemove'), ['summoned_hero', 'harem', 'some_new_tag']);
  assert.equal(p.get('orderBy'), 'last_update');
  assert.equal(rrSlug(''), '');
});

test('Scribble Hub: genres-only groups get an exact Series Finder search', () => {
  const s = scribbleHubStart([{ name: 'Boys Love', id: 'boys-love' }], ['Isekai', 'Harem']);
  assert.equal(s.exact, true);
  const p = new URL(s.url).searchParams;
  assert.equal(p.get('gi'), '891');
  assert.equal(p.get('mgi'), 'and');
  assert.equal(p.get('ge'), '37,1015');
  assert.equal(shGenreId({ name: 'Omegaverse', id: 'omegaverse' }), null);
});

test('Scribble Hub: a group with a tag starts on that tag\'s own listing', () => {
  const s = scribbleHubStart([{ name: 'Omegaverse', id: 'omegaverse' }, { name: 'Boys Love', id: 'boys-love' }]);
  assert.equal(s.exact, false);
  assert.equal(s.url, 'https://www.scribblehub.com/tag/omegaverse/');
});

// ---- parsers ---------------------------------------------------------------
const RR_CARD = `
<div class="fiction-list-item row">
  <figure><a href="/fiction/145386/the-ride"><img></a></figure>
  <div class="col">
    <h2 class="fiction-title"><a href="/fiction/145386/the-ride" class="font-red-sunglo bold">The Ride</a></h2>
    <div class="tags"><span class="label label-default label-sm bg-blue-hoki">ONGOING</span>
      <span class="tags"><a class="label label-default fiction-tag" href="/fictions/search?tagsAdd=gay_romance">Male Gay Romance</a>
      <a class="label label-default fiction-tag" href="/fictions/search?tagsAdd=drama">Drama</a></span></div>
    <div class="row stats"><div class="col-sm-6"><span>1,234 Followers</span></div>
      <div class="col-sm-6"><span>12 Chapters</span></div></div>
    <div id="description-145386" class="hidden-content">Two men,   one car.</div>
  </div>
</div>
<div class="fiction-list-item row">
  <h2 class="fiction-title"><a href="/fiction/164939/galaxy">Galaxy Fantasy</a></h2>
  <span class="label label-default">COMPLETED</span>
  <div class="stats"><span>82 Chapters</span></div>
</div>
<div class="fiction-list-item row"><h2 class="fiction-title"><a href="/fiction/145386/dup">Dup</a></h2></div>`;

test('Royal Road cards parse to id, title, summary, tags, status and chapters', () => {
  const r = parseRoyalRoadList(doc(RR_CARD));
  assert.equal(r.length, 2, 'duplicate ids collapse');
  assert.deepEqual(r[0], {
    sourceId: '145386', title: 'The Ride', author: '', summary: 'Two men, one car.',
    tags: [{ t: 'Male Gay Romance', k: 'freeform' }, { t: 'Drama', k: 'freeform' }],
    status: 'ongoing', chapters: 12, words: 0,
  });
  assert.equal(r[1].status, 'complete');
  assert.equal(r[1].chapters, 82);
});

const SH_CARD = `
<div class="search_main_box">
  <div class="search_body">
    <div class="search_title"><a href="https://www.scribblehub.com/series/1047/a-tale/">A &amp; Tale</a></div>
    <div class="search_stats"><span>Ongoing</span> · <span>1,051 Chapters</span></div>
    <div class="search_genre"><a href="/genre/boys-love/">Boys Love</a><a href="/genre/fantasy/">Fantasy</a></div>
  </div>
  <div class="search_body">
    <div class="search_title"><a href="https://www.scribblehub.com/series/2222/done/">Done</a></div>
    <div class="search_stats"><span>Completed</span> <span>40 Chapters</span></div>
    <div class="search_genre"><a href="/genre/romance/">Romance</a></div>
  </div>
</div>`;

test('Scribble Hub cards parse to id, title, genres, status and chapters', () => {
  const r = parseScribbleHubList(doc(SH_CARD));
  assert.equal(r.length, 2);
  assert.equal(r[0].sourceId, '1047');
  assert.equal(r[0].title, 'A & Tale');
  assert.deepEqual(r[0].tags.map((t) => t.t), ['Boys Love', 'Fantasy']);
  assert.equal(r[0].status, 'ongoing');
  assert.equal(r[0].chapters, 1051);
  assert.equal(r[1].status, 'complete');
});

test('counts survive markup with no whitespace between elements', () => {
  const tight = '<div class="fiction-list-item"><h2 class="fiction-title"><a href="/fiction/9/x">T</a></h2>'
    + '<div class="stats"><span>12 Chapters</span></div><div id="description-9">Two men.</div></div>';
  assert.equal(parseRoyalRoadList(doc(tight))[0].chapters, 12);
  const shTight = '<div class="search_body"><div class="search_title"><a href="https://www.scribblehub.com/series/5/x/">S</a></div>'
    + '<div class="search_stats">Completed40 Chapters</div></div>';
  assert.equal(parseScribbleHubList(doc(shTight))[0].chapters, 40);
});

test('a challenge page, an empty page or junk parse to nothing', () => {
  const challenge = doc('<title>Just a moment...</title><div>Enable JavaScript and cookies to continue</div>');
  assert.deepEqual(parseRoyalRoadList(challenge), []);
  assert.deepEqual(parseScribbleHubList(challenge), []);
  assert.deepEqual(parseRoyalRoadList(doc('')), []);
});

test('the parsers survive being injected: they reference nothing outside themselves', () => {
  for (const fn of [parseRoyalRoadList, parseScribbleHubList]) {
    // Re-create from source text alone, exactly as the in-app browser does.
    const rebuilt = new Function(`return (${fn.toString()});`)();
    assert.equal(typeof rebuilt, 'function');
  }
  const rebuiltRR = new Function(`return (${parseRoyalRoadList.toString()});`)();
  assert.equal(rebuiltRR(doc(RR_CARD)).length, 2);
});

// ---- filtering and rows ----------------------------------------------------
test('results are filtered by dismissed, status, excluded tags and required genres', () => {
  const items = parseScribbleHubList(doc(SH_CARD));
  const dismissed = new Set(['scribblehub:2222']);
  assert.deepEqual(filterSiteResults(items, { source: 'scribblehub', dismissed }).map((i) => i.sourceId), ['1047']);
  assert.deepEqual(filterSiteResults(items, { source: 'scribblehub', status: 'complete' }).map((i) => i.sourceId), ['2222']);
  assert.deepEqual(filterSiteResults(items, { source: 'scribblehub', excludeNames: ['Fantasy'] }).map((i) => i.sourceId), ['2222']);
  assert.deepEqual(filterSiteResults(items, { source: 'scribblehub', requireGenres: ['boys love'] }).map((i) => i.sourceId), ['1047']);
});

test('a row never nulls a NOT NULL column, even from an almost-empty item', () => {
  const row = siteMatchRow('g', 'royalroad', { sourceId: 7 });
  for (const col of ['title', 'author', 'fandom', 'summary', 'tags', 'words', 'chapters', 'status', 'palette']) {
    assert.notEqual(row[col], null, col);
    assert.notEqual(row[col], undefined, col);
  }
  assert.equal(row.source, 'royalroad');
  assert.equal(row.source_work_id, '7');
  assert.equal(row.chapters, 0);
  assert.equal(row.status, 'ongoing');
});

test('host detection', () => {
  assert.equal(siteForHost('https://www.royalroad.com/fictions/search?x'), 'royalroad');
  assert.equal(siteForHost('https://www.scribblehub.com/series-finder/'), 'scribblehub');
  assert.equal(siteForHost('https://evil.example/royalroad.com'), '');
  assert.equal(siteForHost('https://archiveofourown.org/'), '');
});
