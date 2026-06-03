// Capability-based source registry (app side).
//
// FicStash is a curated reader that pulls from several sites. Rather than
// special-casing AO3 everywhere, each source declares which capabilities it
// supports, and the UI asks the registry what a source can do. The capability
// tokens are kept IDENTICAL to the worker's ficstash_worker/sources/base.py so
// both sides agree on what every source is able to do.
//
//   tagSearch       — discover works by tag/genre (the discovery engine)
//   genreList       — offer a fixed list of the site's genres/categories
//   tagAutocomplete — suggest tag names as the user types
//   download        — fetch full chapter bodies for an offline copy
//   follow          — re-check an ongoing work for new chapters
//   workUrl         — build a canonical "open at source" link

export const CAP = {
  TAG_SEARCH: 'tagSearch',
  GENRE_LIST: 'genreList',
  TAG_AUTOCOMPLETE: 'tagAutocomplete',
  DOWNLOAD: 'download',
  FOLLOW: 'follow',
  WORK_URL: 'workUrl',
};

// One entry per known source. `capabilities` is the set the source supports;
// `workUrl(id)` builds the canonical link when WORK_URL is supported.
const SOURCES = {
  ao3: {
    id: 'ao3',
    label: 'AO3',
    capabilities: new Set([
      CAP.TAG_SEARCH,
      CAP.GENRE_LIST,
      CAP.DOWNLOAD,
      CAP.FOLLOW,
      CAP.WORK_URL,
    ]),
    workUrl: (id) => `https://archiveofourown.org/works/${id}`,
  },
  // Royal Road — original-fiction site. Discovery by genre/tag; saved works are
  // downloaded server-side through the FanFicFare link path, so the app only
  // needs tag search + a canonical link here.
  royalroad: {
    id: 'royalroad',
    label: 'Royal Road',
    capabilities: new Set([CAP.TAG_SEARCH, CAP.GENRE_LIST, CAP.WORK_URL]),
    workUrl: (id) => `https://www.royalroad.com/fiction/${id}`,
  },
  // Scribble Hub — original-fiction site. Discovery by genre (via the genre RSS
  // feed, server-side); saved works download through the FanFicFare link path,
  // so the app only needs genre search + a canonical link here.
  scribblehub: {
    id: 'scribblehub',
    label: 'Scribble Hub',
    capabilities: new Set([CAP.TAG_SEARCH, CAP.GENRE_LIST, CAP.WORK_URL]),
    workUrl: (id) => `https://www.scribblehub.com/series/${id}/`,
  },
  // Books — published-book release watcher (Open Library). Notify-only: tracks
  // an AUTHOR (not a genre) and surfaces new releases; the user buys the EPUB and
  // adds it through the upload path. No DOWNLOAD here, so the swipe feed hides the
  // Save button and just links out to Open Library.
  books: {
    id: 'books',
    label: 'Books',
    capabilities: new Set([CAP.TAG_SEARCH, CAP.WORK_URL]),
    workUrl: (id) => `https://openlibrary.org/works/${id}`,
  },
  // A user-uploaded file (EPUB/HTML/TXT). Fully offline, no site to link back to.
  upload: {
    id: 'upload',
    label: 'Upload',
    capabilities: new Set(),
  },
};

