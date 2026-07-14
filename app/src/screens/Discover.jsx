import { useState, useEffect, useRef, useCallback } from 'react';
import { Appbar } from '../components/chrome.jsx';
import Icon from '../components/Icon.jsx';
import { SearchField, EmptyState, TAG_COLOR, useToast, Sheet, Segmented, PullToRefresh } from '../components/ui.jsx';
import { TagTile, SuggestionCard } from '../components/cards.jsx';
import {
  fetchTrackedGroups, createGroup, createLanguageGroup, deleteGroup, updateGroup,
  fetchMatches, dismissMatch, markGroupSeen, autocompleteTags, requestSave,
  markLater, unmarkLater, fetchLaterMatches, fetchFailedMatches, retryMatch, fetchStashCounts,
} from '../lib/tags.js';
import { fetchFailedLinks, retryLinkRequest, removeRequest, retryAllFailedLinks } from '../lib/links.js';
import { syncNow } from '../lib/sync.js';
import { LANGUAGES } from '../lib/languages.js';
import { fetchDiscoveryPrefs, updateDiscoveryPrefs } from '../lib/discovery.js';
import { TRACKED_TAGS, SUGGESTIONS } from '../data/sample.js';
import { GOODREADS_TAGS } from '../data/goodreadsTags.js';
import { ROMANCEIO_TREE } from '../data/romanceioTopics.js';
import {
  ROYALROAD_GENRES, ROYALROAD_TAGS, SCRIBBLEHUB_GENRES, SCRIBBLEHUB_TAGS, sourceLabel,
} from '../sources/index.js';

// Every non-AO3 source's vocabulary shaped as the collapsible tree the builder's
// TopicPicker renders: [{ cat, groups:[{ head, topics:[{ s:slug, n:name, k:kind }] }] }].
// A pick is stored as {name, id:slug, kind} — Royal Road / Scribble Hub resolve the
// slug to the site's native filter (RR tagsAdd/Remove; SH Series Finder ids); the
// Goodreads worker slugifies the NAME (so slug == name there). romance.io ships its
// own tree (with counts) in romanceioTopics.js.
const taxTopics = (list, kind) => list.map((g) => ({ s: g.slug, n: g.name, k: kind }));
// Flat {name,slug,kind} lists — still used by the global Discovery-filters sheet's
// exclude pickers (that sheet stays a simple tag list, not the include/exclude tree).
const withKind = (list, kind) => list.map((g) => ({ ...g, kind }));
const TAXONOMY_BY_SOURCE = {
  royalroad: [...withKind(ROYALROAD_GENRES, 'genre'), ...withKind(ROYALROAD_TAGS, 'tag')],
  scribblehub: [...withKind(SCRIBBLEHUB_GENRES, 'genre'), ...withKind(SCRIBBLEHUB_TAGS, 'tag')],
};
const GOODREADS_TREE = [
  { cat: 'READER TAGS', groups: [{ head: '', topics: GOODREADS_TAGS.map((s) => ({ s, n: s, k: 'subject' })) }] },
];
const TAXONOMY_TREE_BY_SOURCE = {
  royalroad: [
    { cat: 'GENRES', groups: [{ head: '', topics: taxTopics(ROYALROAD_GENRES, 'genre') }] },
    { cat: 'TAGS', groups: [{ head: '', topics: taxTopics(ROYALROAD_TAGS, 'tag') }] },
  ],
  scribblehub: [
    { cat: 'GENRES', groups: [{ head: '', topics: taxTopics(SCRIBBLEHUB_GENRES, 'genre') }] },
    { cat: 'TAGS', groups: [{ head: '', topics: taxTopics(SCRIBBLEHUB_TAGS, 'tag') }] },
  ],
};
// The picker tree for a builder source (AO3 has no fixed tree — it live-searches).
const treeForSource = (source) =>
  source === 'romanceio' ? ROMANCEIO_TREE
  : source === 'books' ? GOODREADS_TREE
  : TAXONOMY_TREE_BY_SOURCE[source] || [];

