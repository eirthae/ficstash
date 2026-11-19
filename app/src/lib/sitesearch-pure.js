// Royal Road / Scribble Hub discovery through a browser YOU drive.
//
// Both sites put a Cloudflare challenge in front of every automated request —
// the worker, and plain requests from a home connection alike (verified
// 2026-11-18; Scribble Hub escalated to a hard block mid-test). A real browser
// passes that check, so FicStash opens the site's search in an in-app browser,
// you browse it like any page, and tapping "Add to FicStash" reads the results
// that are on your screen into the group.
//
// The line this module holds: nothing here makes a request. The app only ever
// reads a page the person has loaded themselves, at the moment they ask. No
// background fetches, no automatic paging, no chapter downloads (saving a work
// would mean driving the browser through every chapter page automatically —
// the bulk fetching the check exists to stop).
//
// Everything here is pure, so it is tested in Node. The two parse* functions are
// ALSO injected into the site's page verbatim (via Function.prototype.toString),
// so they must stay self-contained: no imports, no outer-scope references, all
// helpers declared inside the function body.

import { ROYALROAD_GENRES, ROYALROAD_TAGS } from '../sources/taxonomies.js';
import { paletteFor } from './ondevice-pure.js';

export const SITE_SOURCES = ['royalroad', 'scribblehub'];

// ---- Royal Road ------------------------------------------------------------

const RR_SLUG_BY_NAME = Object.fromEntries(
  [...ROYALROAD_GENRES, ...ROYALROAD_TAGS].map((t) => [t.name.toLowerCase(), t.slug]),
);

// A Royal Road search slug for a stored tag ({id, name}) or a bare name. The
// stored id IS the slug when the group was built from the taxonomy; a bare name
// (global excludes are stored by name) maps through the taxonomy, falling back to
// Royal Road's own convention: lowercase, runs of non-alphanumerics → "_".
export function rrSlug(t) {
  if (!t) return '';
  if (typeof t === 'object' && t.id) return String(t.id).trim();
  const name = String((typeof t === 'object' ? t.name : t) || '').trim();
  if (!name) return '';
  return RR_SLUG_BY_NAME[name.toLowerCase()]
    || name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

// Royal Road's fiction search ANDs repeated tagsAdd and subtracts tagsRemove —
// exactly a tracked group's semantics — newest-updated first.
export function royalRoadSearchUrl(include, exclude = []) {
  const p = new URLSearchParams();
  for (const s of [...new Set((include || []).map(rrSlug).filter(Boolean))]) p.append('tagsAdd', s);
  for (const s of [...new Set((exclude || []).map(rrSlug).filter(Boolean))]) p.append('tagsRemove', s);
  p.append('orderBy', 'last_update');
  p.append('dir', 'desc');
  return `https://www.royalroad.com/fictions/search?${p.toString()}`;
}

// ---- Scribble Hub ----------------------------------------------------------

// Scribble Hub's numeric genre ids (the Series Finder keys on these, not slugs).
// Same table as the worker's scribblehub.py.
const SH_GENRE_ID = {
  action: 9, adult: 902, adventure: 8, 'boys love': 891, comedy: 7,
  drama: 903, ecchi: 904, fanfiction: 38, fantasy: 19,
  'gender bender': 905, 'girls love': 892, harem: 1015, historical: 21,
  horror: 22, isekai: 37, josei: 906, litrpg: 1180,
  'martial arts': 907, mature: 20, mecha: 908, mystery: 909,
  psychological: 910, romance: 6, 'school life': 911, 'sci-fi': 912,
  seinen: 913, 'slice of life': 914, smut: 915, sports: 916,
  supernatural: 5, tragedy: 901,
};
const shSlug = (s) => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const SH_GENRE_ID_BY_SLUG = Object.fromEntries(Object.entries(SH_GENRE_ID).map(([n, id]) => [shSlug(n), id]));

// Genre id for a stored tag or name, or null when it is a tag, not a genre.
export function shGenreId(t) {
  if (!t) return null;
  const name = String((typeof t === 'object' ? (t.name || t.id) : t) || '').trim().toLowerCase();
  const id = typeof t === 'object' && t.id ? shSlug(t.id) : shSlug(name);
  return SH_GENRE_ID[name] || SH_GENRE_ID_BY_SLUG[id] || null;
}

export const shTermName = (t) => String((typeof t === 'object' ? (t.name || t.id) : t) || '').trim();
const shTermSlug = (t) => shSlug(typeof t === 'object' ? (t.id || t.name) : t);

// Where to start a Scribble Hub group. The Series Finder can AND genres and
// subtract excluded genres by id, so a genres-only group gets an exact search.
// Tags in the Finder need numeric ids that only a separate page fetch can
// reveal — which the app won't do — so a group with a tag starts on that tag's
// own listing instead, and the genres are checked on each result below.
export function scribbleHubStart(include, exclude = []) {
  const inc = (include || []).filter(Boolean);
  const exc = (exclude || []).filter(Boolean);
  const gi = inc.map(shGenreId).filter(Boolean);
  const ge = exc.map(shGenreId).filter(Boolean);
  const tags = inc.filter((t) => !shGenreId(t));
  if (tags.length) {
    return { url: `https://www.scribblehub.com/tag/${shTermSlug(tags[0])}/`, exact: false };
  }
  const p = new URLSearchParams({ sf: '1', sort: 'lastchpdate', order: 'desc' });
  if (gi.length) { p.set('gi', gi.join(',')); p.set('mgi', 'and'); }
  if (ge.length) p.set('ge', ge.join(','));
  return { url: `https://www.scribblehub.com/series-finder/?${p.toString()}`, exact: true };
}

// ---- parsers (run in Node for tests AND injected into the live page) -------

// Royal Road listing cards (search results, and any other fiction list page).
export function parseRoyalRoadList(doc) {
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  var out = [];
  var seen = {};
  var items = doc.querySelectorAll('.fiction-list-item');
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    var link = item.querySelector('h2.fiction-title a') || item.querySelector('a[href*="/fiction/"]');
    if (!link) continue;
    var m = (link.getAttribute('href') || '').match(/\/fiction\/(\d+)/);
    if (!m || seen[m[1]]) continue;
    seen[m[1]] = 1;
    var desc = item.querySelector('[id^="description-"]') || item.querySelector('.fiction-description')
      || item.querySelector('div.margin-top-10.col-xs-12') || item.querySelector('div.description');
    var tags = [];
    var tagEls = item.querySelectorAll('a.fiction-tag, a.label[href*="tagsAdd"], span.tags a');
    for (var j = 0; j < tagEls.length; j++) {
      var t = clean(tagEls[j].textContent);
      if (t) tags.push({ t: t, k: 'freeform' });
    }
    var labels = item.querySelectorAll('span.label');
    var complete = false;
    for (var k = 0; k < labels.length; k++) {
      if (/^complete/i.test(clean(labels[k].textContent))) complete = true;
    }
    // Read the stats block itself where there is one: the card's whole text runs
    // elements together with no space ("12 ChaptersTwo men…"), which made a
    // word-boundary match miss the count entirely.
    var statsEl = item.querySelector('.stats');
    var stats = clean(statsEl ? statsEl.textContent : item.textContent);
    var ch = stats.match(/([\d,]+)\s+Chapters?/i);
    out.push({
      sourceId: m[1],
      title: clean(link.textContent) || 'Untitled',
      author: '',
      summary: desc ? clean(desc.textContent) : '',
      tags: tags,
      status: complete ? 'complete' : 'ongoing',
      chapters: ch ? parseInt(ch[1].replace(/,/g, ''), 10) || 0 : 0,
      words: 0,
    });
  }
  return out;
}

