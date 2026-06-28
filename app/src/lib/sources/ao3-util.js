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

// AO3 works-search URL: AND the include tags (other_tag_names), subtract the
// excludes (excluded_tag_names), newest-first.
export function searchUrl(include, exclude = [], page = 1) {
  const p = new URLSearchParams();
  p.set('work_search[other_tag_names]', (include || []).join(','));
  if ((exclude || []).length) p.set('work_search[excluded_tag_names]', exclude.join(','));
  p.set('work_search[sort_column]', 'created_at');
  if (page > 1) p.set('page', String(page));
  return `https://${AO3_HOST}/works/search?${p.toString()}`;
}

// AO3 works-search URL for a whole language, newest-first ("Browse by language").
export function languageSearchUrl(code, page = 1) {
  const p = new URLSearchParams();
  p.set('work_search[language_id]', String(code));
  p.set('work_search[sort_column]', 'created_at');
  if (page > 1) p.set('page', String(page));
  return `https://${AO3_HOST}/works/search?${p.toString()}`;
}
