// Pure AO3 URL / id / stat helpers — no DOM, no native HTTP, so node --test can
// cover them directly (ao3.js imports fetch.js → @capacitor/core, which bare Node
// can't resolve). ao3.js imports + re-exports these.

export const AO3_HOST = 'archiveofourown.org';

export function isAo3Url(url) {
  return /(^|[/.@])archiveofourown\.org/i.test(String(url || ''));
}

// Work id from any AO3 work URL (incl. /collections/x/works/123, /chapters/...).
export function workIdFromUrl(url) {
  const m = String(url || '').match(/\/works\/(\d+)/);
  return m ? m[1] : '';
}

// The "entire work on one page" URL with the adult-content gate pre-consented,
// so a single fetch returns every chapter (and age-gated works don't bounce).
export function fullWorkUrl(id) {
  return `https://${AO3_HOST}/works/${id}?view_full_work=true&view_adult=true`;
}

export function workUrl(id) {
  return `https://${AO3_HOST}/works/${id}`;
}

// "5/12" → ongoing, "12/12" → complete, "3/?" → ongoing. AO3's chapters stat.
export function parseChapterStat(text) {
  const m = String(text || '').replace(/,/g, '').match(/(\d+)\s*\/\s*(\d+|\?)/);
  if (!m) return { chapters: 0, total: null, status: 'ongoing' };
  const have = parseInt(m[1], 10);
  const total = m[2] === '?' ? null : parseInt(m[2], 10);
  return { chapters: have, total, status: total != null && have >= total ? 'complete' : 'ongoing' };
}

// AO3 search blurbs carry ONE date, in `p.datetime`, formatted "14 Aug 2025" —
// the work's last-updated date (its posted date for a work never revised). The
// true posted date only exists on the work page itself, so this is the cheapest
// date discovery can know, and it's what the feed sorts and displays.
// Returns an ISO date ("2025-08-14") or '' when the text isn't a date we know.
const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

export function parseBlurbDate(text) {
  const m = String(text || '').trim().match(/^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/);
  if (!m) return '';
  const mm = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mm) return '';
  const day = m[1].padStart(2, '0');
  if (Number(day) < 1 || Number(day) > 31) return '';
  return `${m[3]}-${mm}-${day}`;
}

// We ask AO3 to sort by revised_at (Date Updated), which is the same date the
// blurb shows and the same one the discovery feed orders by. Sorting by
// created_at (Date Posted) instead meant AO3 paginated by one date while we
// displayed by another: when a tag had more results than we fetch, which works
// we kept was decided by posted date, but the top of the feed was then whichever
// of them happened to be updated most recently. Same order end to end now.
const SORT_BY_UPDATED = 'revised_at';

// AO3 works-search URL: AND the include tags (other_tag_names), subtract the
// excludes (excluded_tag_names), most-recently-updated first.
export function searchUrl(include, exclude = [], page = 1) {
  const p = new URLSearchParams();
  p.set('work_search[other_tag_names]', (include || []).join(','));
  if ((exclude || []).length) p.set('work_search[excluded_tag_names]', exclude.join(','));
  p.set('work_search[sort_column]', SORT_BY_UPDATED);
  if (page > 1) p.set('page', String(page));
  return `https://${AO3_HOST}/works/search?${p.toString()}`;
}

// AO3 works-search URL for a whole language ("Browse by language").
export function languageSearchUrl(code, page = 1) {
  const p = new URLSearchParams();
  p.set('work_search[language_id]', String(code));
  p.set('work_search[sort_column]', SORT_BY_UPDATED);
  if (page > 1) p.set('page', String(page));
  return `https://${AO3_HOST}/works/search?${p.toString()}`;
}
