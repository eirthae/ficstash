// ============================================================================
// Source registry — multi-source from day one (base spec §16).
// The worker implements the actual fetching for each site; the app stays
// source-agnostic and uses these capability flags to show/hide per-source UI.
// Every `works` row carries a `source` field matching one of these ids.
// ============================================================================

export const SOURCES = {
  ao3: {
    id: 'ao3',
    label: 'AO3',
    site: 'Archive of Our Own',
    readingListLabel: 'bookmarks',
    capabilities: { tagSearch: true, rss: true, readingList: true, restrictedWorks: true, needsProxy: false },
    workUrl: (id) => `https://archiveofourown.org/works/${id}`,
    available: true,
  },
  royalroad: {
    id: 'royalroad',
    label: 'Royal Road',
    site: 'Royal Road',
    readingListLabel: 'follows',
    capabilities: { tagSearch: false, rss: true, readingList: true, restrictedWorks: false, needsProxy: false },
    workUrl: (id) => `https://www.royalroad.com/fiction/${id}`,
    available: false,
  },
  scribblehub: {
    id: 'scribblehub',
    label: 'Scribble Hub',
    site: 'Scribble Hub',
    readingListLabel: 'library',
    capabilities: { tagSearch: true, rss: false, readingList: true, restrictedWorks: false, needsProxy: true },
    workUrl: (id) => `https://www.scribblehub.com/series/${id}/`,
    available: false,
  },
};

export const getSource = (id) => SOURCES[id] || SOURCES.ao3;
