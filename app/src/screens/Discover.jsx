import { useState, useEffect, useRef, useCallback } from 'react';
import { Appbar } from '../components/chrome.jsx';
import Icon from '../components/Icon.jsx';
import { SearchField, EmptyState, TAG_COLOR, useToast, Sheet, Segmented } from '../components/ui.jsx';
import { TagTile, SuggestionCard, Swipeable } from '../components/cards.jsx';
import {
  fetchTrackedGroups, createGroup, createLanguageGroup, deleteGroup,
  fetchMatches, dismissMatch, markGroupSeen, autocompleteTags, requestSave,
  markLater, unmarkLater, fetchLaterMatches,
} from '../lib/tags.js';
import { kickSync } from '../lib/sync.js';
import { TRACKED_TAGS, SUGGESTIONS } from '../data/sample.js';
import { ROYALROAD_GENRES, sourceLabel } from '../sources/index.js';

// Languages you can browse straight from Discover. `code` is AO3's language_id
// (ISO 639); `name` is shown on the tile. Add more entries to offer more.
const LANGUAGES = [{ code: 'hy', name: 'հայերեն', label: 'Armenian', palette: 3 }];

// ============================================================================
// Discover — track AO3 tags / tag groups and review the works they turn up.
// Groups are stored in Supabase (tracked_groups); the worker fills tag_matches.
// ============================================================================

export function DiscoverScreen({ nav }) {
  const [groups, setGroups] = useState(null); // null = loading
  const [builderOpen, setBuilderOpen] = useState(false);
  const [toast, showToast] = useToast();

  const load = useCallback(() => {
    fetchTrackedGroups()
      .then((r) => setGroups(r ?? TRACKED_TAGS))
      .catch(() => setGroups(TRACKED_TAGS));
  }, []);
  useEffect(() => { load(); }, [load]);

  const all = groups || [];
  // Language groups get their own section; keep them out of the tag grid.
  const tags = all.filter((t) => t.kind !== 'language');
  const langGroups = all.filter((t) => t.kind === 'language');
  const fresh = tags.reduce((a, t) => a + (t.fresh || 0), 0);
  const open = (tag) => nav.push('tagresults', { tag, onLeave: load });
  const openLater = () => nav.push('later', { onLeave: load });

  const onCreated = (g) => {
    setBuilderOpen(false);
    showToast(`Now tracking “${g.name}”`);
    load();
  };

  // Tap a language: open its results if already browsing, else start one.
  const openLanguage = async (lang) => {
    const existing = langGroups.find((g) => g.language === lang.code);
    if (existing) { open(existing); return; }
    try {
      const g = await createLanguageGroup({ code: lang.code, name: lang.name, label: lang.label });
      showToast(`Browsing ${lang.label}`);
      load();
      open(g);
    } catch {
      showToast("Couldn't start — check your connection", 'solar:danger-triangle-linear');
    }
  };

  return (
    <div className="screen">
      <Appbar large title="Discover" />
      <div className="scroll" style={{ padding: '0 20px 24px' }}>
        <button
          className="searchfield pressable"
          style={{ width: '100%', marginBottom: 18, textAlign: 'left', cursor: 'pointer' }}
          onClick={() => setBuilderOpen(true)}
        >
          <Icon icon="solar:magnifer-linear" size={20} color="var(--text-tertiary)" />
          <span style={{ color: 'var(--text-tertiary)', flex: 1 }}>Track a tag, ship, or tag group…</span>
        </button>

        <button className="set-group pressable" onClick={openLater}
          style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 13, width: '100%', textAlign: 'left', marginBottom: 18 }}>
          <div className="set-ic"><Icon icon="solar:bookmark-linear" size={18} /></div>
          <div style={{ flex: 1 }}>
            <div className="set-h">Later</div>
            <div className="set-d">Works you set aside to decide on.</div>
          </div>
          <Icon icon="solar:alt-arrow-right-linear" size={18} color="var(--text-tertiary)" />
        </button>

        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="section-label">Tracked · {tags.length}</div>
          {fresh > 0 && <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{fresh} new matches</span>}
        </div>

        {groups === null ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '8px 2px' }}>Loading…</div>
        ) : tags.length === 0 ? (
          <EmptyState
            icon="solar:hashtag-circle-linear"
            title="Nothing tracked yet"
            desc="Track a tag or a tag group and FicStash will surface matching works as they're posted."
            action={<button className="btn btn-primary" onClick={() => setBuilderOpen(true)}><Icon icon="solar:add-circle-linear" size={18} /> Track a tag</button>}
          />
        ) : (
          <div className="tilegrid">
            {tags.map((t) => <TagTile key={t.id} tag={t} onOpen={open} />)}
            <button className="tile add pressable" onClick={() => setBuilderOpen(true)}>
              <Icon icon="solar:add-circle-linear" size={30} />
              <div className="t-name" style={{ marginTop: 6 }}>Track a new tag</div>
            </button>
          </div>
        )}

        {groups !== null && (
          <>
            <div className="section-label" style={{ marginTop: 26, marginBottom: 12 }}>Browse by language</div>
            <div className="tilegrid">
              {LANGUAGES.map((lang) => {
                const g = langGroups.find((x) => x.language === lang.code);
                const tile = g || { id: `lang-${lang.code}`, name: lang.name, kind: 'language', count: 0, fresh: 0, palette: lang.palette };
                return <TagTile key={lang.code} tag={tile} onOpen={() => openLanguage(lang)} />;
              })}
            </div>
          </>
        )}
      </div>

      <TagGroupBuilder open={builderOpen} onClose={() => setBuilderOpen(false)} onCreated={onCreated} />
      {toast}
    </div>
  );
}