// The "Stories" shelf spans both non-AO3 fiction sites, so its global-exclude
// vocabulary is Royal Road + Scribble Hub combined (deduped by name) — NOT the
// Goodreads/AO3 list. Lets you exclude e.g. "Isekai" or "Portal Fantasy".
const SITES_TAXONOMY = (() => {
  const seen = new Set();
  return [...TAXONOMY_BY_SOURCE.royalroad, ...TAXONOMY_BY_SOURCE.scribblehub].filter((g) => {
    const k = (g.name || '').toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
})();

// Whether a discovered work can be saved into the library. AO3 downloads
// directly; Royal Road / Scribble Hub download server-side via the FanFicFare
// link path. "Books" is notify-only — a commercial release can't be fetched, so
// its cards just link out to Open Library and the user buys + uploads the EPUB.
const isSavableSource = (src) => src !== 'books' && src !== 'romanceio';

// ============================================================================
// Discover — track AO3 tags / tag groups and review the works they turn up.
// Groups are stored in Supabase (tracked_groups); the worker fills tag_matches.
// ============================================================================

export function DiscoverScreen({ nav }) {
  const [groups, setGroups] = useState(null); // null = loading
  const [builderOpen, setBuilderOpen] = useState(false);
  const [editGroup, setEditGroup] = useState(null); // group being edited (null = creating)
  const [addLangOpen, setAddLangOpen] = useState(false); // follow a new language
  const [filtersOpen, setFiltersOpen] = useState(false); // global discovery filters
  const [tagShelf, setTagShelf] = useState('ao3'); // ao3 | sites | books
  const [stash, setStash] = useState({ later: 0, failed: 0 }); // Later/Failed counts
  const [toast, showToast] = useToast();

  const load = useCallback(() => {
    fetchTrackedGroups()
      .then((r) => setGroups(r ?? TRACKED_TAGS))
      .catch(() => setGroups(TRACKED_TAGS));
    fetchStashCounts().then(setStash).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  // Pull-to-refresh: run the quick saves-only sync (downloads any pending links/
  // saves), held to completion so the spinner stays until it's done, then reload
  // the tracked groups. New tag-match discovery runs on the nightly schedule.
  const doSync = useCallback(async () => { try { await syncNow(); } finally { load(); } }, [load]);

  const all = groups || [];
  // Language groups get their own section; keep them out of the tag grid.
  const tags = all.filter((t) => t.kind !== 'language');
  const langGroups = all.filter((t) => t.kind === 'language');
  const fresh = tags.reduce((a, t) => a + (t.fresh || 0), 0);
  // Shelve the tracked groups by source, mirroring the library's shelves.
  const shelfMatch = {
    ao3: (s) => (s || 'ao3') === 'ao3',
    sites: (s) => s === 'royalroad' || s === 'scribblehub',
    books: (s) => s === 'books' || s === 'romanceio',
  };
  const TAG_SHELVES = [
    { id: 'ao3', label: 'AO3' },
    { id: 'sites', label: 'Stories' },
    { id: 'books', label: 'Books' },
  ];
  const shelfCount = (id) => tags.filter((t) => shelfMatch[id](t.source)).length;
  const shelfTags = tags.filter((t) => shelfMatch[tagShelf](t.source));
  const open = (tag) => nav.push('tagresults', { tag, onLeave: load, onEdit: (g) => { setEditGroup(g); setBuilderOpen(true); } });
  const openLater = () => nav.push('later', { onLeave: load });
  const openFailed = () => nav.push('failed', { onLeave: load });

  const onCreated = (g, editing) => {
    setBuilderOpen(false);
    setEditGroup(null);
    if (editing) { showToast(`Updated “${g.name}” — re-discovering`); load(); return; }
    // Jump to the shelf the new group lives on, so you land on the tag you just
    // created instead of staying on whatever shelf you opened the builder from.
    const s = g && g.source;
    setTagShelf(s === 'royalroad' || s === 'scribblehub' ? 'sites' : (s === 'books' || s === 'romanceio') ? 'books' : 'ao3');
    showToast(`Now tracking “${g.name}”`);
    load();
  };

  // Follow a language: start a "browse this whole language" group, unless we
  // already follow it. Codes already followed are hidden from the picker.
  const followLanguage = async (lang) => {
    setAddLangOpen(false);
    if (langGroups.some((g) => g.language === lang.code)) { showToast(`Already following ${lang.english}`); return; }
    try {
      await createLanguageGroup({ code: lang.code, name: lang.native, label: lang.english });
      showToast(`Now following ${lang.english}`);
      load();
    } catch {
      showToast("Couldn't add — check your connection", 'solar:danger-triangle-linear');
    }
  };
  const followedLangCodes = new Set(langGroups.map((g) => g.language));

  return (
    <div className="screen">
      <Appbar large title="Discover" actions={[{ icon: 'solar:filter-bold', onClick: () => setFiltersOpen(true) }]} />
      <PullToRefresh className="scroll" onRefresh={doSync} style={{ padding: '0 20px 24px' }}>
        <button className="set-group pressable" onClick={openLater}
          style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 13, width: '100%', textAlign: 'left', marginBottom: 18 }}>
          <div className="set-ic"><Icon icon="solar:bookmark-linear" size={18} /></div>
          <div style={{ flex: 1 }}>
            <div className="set-h">Later</div>
            <div className="set-d">Works you set aside to decide on.</div>
          </div>
          {stash.later > 0 && <span className="chip" style={{ height: 22, background: 'var(--surface-2)', color: 'var(--text-secondary)', fontWeight: 700, fontSize: 12 }}>{stash.later}</span>}
          <Icon icon="solar:alt-arrow-right-linear" size={18} color="var(--text-tertiary)" />
        </button>

        <button className="set-group pressable" onClick={openFailed}
          style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 13, width: '100%', textAlign: 'left', marginBottom: 18 }}>
          <div className="set-ic"><Icon icon="solar:danger-triangle-linear" size={18} /></div>
          <div style={{ flex: 1 }}>
            <div className="set-h">Failed</div>
            <div className="set-d">Saves that couldn’t download — retry or dismiss.</div>
          </div>
          {stash.failed > 0 && <span className="chip" style={{ height: 22, background: 'color-mix(in srgb, var(--danger, #f5455c) 15%, transparent)', color: 'var(--danger, #f5455c)', fontWeight: 700, fontSize: 12 }}>{stash.failed}</span>}
          <Icon icon="solar:alt-arrow-right-linear" size={18} color="var(--text-tertiary)" />
        </button>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="section-label">Tracked · {tags.length}</div>
          {fresh > 0 && <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{fresh} new matches</span>}
        </div>

        <div className="seg src-seg" style={{ marginBottom: 14 }}>
          {TAG_SHELVES.map((s) => (
            <button key={s.id} className={tagShelf === s.id ? 'on' : ''} onClick={() => setTagShelf(s.id)}>
              {s.label} · {shelfCount(s.id)}
            </button>
          ))}
        </div>

        {groups === null ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '8px 2px' }}>Loading…</div>
        ) : shelfTags.length === 0 ? (
          <EmptyState
            icon="solar:hashtag-circle-linear"
            title="Nothing tracked here yet"
            desc="Track a tag or a tag group and FicStash will surface matching works as they're posted."
            action={<button className="btn btn-lg btn-primary" onClick={() => setBuilderOpen(true)}>Track a tag</button>}
          />
        ) : (
          <div className="tilegrid">
            {shelfTags.map((t) => <TagTile key={t.id} tag={t} onOpen={open} />)}
            <button className="tile add pressable" onClick={() => setBuilderOpen(true)}>
              <Icon icon="solar:add-circle-linear" size={30} />
              <div className="t-name" style={{ marginTop: 6 }}>Track a new tag</div>
            </button>
          </div>
        )}

        {groups !== null && tagShelf === 'ao3' && (
          <>
            <div className="section-label" style={{ marginTop: 26, marginBottom: 12 }}>Followed languages</div>
            <div className="tilegrid">
              {langGroups.map((g) => <TagTile key={g.id} tag={g} onOpen={() => open(g)} />)}
              <button className="tile add pressable" onClick={() => setAddLangOpen(true)}>
                <Icon icon="solar:add-circle-linear" size={30} />
                <div className="t-name" style={{ marginTop: 6 }}>Add language</div>
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginTop: 8 }}>
              Follow a whole language to see new works in it. Follow as many as you like.
            </div>
          </>
        )}
      </PullToRefresh>

      <TagGroupBuilder open={builderOpen} editGroup={editGroup}
        onClose={() => { setBuilderOpen(false); setEditGroup(null); }} onCreated={onCreated}
        initialSource={{ ao3: 'ao3', sites: 'royalroad', books: 'romanceio' }[tagShelf] || 'ao3'} />
      <AddLanguageSheet open={addLangOpen} onClose={() => setAddLangOpen(false)}
        followedCodes={followedLangCodes} onPick={followLanguage} />
      <DiscoveryFiltersSheet open={filtersOpen} onClose={() => setFiltersOpen(false)} showToast={showToast} shelf={tagShelf} />
      {toast}
    </div>
  );
}

