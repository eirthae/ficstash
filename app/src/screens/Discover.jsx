import { useState, useEffect, useRef, useCallback } from 'react';
import { Appbar } from '../components/chrome.jsx';
import Icon from '../components/Icon.jsx';
import { SearchField, EmptyState, TAG_COLOR, useToast, Sheet, Segmented } from '../components/ui.jsx';
import { TagTile, SuggestionCard } from '../components/cards.jsx';
import {
  fetchTrackedGroups, createGroup, createLanguageGroup, deleteGroup,
  fetchMatches, markMatchSeen, markGroupSeen, autocompleteTags, requestSave,
} from '../lib/tags.js';
import { kickSync } from '../lib/sync.js';
import { TRACKED_TAGS, SUGGESTIONS } from '../data/sample.js';

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

// ---- Builder sheet: live AO3 autocomplete → pick tags → save a group -------
function TagGroupBuilder({ open, onClose, onCreated }) {
  const [term, setTerm] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState([]);
  const [label, setLabel] = useState('');
  const [matchMode, setMatchMode] = useState('all');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const debounce = useRef();

  useEffect(() => {
    if (open) { setTerm(''); setResults([]); setPicked([]); setLabel(''); setMatchMode('all'); setErr(''); }
  }, [open]);

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

  const add = (t) => {
    if (!picked.some((p) => p.name.toLowerCase() === t.name.toLowerCase())) {
      setPicked((p) => [...p, t]);
      setErr('');
    }
    setTerm('');
    setResults([]);
  };
  const remove = (name) => setPicked((p) => p.filter((x) => x.name !== name));

  const save = async () => {
    if (!picked.length) { setErr('Add at least one tag first.'); return; }
    setBusy(true); setErr('');
    try {
      const g = await createGroup({ label: label.trim(), tags: picked, matchMode });
      onCreated(g);
    } catch (e) {
      setErr(e?.message ? String(e.message) : 'Could not save — check your connection.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="Track a tag group" maxH="88vh">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {picked.length > 0 && (
          <div>
            <div className="section-label" style={{ marginBottom: 8 }}>
              {picked.length === 1 ? 'Tracking this tag' : `Tracking works with ${matchMode === 'all' ? 'ALL' : 'ANY'} of these tags`}
            </div>
            <div className="chiprow" style={{ flexWrap: 'wrap', gap: 8 }}>
              {picked.map((t) => {
                const c = TAG_COLOR[t.kind] || TAG_COLOR.freeform;
                return (
                  <span key={t.name} className="chip" style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c, paddingRight: 6 }}>
                    <span className="swatch" style={{ background: c }}></span>{t.name}
                    <button className="iconbtn" style={{ width: 18, height: 18, marginLeft: 2 }} onClick={() => remove(t.name)} aria-label="Remove tag">
                      <Icon icon="solar:close-circle-bold" size={15} color={c} />
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        )}

        <div>
          <SearchField placeholder="Search AO3 tags…" value={term} onChange={setTerm} />
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
                  <Icon icon="solar:add-circle-linear" size={18} color="var(--accent)" />
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {picked.length > 1 && (
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

        <div>
          <div className="section-label" style={{ marginBottom: 8 }}>Name <span style={{ fontWeight: 500, color: 'var(--text-tertiary)' }}>(optional)</span></div>
          <input
            className="textinput"
            placeholder={picked.map((t) => t.name).join(' + ') || 'e.g. Soulmates AU — my ship'}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            style={{ width: '100%', padding: '12px 14px', borderRadius: 12, border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--text)', fontSize: 15 }}
          />
        </div>

        {err && <div style={{ color: 'var(--danger, #f5455c)', fontSize: 13 }}>{err}</div>}

        <button className="btn btn-primary" disabled={busy || !picked.length} onClick={save} style={{ width: '100%', opacity: busy || !picked.length ? 0.6 : 1 }}>
          {busy ? 'Saving…' : <><Icon icon="solar:check-circle-bold" size={18} /> Track this {picked.length > 1 ? 'group' : 'tag'}</>}
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
  const kindLabel = { relationship: 'relationship', fandom: 'fandom', freeform: 'tag', character: 'character', group: 'tag group', language: 'language' }[tag.kind] || 'tag';

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
    markMatchSeen(w.matchId || w.id).catch(() => {});
    showToast('Dismissed', 'solar:eye-closed-linear');
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
          <EmptyState icon="solar:inbox-line-linear" title="No matches yet" desc="When the worker next checks AO3, new works for this tag will appear here." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {list.map((w) => (
              <SuggestionCard
                key={w.id}
                work={w}
                onSave={save}
                saveState={saveStateOf(w)}
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