// Scribble Hub listing cards (Series Finder, and tag/genre listings).
export function parseScribbleHubList(doc) {
  function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  var out = [];
  var seen = {};
  var bodies = doc.querySelectorAll('.search_body');
  for (var i = 0; i < bodies.length; i++) {
    var b = bodies[i];
    var a = b.querySelector('.search_title a[href*="/series/"]');
    if (!a) continue;
    var m = (a.getAttribute('href') || '').match(/\/series\/(\d+)\//);
    if (!m || seen[m[1]]) continue;
    seen[m[1]] = 1;
    var tags = [];
    var gEls = b.querySelectorAll('.search_genre a');
    for (var j = 0; j < gEls.length; j++) {
      var g = clean(gEls[j].textContent);
      if (g) tags.push({ t: g, k: 'freeform' });
    }
    var statsEl = b.querySelector('.search_stats');
    var stats = clean(statsEl ? statsEl.textContent : '');
    var ch = stats.match(/([\d,]+)\s+Chapters?/i);
    var syn = b.querySelector('.search_synopsis') || b.querySelector('.fdi_synopsis');
    out.push({
      sourceId: m[1],
      title: clean(a.textContent) || 'Untitled',
      author: '',
      summary: syn ? clean(syn.textContent) : '',
      tags: tags,
      status: /\bcompleted?\b/i.test(stats) ? 'complete' : 'ongoing',
      chapters: ch ? parseInt(ch[1].replace(/,/g, ''), 10) || 0 : 0,
      words: 0,
    });
  }
  return out;
}

// ---- turning what was read into the group's rows ---------------------------

// Keep only what this group wants: not dismissed, the right completion status,
// none of the excluded tags, and — for a Scribble Hub tag listing, which can't
// filter by genre itself — every one of the group's genres.
export function filterSiteResults(items, { source, status = 'all', excludeNames = [], requireGenres = [], dismissed }) {
  const ex = new Set(excludeNames.map((n) => String(n).trim().toLowerCase()).filter(Boolean));
  const need = requireGenres.map((n) => String(n).trim().toLowerCase()).filter(Boolean);
  return (items || []).filter((it) => {
    if (!it || !it.sourceId) return false;
    if (dismissed && dismissed.has(`${source}:${it.sourceId}`)) return false;
    if (status === 'complete' && it.status !== 'complete') return false;
    if (status === 'ongoing' && it.status === 'complete') return false;
    const names = new Set((it.tags || []).map((t) => String(t.t || '').trim().toLowerCase()));
    for (const n of ex) if (names.has(n)) return false;
    for (const n of need) if (!names.has(n)) return false;
    return true;
  });
}

// One parsed result → a tag_matches row. Every NOT NULL column gets a real
// value even from an empty item: an explicit null does not fall back to a
// column default, and that exact mistake (`chapters: null`) rejected every
// on-device write for four months.
export function siteMatchRow(groupId, source, it) {
  const title = (it && it.title) || 'Untitled';
  return {
    group_id: groupId,
    source,
    source_work_id: String(it.sourceId),
    title,
    author: (it && it.author) || '',
    fandom: '',
    summary: (it && it.summary) || '',
    tags: Array.isArray(it && it.tags) ? it.tags : [],
    words: (it && it.words) || 0,
    chapters: (it && it.chapters) || 0,
    status: it && it.status === 'complete' ? 'complete' : 'ongoing',
    source_updated: null,
    palette: paletteFor(title),
  };
}

export const siteForHost = (url) => {
  const h = String(url || '');
  if (/(^|\/\/|\.)royalroad\.com/i.test(h)) return 'royalroad';
  if (/(^|\/\/|\.)scribblehub\.com/i.test(h)) return 'scribblehub';
  return '';
};