// ---- Add a language to follow --------------------------------------------
// Searchable list of AO3 languages; ones already followed are hidden.
function AddLanguageSheet({ open, onClose, followedCodes, onPick }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();
  const choices = LANGUAGES
    .filter((l) => !followedCodes.has(l.code))
    .filter((l) => !needle || l.english.toLowerCase().includes(needle) || l.native.toLowerCase().includes(needle));
  return (
    <Sheet open={open} onClose={onClose} title="Follow a language" maxH="80%">
      <div className="searchfield" style={{ marginBottom: 12 }}>
        <Icon icon="solar:magnifer-linear" size={18} color="var(--text-tertiary)" />
        <input placeholder="Search languages…" value={q} onChange={(e) => setQ(e.target.value)}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: '52vh', overflowY: 'auto' }}>
        {choices.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 4px' }}>No more languages to add.</div>
        ) : choices.map((l) => (
          <button key={l.code} className="set-row pressable" style={{ width: '100%', textAlign: 'left' }} onClick={() => onPick(l)}>
            <div className="set-ic"><Icon icon="solar:global-linear" size={18} /></div>
            <div className="set-tx"><div className="set-h">{l.english}</div><div className="set-d">{l.native}</div></div>
            <Icon icon="solar:add-circle-linear" size={20} color="var(--accent)" />
          </button>
        ))}
      </div>
    </Sheet>
  );
}

// ---- Global discovery filters --------------------------------------------
// Preferred languages (empty = all) + globally-excluded tags. Applied by the
// worker to every tag-discovery search.
const SHELF_LABEL = { ao3: 'AO3', sites: 'Stories', books: 'Books' };

