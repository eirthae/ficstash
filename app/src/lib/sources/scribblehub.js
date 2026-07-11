// Scribble Hub on-device downloader. Scribble Hub is Cloudflare-fronted and 403s
// datacenter IPs (the GitHub Actions worker), but answers a residential device —
// the same wall as AO3. So a saved SH story is fetched HERE, on the phone (native
// HTTP), and written straight to Supabase, exactly like the AO3 path.
//
// Ported from FanFicFare's adapter_scribblehubcom.py:
//   * series page  /series/<id>/<slug>/   → title, author, description, cover, status
//   * chapter list = an admin-ajax POST (wi_getreleases_pagination) → a.toc_a links
//   * chapter text = div#chp_raw on each chapter page
// Returns the SAME parsed shape as ao3.js fetchWork, so ondevice.downloadWork stores
// it with no special-casing (source: 'scribblehub').
import { fetchHtml, fetchHtmlPost } from '../fetch.js';

const HOST = 'https://www.scribblehub.com';
const AJAX = `${HOST}/wp-admin/admin-ajax.php`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHAPTER_GAP_MS = 500; // polite gap between per-chapter fetches

const wordCount = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function seriesUrl(id) {
  return `${HOST}/series/${String(id).match(/\d+/)?.[0] || id}/`;
}

// The numeric story id from a /series/<id>/… or /read/<id>-… URL, or a bare id.
export function shIdFromUrl(url) {
  const m = String(url || '').match(/scribblehub\.com\/(?:series|read)\/(\d+)/i) || String(url || '').match(/^(\d+)$/);
  return m ? m[1] : '';
}

// Strip ads / scripts / SH chrome from a chapter body, keeping the prose (and
// author notes — the reader sanitizes remote content itself).
function cleanChapterHtml(node) {
  node.querySelectorAll('script, style, ins, .adsbygoogle, .wi_authornotes_body_head, sup.modern-footnotes-footnote').forEach((e) => e.remove());
  return (node.innerHTML || '').trim();
}

// Pure parser: a series-page HTML → metadata (no chapters yet).
export function parseSeries(html, id) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || '';
  const title = clean(doc.querySelector('.fic_title')?.textContent) || 'Untitled';
  const author = clean(doc.querySelector('.auth_name_fic')?.textContent) || 'Unknown';
  const summary = clean(doc.querySelector('.wi_fic_desc')?.textContent);
  const genres = [...doc.querySelectorAll('a.fic_genre')].map((a) => clean(a.textContent)).filter(Boolean);
  const cover = doc.querySelector('.fic_image img')?.getAttribute('src') || '';
  // Status: SH marks a completed story with a "Completed" status pill; anything
  // else is ongoing. Look for the word on a status-ish element, else default ongoing.
  const statusText = [...doc.querySelectorAll('.rnd_stats, .widget_fic_similar li span, span[title^="Last"]')]
    .map((e) => clean(e.textContent)).join(' ');
  const complete = /\bCompleted\b/i.test(statusText) || /\bCompleted\b/i.test(clean(doc.querySelector('.fic_stats')?.textContent));
  return {
    canonical, title, author, summary,
    tags: genres.map((g) => ({ t: g, k: 'freeform' })),
    cover,
    status: complete ? 'complete' : 'ongoing',
  };
}

// Pure parser: the admin-ajax TOC HTML → [{ title, url }] in listed order.
export function parseToc(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  return [...doc.querySelectorAll('a.toc_a')]
    .map((a) => ({ title: clean(a.textContent) || 'Chapter', url: a.getAttribute('href') || '' }))
    .filter((c) => c.url);
}

// Pure parser: a chapter page HTML → { title, html, words }.
export function parseChapter(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  const raw = doc.querySelector('#chp_raw');
  if (!raw) return { html: '', words: 0 };
  const title = clean(doc.querySelector('.chapter-title, .chp_byline + *, .true_chapter_title')?.textContent);
  const content = cleanChapterHtml(raw);
  return { title, html: content, words: wordCount(raw.textContent) };
}

// Fetch + parse one Scribble Hub story by id (or URL), on-device. Returns the
// ao3.js-compatible parsed shape (…, chaptersData[]) or throws on a hard failure.
export async function fetchWork(idOrUrl) {
  const id = shIdFromUrl(idOrUrl) || String(idOrUrl || '').match(/\d+/)?.[0];
  if (!id) throw new Error('No Scribble Hub story id');

  const sr = await fetchHtml(seriesUrl(id), { accept: 'text/html' });
  if (!sr.html || sr.status >= 400) throw new Error(`Scribble Hub HTTP ${sr.status || '?'}`);
  const meta = parseSeries(sr.html, id);
  const url = meta.canonical || seriesUrl(id);

  // Chapter list: one admin-ajax POST returns every chapter (pagenum -1). Ask for
  // ascending order (oldest first) via the toc_sorder cookie so n = 1..N reads right.
  const toc = await fetchHtmlPost(AJAX,
    { action: 'wi_getreleases_pagination', pagenum: -1, mypostid: id },
    { headers: { Cookie: 'toc_sorder=asc', 'X-Requested-With': 'XMLHttpRequest', Referer: url } });
  let chapters = parseToc(toc.html);
  // Defensive: if SH ignored the sort cookie and returned newest-first, flip it so
  // the earliest chapter is n=1 (its URL id is the smallest).
  if (chapters.length > 1) {
    const idOf = (c) => parseInt((c.url.match(/\/chapter\/(\d+)/) || [])[1] || '0', 10);
    if (idOf(chapters[0]) > idOf(chapters[chapters.length - 1])) chapters = chapters.reverse();
  }
  if (!chapters.length) throw new Error('Scribble Hub: no chapters found');

  const chaptersData = [];
  let totalWords = 0;
  for (let i = 0; i < chapters.length; i++) {
    if (i) await sleep(CHAPTER_GAP_MS);
    const c = chapters[i];
    let body = { html: '', words: 0, title: '' };
    try {
      const cr = await fetchHtml(c.url, { accept: 'text/html' });
      if (cr.html && cr.status < 400) body = parseChapter(cr.html);
    } catch (e) { /* leave this chapter empty → retried on next sync */ }
    totalWords += body.words;
    chaptersData.push({ n: i + 1, title: body.title || c.title, words: body.words, content: body.html });
  }

  return {
    source: 'scribblehub',
    sourceId: String(id),
    title: meta.title,
    author: meta.author,
    authors: [meta.author],
    fandom: '', // SH original fiction has no fandom
    summary: meta.summary,
    tags: meta.tags,
    words: totalWords,
    chapters: chaptersData.length,
    chaptersTotal: meta.status === 'complete' ? chaptersData.length : null,
    status: meta.status,
    url,
    chaptersData,
  };
}