// Royal Road's fiction tags — kept in sync with the worker's royalroad.GENRES.
// `slug` is the value the site's search expects; `name` is the label. Stored as
// a tracked tag's {name, id:slug} so the worker searches by the exact slug.
export const ROYALROAD_GENRES = [
  { name: 'Action', slug: 'action' },
  { name: 'Adventure', slug: 'adventure' },
  { name: 'Comedy', slug: 'comedy' },
  { name: 'Contemporary', slug: 'contemporary' },
  { name: 'Drama', slug: 'drama' },
  { name: 'Fantasy', slug: 'fantasy' },
  { name: 'Historical', slug: 'historical' },
  { name: 'Horror', slug: 'horror' },
  { name: 'Mystery', slug: 'mystery' },
  { name: 'Psychological', slug: 'psychological' },
  { name: 'Romance', slug: 'romance' },
  { name: 'Satire', slug: 'satire' },
  { name: 'Sci-fi', slug: 'sci_fi' },
  { name: 'Tragedy', slug: 'tragedy' },
  { name: 'Anti-Hero Lead', slug: 'anti-hero_lead' },
  { name: 'Artificial Intelligence', slug: 'artificial_intelligence' },
  { name: 'Cyberpunk', slug: 'cyberpunk' },
  { name: 'Dungeon', slug: 'dungeon' },
  { name: 'Dystopia', slug: 'dystopia' },
  { name: 'Female Lead', slug: 'female_lead' },
  { name: 'GameLit', slug: 'gamelit' },
  { name: 'Grimdark', slug: 'grimdark' },
  { name: 'Harem', slug: 'harem' },
  { name: 'High Fantasy', slug: 'high_fantasy' },
  { name: 'LitRPG', slug: 'litrpg' },
  { name: 'Low Fantasy', slug: 'low_fantasy' },
  { name: 'Magic', slug: 'magic' },
  { name: 'Male Lead', slug: 'male_lead' },
  { name: 'Martial Arts', slug: 'martial_arts' },
  { name: 'Mythos', slug: 'mythos' },
  { name: 'Non-Human Lead', slug: 'non-human_lead' },
  { name: 'Portal Fantasy / Isekai', slug: 'summoned_hero' },
  { name: 'Post Apocalyptic', slug: 'post_apocalyptic' },
  { name: 'Progression', slug: 'progression' },
  { name: 'Reincarnation', slug: 'reincarnation' },
  { name: 'School Life', slug: 'school_life' },
  { name: 'Slice of Life', slug: 'slice_of_life' },
  { name: 'Space Opera', slug: 'space_opera' },
  { name: 'Sports', slug: 'sports' },
  { name: 'Steampunk', slug: 'steampunk' },
  { name: 'Strategy', slug: 'strategy' },
  { name: 'Strong Lead', slug: 'strong_lead' },
  { name: 'Super Heroes', slug: 'super_heroes' },
  { name: 'Supernatural', slug: 'supernatural' },
  { name: 'Time Loop', slug: 'loop' },
  { name: 'Time Travel', slug: 'time_travel' },
  { name: 'Urban Fantasy', slug: 'urban_fantasy' },
  { name: 'Villainous Lead', slug: 'villainous_lead' },
  { name: 'Virtual Reality', slug: 'virtual_reality' },
  { name: 'War and Military', slug: 'war_and_military' },
  { name: 'Wuxia', slug: 'wuxia' },
  { name: 'Xianxia', slug: 'xianxia' },
];

// Scribble Hub's genres — kept in sync with the worker's scribblehub.GENRES.
// `slug` is the value /genre/<slug>/feed/ expects; `name` is the label. Stored
// as a tracked tag's {name, id:slug} so the worker searches by the exact slug.
export const SCRIBBLEHUB_GENRES = [
  { name: 'Action', slug: 'action' },
  { name: 'Adventure', slug: 'adventure' },
  { name: 'Comedy', slug: 'comedy' },
  { name: 'Drama', slug: 'drama' },
  { name: 'Fantasy', slug: 'fantasy' },
  { name: 'Gender Bender', slug: 'gender-bender' },
  { name: 'Harem', slug: 'harem' },
  { name: 'Historical', slug: 'historical' },
  { name: 'Horror', slug: 'horror' },
  { name: 'Isekai', slug: 'isekai' },
  { name: 'Josei', slug: 'josei' },
  { name: 'LitRPG', slug: 'litrpg' },
  { name: 'Martial Arts', slug: 'martial-arts' },
  { name: 'Mature', slug: 'mature' },
  { name: 'Mecha', slug: 'mecha' },
  { name: 'Mystery', slug: 'mystery' },
  { name: 'Psychological', slug: 'psychological' },
  { name: 'Romance', slug: 'romance' },
  { name: 'School Life', slug: 'school-life' },
  { name: 'Sci-fi', slug: 'sci-fi' },
  { name: 'Seinen', slug: 'seinen' },
  { name: 'Slice of Life', slug: 'slice-of-life' },
  { name: 'Sports', slug: 'sports' },
  { name: 'Supernatural', slug: 'supernatural' },
  { name: 'Tragedy', slug: 'tragedy' },
];

export function getSource(sourceId) {
  return SOURCES[sourceId] || null;
}

// True if the named source exists and declares the given capability.
export function supports(sourceId, capability) {
  const src = SOURCES[sourceId];
  return !!(src && src.capabilities.has(capability));
}

// Human label for a source id, falling back to the id itself.
export function sourceLabel(sourceId) {
  return SOURCES[sourceId]?.label || sourceId || 'Unknown';
}

// Canonical "open at source" link. Works added by link carry their own stored
// URL (sourceUrl); pass that as a fallback for sources without a builder here.
export function workUrl(sourceId, sourceWorkId, fallbackUrl = '') {
  const src = SOURCES[sourceId];
  if (src && src.capabilities.has(CAP.WORK_URL) && sourceWorkId) {
    return src.workUrl(sourceWorkId);
  }
  return fallbackUrl || '';
}

export { SOURCES };