function DiscoveryFiltersSheet({ open, onClose, showToast, shelf = 'ao3' }) {
  const [langs, setLangs] = useState([]);       // [{code,native,english}]
  const [excludedObj, setExcludedObj] = useState({ ao3: [], sites: [], books: [] }); // per-shelf {name,id,kind}
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [langPick, setLangPick] = useState(false);
  const excluded = excludedObj[shelf] || []; // the active shelf's exclude list

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    fetchDiscoveryPrefs()
      .then((p) => { setLangs(p.languages || []); setExcludedObj(p.excludedTags || { ao3: [], sites: [], books: [] }); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [open]);

  const removeLang = (code) => setLangs((ls) => ls.filter((l) => l.code !== code));
  const addLang = (l) => { setLangs((ls) => (ls.some((x) => x.code === l.code) ? ls : [...ls, l])); setLangPick(false); };
  const addExcluded = (t) => setExcludedObj((o) => {
    const cur = o[shelf] || [];
    return cur.some((x) => x.name === t.name) ? o : { ...o, [shelf]: [...cur, t] };
  });
  const removeExcluded = (name) => setExcludedObj((o) => ({ ...o, [shelf]: (o[shelf] || []).filter((x) => x.name !== name) }));

  const save = async () => {
    setSaving(true);
    try {
      await updateDiscoveryPrefs({ languages: langs, excludedTags: excludedObj });
      showToast('Discovery filters saved');
      onClose();
    } catch {
      showToast("Couldn't save filters", 'solar:danger-triangle-linear');
    } finally { setSaving(false); }
  };

  const pickable = LANGUAGES.filter((l) => !langs.some((x) => x.code === l.code));

  return (
    <Sheet open={open} onClose={onClose} title={`Discovery filters · ${SHELF_LABEL[shelf] || ''}`} maxH="86%">
      {loading ? (
        <div style={{ fontSize: 13, color: 'var(--text-tertiary)', padding: '12px 4px' }}>Loading…</div>
      ) : (
        <>
          {shelf === 'ao3' && (<>
          <div className="section-label" style={{ marginBottom: 8 }}>Only these languages</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 10 }}>
            Discovery will only surface works in these languages. Leave empty to allow all.
          </div>
          <div className="chiprow" style={{ marginBottom: 10 }}>
            {langs.map((l) => (
              <button key={l.code} className="chip pressable" onClick={() => removeLang(l.code)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                {l.english}
                <Icon icon="solar:close-circle-bold" size={15} color="var(--text-tertiary)" />
              </button>
            ))}
            {langs.length === 0 && <span style={{ fontSize: 12.5, color: 'var(--text-tertiary)' }}>All languages</span>}
          </div>
          {langPick ? (
            <div style={{ maxHeight: 200, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', marginBottom: 14 }}>
              {pickable.map((l) => (
                <button key={l.code} className="pressable" onClick={() => addLang(l)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '9px 12px', background: 'transparent', borderBottom: '1px solid var(--border)', fontSize: 13.5, color: 'var(--text-primary)' }}>
                  <Icon icon="solar:global-linear" size={15} color="var(--text-tertiary)" />
                  <span>{l.english}</span>
                  <span style={{ color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{l.native}</span>
                </button>
              ))}
            </div>
          ) : (
            <button className="btn btn-surface" style={{ marginBottom: 18 }} onClick={() => setLangPick(true)}>
              <Icon icon="solar:add-circle-linear" size={18} /> Add language
            </button>
          )}
          </>)}

          <div className="section-label" style={{ marginTop: 6, marginBottom: 8 }}>Never show {SHELF_LABEL[shelf]} works tagged</div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 10 }}>
            Hide any discovered {SHELF_LABEL[shelf]} work carrying these tags{shelf === 'ao3' ? ' — including ratings like “Explicit”' : ''}. Applies to this shelf only.
          </div>
          {shelf === 'ao3'
            ? <TagPicker picked={excluded} onAdd={addExcluded} onRemove={removeExcluded}
                placeholder="Search AO3 tags to exclude…" accent="var(--danger, #f5455c)" />
            : shelf === 'sites'
              ? <GenrePicker genres={SITES_TAXONOMY} label="Royal Road + Scribble Hub"
                  picked={excluded} onAdd={addExcluded} onRemove={removeExcluded} />
              : <SubjectPicker picked={excluded} onAdd={addExcluded} onRemove={removeExcluded}
                  placeholder="Type a subject to exclude…" accent="var(--danger, #f5455c)" />}

          <button className="btn btn-lg btn-primary" style={{ width: '100%', marginTop: 18 }} disabled={saving} onClick={save}>
            {saving ? 'Saving…' : <><Icon icon="solar:check-circle-bold" size={18} /> Save filters</>}
          </button>
        </>
      )}
    </Sheet>
  );
}

// Search AO3 tags + pick them into a list, shown as removable chips. Reused for
// both the include set and the exclude set; `accent` recolors the exclude one.
function TagPicker({ picked, onAdd, onRemove, placeholder, accent }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const debounce = useRef();
  const reqId = useRef(0); // monotonic id so a slow earlier search can't overwrite a newer one

  useEffect(() => {
    clearTimeout(debounce.current);
    const q = term.trim();
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    const id = ++reqId.current; // this query's ticket
    setSearching(true);
    debounce.current = setTimeout(() => {
      autocompleteTags(q)
        .then((r) => { if (id === reqId.current) setResults(r); })   // ignore stale resolutions
        .catch(() => { if (id === reqId.current) setResults([]); })
        .finally(() => { if (id === reqId.current) setSearching(false); });
    }, 280);
    return () => clearTimeout(debounce.current);
  }, [term]);

  const add = (t) => { onAdd(t); setTerm(''); setResults([]); reqId.current++; };
  // Close this picker's suggestion list when it loses focus, so moving to the
  // other (include ↔ exclude) field doesn't leave a stale dropdown open. Delay
  // so a tap on a suggestion still registers before the list clears.
  const onBlur = () => { reqId.current++; setTimeout(() => setResults([]), 150); };

  return (
    <div>
      {picked.length > 0 && (
        <div className="chiprow" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {picked.map((t) => {
            const c = accent || TAG_COLOR[t.kind] || TAG_COLOR.freeform;
            return (
              <span key={t.name} className="chip" style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c, paddingRight: 6 }}>
                <span className="swatch" style={{ background: c }}></span>{t.name}
                <button className="iconbtn" style={{ width: 18, height: 18, marginLeft: 2 }} onClick={() => onRemove(t.name)} aria-label="Remove tag">
                  <Icon icon="solar:close-circle-bold" size={15} color={c} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <SearchField placeholder={placeholder} value={term} onChange={setTerm} onBlur={onBlur} />
      {searching && <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 6, paddingLeft: 2 }}>Searching AO3…</div>}
      {results.length > 0 && (
        <div className="tag-suggest" style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {results.map((t) => (
            <button
              key={`${t.name}-${t.id}`}
              className="pressable"
              onClick={() => add(t)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '11px 14px', background: 'transparent', borderBottom: '1px solid var(--border)' }}
            >
              <Icon icon="solar:add-circle-linear" size={18} color={accent || 'var(--accent)'} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
            </button>
          ))}
        </div>
      )}
      {/* Always offer to add exactly what you typed — so a slow/empty AO3
          autocomplete can never block you from adding a tag. AO3's own search
          canonicalises it when the worker runs. Hidden only if it duplicates a
          shown suggestion or an already-picked tag. */}
      {term.trim().length >= 2
        && !picked.some((p) => p.name.toLowerCase() === term.trim().toLowerCase())
        && !results.some((r) => r.name.toLowerCase() === term.trim().toLowerCase()) && (
        <button className="pressable" onClick={() => add({ name: term.trim(), id: '', kind: 'freeform' })}
          style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', marginTop: 8, padding: '11px 14px', background: 'transparent', border: '1px dashed var(--border)', borderRadius: 12, color: 'var(--text-secondary)' }}>
          <Icon icon="solar:add-circle-bold" size={18} color={accent || 'var(--accent)'} />
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Add “{term.trim()}”</span>
        </button>
      )}
    </div>
  );
}

// Pick from a source's fixed genre + tag taxonomy (no live search — the list is
// shipped in the source registry). Stores each pick as {name, id:slug, kind}.
function GenrePicker({ genres, label, picked, onAdd, onRemove }) {
  const [term, setTerm] = useState('');
  const q = term.trim().toLowerCase();
  const pickedSlugs = new Set(picked.map((t) => t.id));
  const matches = genres
    .filter((g) => !pickedSlugs.has(g.slug))
    .filter((g) => !q || g.name.toLowerCase().includes(q))
    .slice(0, 14);
  const add = (g) => { onAdd({ name: g.name, id: g.slug, kind: g.kind || 'genre' }); setTerm(''); };

  return (
    <div>
      {picked.length > 0 && (
        <div className="chiprow" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {picked.map((t) => {
            const c = TAG_COLOR.freeform;
            return (
              <span key={t.id} className="chip" style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c, paddingRight: 6 }}>
                <span className="swatch" style={{ background: c }}></span>{t.name}
                <button className="iconbtn" style={{ width: 18, height: 18, marginLeft: 2 }} onClick={() => onRemove(t.name)} aria-label="Remove genre">
                  <Icon icon="solar:close-circle-bold" size={15} color={c} />
                </button>
              </span>
            );
          })}
        </div>
      )}
      <SearchField placeholder={`Filter ${label} genres…`} value={term} onChange={setTerm} />
      {matches.length > 0 && (
        <div className="tag-suggest" style={{ marginTop: 8, border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
          {matches.map((g) => (
            <button
              key={g.slug}
              className="pressable"
              onClick={() => add(g)}
              style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '11px 14px', background: 'transparent', borderBottom: '1px solid var(--border)' }}
            >
              <Icon icon="solar:add-circle-linear" size={18} color="var(--accent)" />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{g.name}</span>
              <span style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{g.kind === 'tag' ? 'tag' : 'genre'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Free-text subject/genre entry for the Books watcher. Open Library has an
// open-ended subject vocabulary (no fixed list, no autocomplete), so the user
// types a subject and it becomes a chip. Stored as {name, id:'', kind:'subject'}
// so the worker queries Open Library's search.json by subject.
function SubjectPicker({ picked, onAdd, onRemove, placeholder = 'Search reader tags — romance, m/m, enemies to lovers, hockey…', accent }) {
  const [term, setTerm] = useState('');
  const add = (name) => {
    const n = (name || '').trim();
    if (!n) return;
    onAdd({ name: n, id: '', kind: 'subject' });
    setTerm('');
  };
  const commit = () => add(term);
  const c = accent || TAG_COLOR.freeform;

  // Autocomplete over the Goodreads reader-tag vocabulary (free text still works
  // for anything not listed). Hide ones already picked.
  const q = term.trim().toLowerCase();
  const pickedLc = new Set(picked.map((p) => (p.name || '').toLowerCase()));
  const suggestions = q
    ? GOODREADS_TAGS.filter((t) => t.toLowerCase().includes(q) && !pickedLc.has(t.toLowerCase())).slice(0, 8)
    : [];

  return (
    <div>
      {picked.length > 0 && (
        <div className="chiprow" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
          {picked.map((t) => (
            <span key={t.name} className="chip" style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c, paddingRight: 6 }}>
              <span className="swatch" style={{ background: c }}></span>{t.name}
              <button className="iconbtn" style={{ width: 18, height: 18, marginLeft: 2 }} onClick={() => onRemove(t.name)} aria-label="Remove subject">
                <Icon icon="solar:close-circle-bold" size={15} color={c} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <div style={{ flex: 1 }}>
          <SearchField placeholder={placeholder} value={term} onChange={setTerm} onSubmit={commit} />
        </div>
        <button className="btn btn-flat" onClick={commit} disabled={!term.trim()} style={{ opacity: term.trim() ? 1 : 0.5 }}>
          <Icon icon="solar:add-circle-linear" size={18} /> Add
        </button>
      </div>
      {suggestions.length > 0 && (
        <div className="chiprow" style={{ flexWrap: 'wrap', gap: 7, marginTop: 10 }}>
          {suggestions.map((s) => (
            <button key={s} className="chip pressable" onClick={() => add(s)}
              style={{ background: 'var(--surface-2)', color: 'var(--text-secondary)' }}>
              <Icon icon="solar:add-circle-linear" size={13} color="var(--text-tertiary)" /> {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Compact match count (12513 → "12.5k", 425525 → "426k").
const fmtCount = (c) => {
  const n = Number(c) || 0;
  if (n >= 100000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
};

// The three-state icon for a romance.io topic row: unset (plus) → included (check)
// → excluded (no-entry). Colours: accent for include, danger for exclude.
function TopicStateIcon({ state }) {
  if (state === 'in') return <Icon icon="solar:check-circle-bold" size={22} color="var(--accent)" />;
  if (state === 'ex') return <Icon icon="solar:forbidden-circle-bold" size={22} color="var(--danger, #f5455c)" />;
  return <Icon icon="solar:add-circle-linear" size={22} color="var(--text-tertiary)" />;
}

// A picked include/exclude chip in the romance.io picker summary.
function TopicChip({ t, mode, onRemove }) {
  const c = mode === 'in' ? 'var(--accent)' : 'var(--danger, #f5455c)';
  const icon = mode === 'in' ? 'solar:check-circle-bold' : 'solar:forbidden-circle-bold';
  return (
    <span className="chip" style={{ background: `color-mix(in srgb, ${c} 15%, transparent)`, color: c, paddingRight: 6 }}>
      <Icon icon={icon} size={14} color={c} /> {t.name}
      <button className="iconbtn" style={{ width: 18, height: 18, marginLeft: 2 }} onClick={() => onRemove(t)} aria-label="Remove topic">
        <Icon icon="solar:close-circle-bold" size={15} color={c} />
      </button>
    </span>
  );
}

// Collapsible tree picker shared by every non-AO3 source (romance.io topics, Royal
// Road / Scribble Hub genres+tags, Goodreads subjects). Categories collapse; a flat
// search spans everything. Each row is ONE tap target that CYCLES include → exclude
// → off, so a single control expresses both "must have" and "never show".
// `included`/`excluded` are stored {name,id,kind}; rows match by key (id||name) so
// slug-less vocabularies (Goodreads) work too. Counts render only when present.
function TopicPicker({ tree, included, excluded, onCycle, onRemove, placeholder = 'Search all topics…' }) {
  const [term, setTerm] = useState('');
  const [openCats, setOpenCats] = useState(() => new Set());
  const keyOf = (t) => String((t && (t.id || t.name)) || '').toLowerCase();
  const incSet = new Set(included.map(keyOf));
  const excSet = new Set(excluded.map(keyOf));
  const stateOf = (s) => { const k = String(s).toLowerCase(); return incSet.has(k) ? 'in' : excSet.has(k) ? 'ex' : 'off'; };
  const q = term.trim().toLowerCase();
  const toggleCat = (name) => setOpenCats((s) => { const n = new Set(s); n.has(name) ? n.delete(name) : n.add(name); return n; });
  const catSelected = (cat) => cat.groups.reduce((a, g) => a + g.topics.filter((t) => stateOf(t.s) !== 'off').length, 0);

  const results = q
    ? tree.flatMap((cat) => cat.groups.flatMap((g) => g.topics
        .filter((t) => t.n.toLowerCase().includes(q) || t.s.toLowerCase().includes(q))
        .map((t) => ({ ...t, cat: cat.cat })))).slice(0, 60)
    : null;

  const Row = (t, ctx) => (
    <button key={t.s} className="pressable" onClick={() => onCycle(t)}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '10px 12px', background: 'transparent', borderBottom: '1px solid var(--border)' }}>
      <TopicStateIcon state={stateOf(t.s)} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.n}</span>
      {ctx && <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-tertiary)' }}>{ctx}</span>}
      {t.c != null && <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontVariantNumeric: 'tabular-nums' }}>{fmtCount(t.c)}</span>}
    </button>
  );

  return (
    <div>
      {(included.length > 0 || excluded.length > 0) && (
        <div className="chiprow" style={{ flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
          {included.map((t) => <TopicChip key={`i${t.id}`} t={t} mode="in" onRemove={onRemove} />)}
          {excluded.map((t) => <TopicChip key={`e${t.id}`} t={t} mode="ex" onRemove={onRemove} />)}
        </div>
      )}
      <SearchField placeholder={placeholder} value={term} onChange={setTerm} />
      <div style={{ marginTop: 10 }}>
        {results ? (
          results.length === 0 ? (
            <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '6px 2px' }}>No topics match “{term}”.</div>
          ) : (
            <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
              {results.map((t) => Row(t, t.cat))}
            </div>
          )
        ) : (
          tree.map((cat) => {
            const open = openCats.has(cat.cat);
            const sel = catSelected(cat);
            return (
              <div key={cat.cat} style={{ border: '1px solid var(--border)', borderRadius: 12, marginBottom: 8, overflow: 'hidden' }}>
                <button className="pressable" onClick={() => toggleCat(cat.cat)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '12px 14px', background: 'var(--surface-2)', border: 'none' }}>
                  <Icon icon={open ? 'solar:alt-arrow-down-linear' : 'solar:alt-arrow-right-linear'} size={16} color="var(--text-tertiary)" />
                  <span style={{ flex: 1, textAlign: 'left', fontWeight: 700, fontSize: 12.5, letterSpacing: '.04em' }}>{cat.cat}</span>
                  {sel > 0 && (
                    <span className="chip" style={{ height: 20, background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 11, fontWeight: 700 }}>{sel}</span>
                  )}
                </button>
                {open && cat.groups.map((g, gi) => (
                  <div key={gi}>
                    {g.head && <div className="section-label" style={{ padding: '9px 14px 3px', fontSize: 10.5 }}>{g.head}</div>}
                    {g.topics.map((t) => Row(t))}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---- Builder sheet: pick a source, pick tags/genres → save a group ----------
const BUILDER_SOURCES = ['ao3', 'royalroad', 'scribblehub', 'romanceio'];

export function TagGroupBuilder({ open, onClose, onCreated, initialSource = 'ao3', initialTags = [], editGroup = null }) {
  const [source, setSource] = useState(initialSource);
  const [picked, setPicked] = useState([]);
  const [excluded, setExcluded] = useState([]);
  const [matchMode, setMatchMode] = useState('all');
  const [status, setStatus] = useState('all'); // all | ongoing | complete
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const editing = !!editGroup;

  // Seed each time it opens. In EDIT mode, pre-fill from the group being edited
  // (so you tweak its tags/excludes/status); otherwise seed from a tapped tag +
  // the current shelf's source.
  useEffect(() => {
    if (!open) return;
    setErr('');
    if (editGroup) {
      const clone = (l) => (l || [])
        .map((t) => ({ name: t.name || t.t, id: t.id ?? '', kind: t.kind || t.k || 'freeform' }))
        .filter((t) => t.name);
      setSource(editGroup.source || 'ao3');
      setPicked(clone(editGroup.tags));
      setExcluded(clone(editGroup.excludedTags));
      setMatchMode(editGroup.matchMode || 'all');
      setStatus(editGroup.status || 'all');
    } else {
      setSource(initialSource || 'ao3');
      setPicked(initialTags || []);
      setExcluded([]); setMatchMode('all'); setStatus('all');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Switching source clears picks — AO3 tags and RR genres aren't interchangeable.
  const changeSource = (s) => { setSource(s); setPicked([]); setExcluded([]); setMatchMode('all'); setStatus('all'); setErr(''); };

  const isAo3 = source === 'ao3';
  const isBooks = source === 'books'; // legacy Goodreads groups (edit only)
  const isRomance = source === 'romanceio';
  const noun = isAo3 ? 'tag' : isRomance ? 'topic' : isBooks ? 'subject' : 'genre';
  const has = (list, t) => list.some((x) => x.name.toLowerCase() === t.name.toLowerCase());
  const addPicked = (t) => { setPicked((p) => (has(p, t) ? p : [...p, t])); setErr(''); };
  const removePicked = (name) => setPicked((p) => p.filter((x) => x.name !== name));
  const addExcluded = (t) => setExcluded((p) => (has(p, t) ? p : [...p, t]));
  const removeExcluded = (name) => setExcluded((p) => p.filter((x) => x.name !== name));

  // Non-AO3 tree picker: one tap target cycles a topic off → include → exclude →
  // off, so a single control drives both `picked` (include) and `excluded`. Chip ✕
  // clears it. Rows/picks are matched by key (id||name) so slug-less Goodreads
  // subjects work; the stored pick keeps the topic's own kind.
  const keyOf = (t) => String((t && (t.id || t.name)) || '').toLowerCase();
  const cycleTopic = (topic) => {
    const kind = topic.k || (isRomance ? 'topic' : isBooks ? 'subject' : 'genre');
    const t = { name: topic.n, id: topic.s, kind };
    const k = String(topic.s).toLowerCase(); setErr('');
    const inInc = picked.some((x) => keyOf(x) === k);
    const inExc = excluded.some((x) => keyOf(x) === k);
    if (!inInc && !inExc) setPicked((p) => [...p, t]);
    else if (inInc) { setPicked((p) => p.filter((x) => keyOf(x) !== k)); setExcluded((e) => [...e, t]); }
    else setExcluded((e) => e.filter((x) => keyOf(x) !== k));
  };
  const clearTopic = (item) => { const k = keyOf(item); setPicked((p) => p.filter((x) => keyOf(x) !== k)); setExcluded((e) => e.filter((x) => keyOf(x) !== k)); };

  const save = async () => {
    if (!picked.length) { setErr(`Add at least one ${noun} first.`); return; }
    setBusy(true); setErr('');
    try {
      // AO3 honours the chosen match mode. Royal Road / Scribble Hub / Books all
      // AND their tags natively now (multi tagsAdd / Series Finder / Open Library
      // subject query) and subtract excludes, so a multi-tag group is "all".
      const payload = {
        tags: picked,
        excludedTags: excluded,
        matchMode: isAo3 ? matchMode : 'all',
        status: (isBooks || isRomance) ? 'all' : status,
      };
      const g = editing
        ? await updateGroup(editGroup.id, { ...payload, label: editGroup.label || '' })
        : await createGroup({ source, ...payload });
      onCreated(g, editing);
    } catch (e) {
      setErr(e?.message ? String(e.message) : 'Could not save — check your connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title={editing ? 'Edit tag group' : 'Track a tag group'} maxH="88vh">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {!editing && (
          <div>
            <div className="section-label" style={{ marginBottom: 8 }}>Source</div>
            <Segmented
              value={source}
              onChange={changeSource}
              options={BUILDER_SOURCES.map((s) => ({ value: s, label: sourceLabel(s) }))}
            />
          </div>
        )}

        <div>
          <div className="section-label" style={{ marginBottom: 8 }}>
            {isAo3
              ? (picked.length <= 1 ? 'Track this tag' : `Track works with ${matchMode === 'all' ? 'ALL' : 'ANY'} of these tags`)
              : isRomance ? 'Pick topics'
              : isBooks ? 'Pick subjects'
              : 'Pick genres & tags'}
          </div>
          {isAo3 ? (
            <TagPicker picked={picked} onAdd={addPicked} onRemove={removePicked} placeholder="Search AO3 tags to include…" />
          ) : (
            <TopicPicker
              tree={treeForSource(source)}
              included={picked}
              excluded={excluded}
              onCycle={cycleTopic}
              onRemove={clearTopic}
              placeholder={isRomance ? 'Search all topics — enemies to lovers, mafia…'
                : isBooks ? 'Search reader tags — romance, m/m, fantasy…'
                : `Search ${sourceLabel(source)} genres & tags…`}
            />
          )}
          {!isAo3 && (
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 9, lineHeight: 1.5 }}>
              Tap once to <b style={{ color: 'var(--accent)' }}>include</b>, again to <b style={{ color: 'var(--danger, #f5455c)' }}>exclude</b>, once more to clear.
              {(isBooks || isRomance) && ' Notify-only — these books can’t be downloaded; matches link out so you can buy the EPUB and upload it.'}
            </div>
          )}
        </div>

        {isAo3 && picked.length > 1 && (
          <div>
            <div className="section-label" style={{ marginBottom: 8 }}>Match</div>
            <Segmented
              value={matchMode}
              onChange={setMatchMode}
              options={[{ value: 'all', label: 'Has all tags' }, { value: 'any', label: 'Has any tag' }]}
            />
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 7 }}>
              {matchMode === 'all'
                ? 'A work must carry every tag in the group.'
                : 'A work matches if it has at least one of these tags.'}
            </div>
          </div>
        )}

        {!isBooks && !isRomance && (
          <div>
            <div className="section-label" style={{ marginBottom: 8 }}>Status</div>
            <Segmented
              value={status}
              onChange={setStatus}
              options={[{ value: 'all', label: 'All' }, { value: 'ongoing', label: 'Ongoing' }, { value: 'complete', label: 'Complete' }]}
            />
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 7 }}>
              {status === 'all' ? 'Match works of any completion status.'
                : status === 'ongoing' ? 'Only works still in progress.'
                : 'Only finished works.'}
            </div>
          </div>
        )}

        {isAo3 && (
          <div>
            <div className="section-label" style={{ marginBottom: 8 }}>Exclude <span style={{ fontWeight: 500, color: 'var(--text-tertiary)' }}>(optional)</span></div>
            <TagPicker picked={excluded} onAdd={addExcluded} onRemove={removeExcluded} placeholder="Search AO3 tags to exclude…" accent="var(--danger, #f5455c)" />
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 7 }}>
              Works carrying any excluded tag are left out of your matches.
            </div>
          </div>
        )}

        {err && <div style={{ color: 'var(--danger, #f5455c)', fontSize: 13 }}>{err}</div>}
        {editing && (
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: -4 }}>
            Saving rebuilds this group — current matches are cleared and re-discovered on the next sync.
          </div>
        )}

        {/* Sticky footer so the track/save button is always reachable — the Books
            and Stories topic trees are long, and scrolling to the bottom each time
            to find it was tedious. Negative margins full-bleed it and cancel the
            sheet-body's bottom padding so it sits flush at the sheet's edge. */}
        <div style={{
          position: 'sticky', bottom: 0, zIndex: 2,
          marginLeft: -20, marginRight: -20,
          marginBottom: 'calc(-20px - env(safe-area-inset-bottom))',
          padding: '12px 20px calc(12px + env(safe-area-inset-bottom))',
          background: 'var(--surface-elevated)', borderTop: '1px solid var(--border)',
        }}>
          <button className="btn btn-lg btn-primary btn-block" disabled={busy || !picked.length} onClick={save} style={{ opacity: busy || !picked.length ? 0.6 : 1 }}>
            {busy ? 'Saving…' : editing ? 'Save changes' : `Track this ${picked.length > 1 ? 'group' : noun}`}
          </button>
        </div>
      </div>
    </Sheet>
  );
}

// ---- Results: works the worker found for a tracked group -------------------
export function TagResultsScreen({ tag, nav, onLeave, onEdit }) {
  const [items, setItems] = useState(null); // null = loading
  const [statusFilter, setStatusFilter] = useState('all'); // all | ongoing | complete — quick filter over the results
  const [titleExpanded, setTitleExpanded] = useState(false); // tap title to see full tag-group name
  const [toast, showToast] = useToast();
  const c = TAG_COLOR[tag.kind] || 'var(--accent)';
  const kindLabel = { relationship: 'relationship', fandom: 'fandom', freeform: 'tag', character: 'character', group: 'tag group', language: 'language', genre: 'genre' }[tag.kind] || 'tag';
  const srcLabel = sourceLabel(tag.source || 'ao3');

  useEffect(() => {
    let alive = true;
    fetchMatches(tag.id)
      .then((r) => { if (alive) setItems(r ?? SUGGESTIONS); })
      .catch(() => { if (alive) setItems(SUGGESTIONS); });
    // Viewing the matches clears the "N new" badge on the tile.
    markGroupSeen(tag.id).catch(() => {});
    return () => { alive = false; };
  }, [tag.id]);

  const leave = () => { onLeave && onLeave(); nav.pop(); };

  const dismiss = (w) => {
    setItems((arr) => (arr || []).filter((x) => x.id !== w.id));
    dismissMatch(w.matchId || w.id).catch(() => {});
    showToast('Deleted', 'solar:trash-bin-trash-linear');
  };

  const later = (w) => {
    setItems((arr) => (arr || []).filter((x) => x.id !== w.id));
    markLater(w.matchId || w.id).catch(() => {});
    showToast('Saved for later', 'solar:bookmark-linear');
  };

  const save = (w) => {
    setItems((arr) => (arr || []).map((x) => (x.id === w.id ? { ...x, wanted: true } : x)));
    requestSave(w.matchId || w.id).catch(() => {});
    showToast('Saved — starting download', 'solar:download-minimalistic-linear');
  };
  const saveStateOf = (w) => (w.saved ? 'saved' : w.wanted ? 'queued' : 'idle');

  const removeGroup = async () => {
    try { await deleteGroup(tag.id); } catch (e) { /* sample data / offline */ }
    showToast('Stopped tracking');
    leave();
  };

  const list = items || [];
  // Quick complete/ongoing filter over the loaded results (client-side — separate
  // from the group's own status setting in its tag settings).
  const shown = statusFilter === 'all' ? list
    : statusFilter === 'complete' ? list.filter((w) => (w.status || '') === 'complete')
      : list.filter((w) => (w.status || '') !== 'complete');
  // Tags this group is already defined by — hidden from each card so the chips
  // show OTHER tags (no repeating what you're browsing).
  const groupTagNames = [tag.name, ...((tag.tags || []).map((t) => (typeof t === 'string' ? t : t.name)))].filter(Boolean);
  return (
    <div className="screen">
      <Appbar
        back={leave}
        title={tag.name}
        sub={`${tag.count ?? list.length} works · ${kindLabel}`}
        actions={[
          ...(onEdit && tag.kind !== 'language' ? [{ icon: 'solar:pen-2-linear', onClick: () => { onEdit(tag); nav.pop(); } }] : []),
          { icon: 'solar:trash-bin-trash-linear', onClick: removeGroup },
        ]}
        onTitleClick={() => setTitleExpanded((v) => !v)}
        titleExpanded={titleExpanded}
      />
      <div className="scroll" style={{ padding: '4px 20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16 }}>
          <span className="chip" style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c, height: 26 }}>
            <span className="swatch" style={{ background: c }}></span>{kindLabel}
          </span>
          {list.length > 0 && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              {[
                { key: 'ongoing', label: 'Ongoing', icon: 'solar:clock-circle-linear' },
                { key: 'complete', label: 'Completed', icon: 'solar:check-circle-linear' },
              ].map((o) => {
                const on = statusFilter === o.key;
                return (
                  <button key={o.key} aria-label={`${o.label} only`} title={`${o.label} only`}
                    onClick={() => setStatusFilter((s) => (s === o.key ? 'all' : o.key))}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, height: 30, padding: '0 10px', borderRadius: 8, border: 'none', fontSize: 12, fontWeight: 600, background: on ? 'var(--accent-soft)' : 'var(--surface-2)', color: on ? 'var(--accent)' : 'var(--text-tertiary)' }}>
                    <Icon icon={o.icon} size={16} color={on ? 'var(--accent)' : 'var(--text-tertiary)'} /> {o.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {items === null ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>
        ) : list.length === 0 ? (
          <EmptyState icon="solar:inbox-line-linear" title="No matches yet" desc={`When the worker next checks ${srcLabel}, new works for this ${kindLabel} will appear here.`} />
        ) : shown.length === 0 ? (
          <EmptyState icon="solar:inbox-line-linear" title={`No ${statusFilter} works here`} desc="Tap the filter icon again to show all." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {shown.map((w) => (
              <SuggestionCard
                key={w.id}
                work={w}
                excludeTags={groupTagNames}
                onSave={isSavableSource(w.source) ? save : null}
                saveState={saveStateOf(w)}
                onLater={() => later(w)}
                onDismiss={() => dismiss(w)}
                onOpen={() => nav.push('detail', { work: w, suggestion: true })}
              />
            ))}
          </div>
        )}
        {toast}
      </div>
    </div>
  );
}

// ---- Later stash: works swiped left ("maybe") for safe-keeping --------------
export function LaterScreen({ nav, onLeave }) {
  const [items, setItems] = useState(null); // null = loading
  const [toast, showToast] = useToast();

  const load = useCallback(() => {
    fetchLaterMatches()
      .then((r) => setItems(r ?? []))
      .catch(() => setItems([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const leave = () => { onLeave && onLeave(); nav.pop(); };

  const remove = (w) => {
    setItems((arr) => (arr || []).filter((x) => x.id !== w.id));
    dismissMatch(w.matchId || w.id).catch(() => {});
    showToast('Deleted', 'solar:trash-bin-trash-linear');
  };
  const putBack = (w) => {
    setItems((arr) => (arr || []).filter((x) => x.id !== w.id));
    unmarkLater(w.matchId || w.id).catch(() => {});
    showToast('Back in Discover', 'solar:undo-left-round-linear');
  };
  const save = (w) => {
    setItems((arr) => (arr || []).map((x) => (x.id === w.id ? { ...x, wanted: true } : x)));
    requestSave(w.matchId || w.id).catch(() => {});
    showToast('Saved — starting download', 'solar:download-minimalistic-linear');
  };
  const saveStateOf = (w) => (w.saved ? 'saved' : w.wanted ? 'queued' : 'idle');

  const list = items || [];
  return (
    <div className="screen">
      <Appbar back={leave} title="Later" sub={`${list.length} kept · metadata only`} />
      <div className="scroll" style={{ padding: '4px 20px 24px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>
          Works you set aside to decide on later. Tap ✕ to delete, or the arrow to send one back to Discover.
        </div>
        {items === null ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>
        ) : list.length === 0 ? (
          <EmptyState icon="solar:bookmark-linear" title="Nothing saved for later"
            desc="Tap Later on a discovered work to keep its blurb here without downloading it." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {list.map((w) => (
              <SuggestionCard
                key={w.id}
                work={w}
                onSave={isSavableSource(w.source) ? save : null}
                saveState={saveStateOf(w)}
                onLater={() => putBack(w)}
                laterIcon="solar:undo-left-round-linear"
                laterTitle="Send back to Discover"
                onDismiss={() => remove(w)}
                onOpen={() => nav.push('detail', { work: w, suggestion: true })}
              />
            ))}
          </div>
        )}
        {toast}
      </div>
    </div>
  );
}

// ---- Failed stash: saves that couldn't download (retry / dismiss) -----------
export function FailedScreen({ nav, onLeave }) {
  const [items, setItems] = useState(null); // null = loading
  const [toast, showToast] = useToast();

  const load = useCallback(() => {
    // Failed discovery saves (tag_matches) + failed link imports (requested_urls),
    // newest first — both retryable, links via the logged-in worker.
    Promise.all([fetchFailedMatches().catch(() => []), fetchFailedLinks().catch(() => [])])
      .then(([matches, links]) => setItems([...(links || []), ...(matches || [])]))
      .catch(() => setItems([]));
  }, []);
  useEffect(() => { load(); }, [load]);

  const leave = () => { onLeave && onLeave(); nav.pop(); };

  const remove = (w) => {
    setItems((arr) => (arr || []).filter((x) => x.id !== w.id));
    (w.isLink ? removeRequest(w.requestId) : dismissMatch(w.matchId || w.id)).catch?.(() => {});
    showToast('Dismissed', 'solar:trash-bin-trash-linear');
  };
  const retry = (w) => {
    setItems((arr) => (arr || []).filter((x) => x.id !== w.id)); // optimistic — back into the retry loop
    (w.isLink ? retryLinkRequest(w.requestId) : retryMatch(w.matchId || w.id)).catch?.(() => {});
    showToast(w.isLink ? 'Retrying with your AO3 account' : 'Retrying — downloading', 'solar:refresh-circle-linear');
  };

  const linkCount = (items || []).filter((w) => w.isLink).length;
  const retryAllLinks = async () => {
    if (!linkCount) return;
    setItems((arr) => (arr || []).filter((x) => !x.isLink)); // optimistic
    const r = await retryAllFailedLinks().catch(() => ({}));
    showToast(`Retrying ${r.count || linkCount} link${(r.count || linkCount) === 1 ? '' : 's'} with your AO3 account`, 'solar:refresh-circle-linear');
  };

  const list = items || [];
  return (
    <div className="screen">
      <Appbar back={leave} title="Failed" sub={`${list.length} couldn’t download`} />
      <div className="scroll" style={{ padding: '4px 20px 24px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>
          Saves that couldn’t be downloaded — a work removed at the source, or one that stayed unreachable. Tap the retry arrow to try again, or ✕ to dismiss.
        </div>
        {linkCount > 1 && (
          <button className="btn btn-surface btn-md" onClick={retryAllLinks}
            style={{ marginBottom: 14, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <Icon icon="solar:refresh-circle-linear" size={17} /> Retry all {linkCount} links with my account
          </button>
        )}
        {items === null ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>
        ) : list.length === 0 ? (
          <EmptyState icon="solar:check-circle-linear" title="Nothing failed"
            desc="Saves that can’t be downloaded show up here to retry or dismiss." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {list.map((w) => (
              <div key={w.id}>
                {w.failReason && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: 'var(--danger, #f5455c)', margin: '0 2px 5px' }}>
                    <Icon icon="solar:danger-triangle-linear" size={14} color="var(--danger, #f5455c)" />
                    {w.failReason}
                  </div>
                )}
                <SuggestionCard
                  work={w}
                  onSave={isSavableSource(w.source) ? retry : null}
                  saveState="idle"
                  cta="Retry"
                  onDismiss={() => remove(w)}
                  onOpen={() => nav.push('detail', { work: w, suggestion: true })}
                />
              </div>
            ))}
          </div>
        )}
        {toast}
      </div>
    </div>
  );
}
