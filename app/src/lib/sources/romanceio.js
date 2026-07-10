// romance.io discovery source — Books shelf. romance.io is a JS SPA fronted by
// Cloudflare; its private JSON API answers a plain GET from the device (no auth,
// no special header). Like AO3, we call it ON-DEVICE (residential IP) and use
// Supabase only as the store. Books here are METADATA-ONLY: cards link out to
// romance.io, there is nothing to download.
//
// Endpoint: GET /json/topics/books/<include|all>/<sort>/<offset>/<limit>[/<hide>]
//   include / hide = topic slugs, each percent-encoded, joined by literal commas.
//   Slugs are the tree's real _id and often contain SPACES ("grumpy sunshine",
//   "high fantasy") — they must be encodeURIComponent'd (space → %20), NOT hyphenated.
//   offset = (page-1)*limit. The site's page size is 20; the API ignores other limits.
import { fetchJson } from '../fetch.js';
import { ROMANCEIO_DEFAULT_EXCLUDE, ROMANCEIO_TREE } from '../../data/romanceioTopics.js';

// name/slug (lowercased) → canonical slug, for mapping the Books shelf's global
// excluded tags (free-text names in Settings) onto romance.io topics so they can
// be excluded server-side. A name with no matching topic simply can't apply.
const NAME_TO_SLUG = (() => {
  const m = new Map();
  for (const cat of ROMANCEIO_TREE) {
    for (const g of cat.groups) {
      for (const t of g.topics) { m.set(t.s.toLowerCase(), t.s); m.set(t.n.toLowerCase(), t.s); }
    }
  }
  return m;
})();

// Map a list of tag names/slugs to the romance.io slugs that exist (deduped).
export function slugsForNames(names) {
  const out = [];
  for (const n of names || []) {
    const s = NAME_TO_SLUG.get(String(n == null ? '' : (n.name ?? n)).trim().toLowerCase());
    if (s) out.push(s);
  }
  return [...new Set(out)];
}

const HOST = 'https://www.romance.io';
const COVER = 'https://s3.amazonaws.com/romance.io/books'; // /<size>/<_id>.jpg
export const PAGE_SIZE = 20;

// Encode a slug list for a path segment: percent-encode each slug (so spaces and
// any reserved chars are safe), then join with literal commas the API splits on.
const encList = (list) =>
  [...new Set((list || []).map((s) => String(s || '').trim()).filter(Boolean))]
    .map((s) => encodeURIComponent(s))
    .join(',');

// Build the books-endpoint URL. `exclude` is always merged with the permanent
// default-exclude list (non-binary-MC topics the user never wants to see).
export function booksUrl(include, exclude, { sort = 'best', page = 1 } = {}) {
  const inc = encList(include);
  const hide = encList([...(exclude || []), ...ROMANCEIO_DEFAULT_EXCLUDE]);
  const offset = Math.max(0, (Math.max(1, page | 0) - 1) * PAGE_SIZE);
  let path = `/json/topics/books/${inc || 'all'}/${sort}/${offset}/${PAGE_SIZE}`;
  if (hide) path += `/${hide}`;
  return HOST + path;
}

// Normalize one book from the API into the metadata-only match shape the Books
// discovery flow stores. Cover is derived from _id; url links out to romance.io.
function mapBook(b) {
  if (!b || !b._id) return null;
  const id = String(b._id);
  const info = b.info || {};
  const authors = (b.authors || []).map((a) => a && a.name).filter(Boolean);
  const avg = typeof info.avgRating === 'number' ? Math.round(info.avgRating * 10) / 10 : null;
  return {
    sourceWorkId: id,
    title: (info.title || '').trim() || 'Untitled',
    author: authors.join(', ') || 'Unknown',
    summary: (info.description || '').trim(),
    url: b.url ? HOST + b.url : `${HOST}/books/${id}`,
    cover: `${COVER}/large/${id}.jpg`,
    series: (b.series && (b.series.title || b.series.series)) || '',
    rating: avg,
    steam: (info.steam_rating_description || '').trim(),
  };
}

// Fetch one page of books matching the include topics and NOT the exclude topics.
// Returns [] on any failure (best-effort discovery, same as the AO3 path).
export async function searchRomanceBooks(include, exclude, opts = {}) {
  const r = await fetchJson(booksUrl(include, exclude, opts));
  if (!r || r.status < 200 || r.status >= 300 || !r.data || !Array.isArray(r.data.books)) return [];
  return r.data.books.map(mapBook).filter(Boolean);
}