// Search AO3 tags + pick them into a list, shown as removable chips. Reused for
// both the include set and the exclude set; `accent` recolors the exclude one.
function TagPicker({ picked, onAdd, onRemove, placeholder, accent }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const debounce = useRef();

  useEffect(() => {
    clearTimeout(debounce.current);
    const q = term.trim();
    if (q.length < 2) { setResults([]); setSearching(false); return; }
    setSearching(true);
    debounce.current = setTimeout(() => {
      autocompleteTags(q)
        .then((r) => setResults(r))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 280);
    return () => clearTimeout(debounce.current);
  }, [term]);

  const add = (t) => { onAdd(t); setTerm(''); setResults([]); };

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
      <SearchField placeholder={placeholder} value={term} onChange={setTerm} />
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
    </div>
  );
}

// Pick from Royal Road's fixed genre taxonomy (no live search — the list is
// shipped in the source registry). Stores each pick as {name, id:slug, kind}.
function RoyalRoadGenrePicker({ picked, onAdd, onRemove }) {
  const [term, setTerm] = useState('');
  const q = term.trim().toLowerCase();
  const pickedSlugs = new Set(picked.map((t) => t.id));
  const matches = ROYALROAD_GENRES
    .filter((g) => !pickedSlugs.has(g.slug))
    .filter((g) => !q || g.name.toLowerCase().includes(q))
    .slice(0, 12);
  const add = (g) => { onAdd({ name: g.name, id: g.slug, kind: 'genre' }); setTerm(''); };

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
      <SearchField placeholder="Filter Royal Road genres…" value={term} onChange={setTerm} />
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
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Builder sheet: pick a source, pick tags/genres → save a group ----------
const BUILDER_SOURCES = ['ao3', 'royalroad'];

function TagGroupBuilder({ open, onClose, onCreated }) {
  const [source, setSource] = useState('ao3');
  const [picked, setPicked] = useState([]);
  const [excluded, setExcluded] = useState([]);
  const [matchMode, setMatchMode] = useState('all');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (open) { setSource('ao3'); setPicked([]); setExcluded([]); setMatchMode('all'); setErr(''); }
  }, [open]);

  // Switching source clears picks — AO3 tags and RR genres aren't interchangeable.
  const changeSource = (s) => { setSource(s); setPicked([]); setExcluded([]); setMatchMode('all'); setErr(''); };

  const isAo3 = source === 'ao3';
  const noun = isAo3 ? 'tag' : 'genre';
  const has = (list, t) => list.some((x) => x.name.toLowerCase() === t.name.toLowerCase());
  const addPicked = (t) => { setPicked((p) => (has(p, t) ? p : [...p, t])); setErr(''); };
  const removePicked = (name) => setPicked((p) => p.filter((x) => x.name !== name));
  const addExcluded = (t) => setExcluded((p) => (has(p, t) ? p : [...p, t]));
  const removeExcluded = (name) => setExcluded((p) => p.filter((x) => x.name !== name));

  const save = async () => {
    if (!picked.length) { setErr(`Add at least one ${noun} first.`); return; }
    setBusy(true); setErr('');
    try {
      // Royal Road searches one genre at a time and unions the results, so a
      // multi-genre group is always "any". AO3 honours the chosen match mode.
      const g = await createGroup({
        source,
        tags: picked,
        excludedTags: isAo3 ? excluded : [],
        matchMode: isAo3 ? matchMode : 'any',
      });
      onCreated(g);
    } catch (e) {
      setErr(e?.message ? String(e.message) : 'Could not save — check your connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Track a tag group" maxH="88vh">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <div className="section-label" style={{ marginBottom: 8 }}>Source</div>
          <Segmented
            value={source}
            onChange={changeSource}
            options={BUILDER_SOURCES.map((s) => ({ value: s, label: sourceLabel(s) }))}
          />
        </div>

        <div>
          <div className="section-label" style={{ marginBottom: 8 }}>
            {picked.length <= 1
              ? `Track this ${noun}`
              : isAo3
                ? `Track works with ${matchMode === 'all' ? 'ALL' : 'ANY'} of these tags`
                : 'Track works in ANY of these genres'}
          </div>
          {isAo3 ? (
            <TagPicker picked={picked} onAdd={addPicked} onRemove={removePicked} placeholder="Search AO3 tags to include…" />
          ) : (
            <RoyalRoadGenrePicker picked={picked} onAdd={addPicked} onRemove={removePicked} />
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

        <button className="btn btn-primary" disabled={busy || !picked.length} onClick={save} style={{ width: '100%', opacity: busy || !picked.length ? 0.6 : 1 }}>
          {busy ? 'Saving…' : <><Icon icon="solar:check-circle-bold" size={18} /> Track this {picked.length > 1 ? 'group' : noun}</>}
        </button>
      </div>
    </Sheet>
  );
}

// ---- Results: works the worker found for a tracked group -------------------
export function TagResultsScreen({ tag, nav, onLeave }) {
  const [items, setItems] = useState(null); // null = loading
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
    requestSave(w.matchId || w.id).then(() => kickSync()).catch(() => {});
    showToast('Saved — starting download', 'solar:download-minimalistic-linear');
  };
  const saveStateOf = (w) => (w.saved ? 'saved' : w.wanted ? 'queued' : 'idle');

  const removeGroup = async () => {
    try { await deleteGroup(tag.id); } catch (e) { /* sample data / offline */ }
    showToast('Stopped tracking');
    leave();
  };

  const list = items || [];
  return (
    <div className="screen view-enter">
      <Appbar
        back={leave}
        title={tag.name}
        sub={`${tag.count ?? list.length} works · ${kindLabel}`}
        actions={[{ icon: 'solar:trash-bin-trash-linear', onClick: removeGroup }]}
      />
      <div className="scroll" style={{ padding: '4px 20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16, flexWrap: 'wrap' }}>
          <span className="chip" style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c, height: 26 }}>
            <span className="swatch" style={{ background: c }}></span>{kindLabel}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>metadata only — nothing downloaded</span>
        </div>

        {items === null ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>
        ) : list.length === 0 ? (
          <EmptyState icon="solar:inbox-line-linear" title="No matches yet" desc={`When the worker next checks ${srcLabel}, new works for this ${kindLabel} will appear here.`} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {list.map((w) => (
              <Swipeable key={w.id} onSwipeRight={() => dismiss(w)} onSwipeLeft={() => later(w)}>
                <SuggestionCard
                  work={w}
                  onSave={save}
                  saveState={saveStateOf(w)}
                  onDismiss={() => dismiss(w)}
                  onOpen={() => nav.push('detail', { work: w, suggestion: true })}
                />
              </Swipeable>
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
    requestSave(w.matchId || w.id).then(() => kickSync()).catch(() => {});
    showToast('Saved — starting download', 'solar:download-minimalistic-linear');
  };
  const saveStateOf = (w) => (w.saved ? 'saved' : w.wanted ? 'queued' : 'idle');

  const list = items || [];
  return (
    <div className="screen view-enter">
      <Appbar back={leave} title="Later" sub={`${list.length} kept · metadata only`} />
      <div className="scroll" style={{ padding: '4px 20px 24px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>
          Works you set aside to decide on later. Swipe right to delete, left to send back to Discover.
        </div>
        {items === null ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13 }}>Loading…</div>
        ) : list.length === 0 ? (
          <EmptyState icon="solar:bookmark-linear" title="Nothing saved for later"
            desc="Swipe a discovered work left to keep its blurb here without downloading it." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {list.map((w) => (
              <Swipeable key={w.id} onSwipeRight={() => remove(w)} onSwipeLeft={() => putBack(w)}
                left={{ icon: 'solar:undo-left-round-linear', label: 'Discover', color: 'var(--accent)' }}>
                <SuggestionCard
                  work={w}
                  onSave={save}
                  saveState={saveStateOf(w)}
                  onDismiss={() => remove(w)}
                  onOpen={() => nav.push('detail', { work: w, suggestion: true })}
                />
              </Swipeable>
            ))}
          </div>
        )}
        {toast}
      </div>
    </div>
  );
}
