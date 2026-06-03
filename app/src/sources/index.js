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
  // A user-uploaded file (EPUB/HTML/TXT). Fully offline, no site to link back to.
  upload: {
    id: 'upload',
    label: 'Upload',
    capabilities: new Set(),
  },
};

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
