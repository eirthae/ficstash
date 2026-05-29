import { useState } from 'react';
import { Appbar } from '../components/chrome.jsx';
import Icon from '../components/Icon.jsx';
import { SearchField, EmptyState, TAG_COLOR, useToast } from '../components/ui.jsx';
import { TagTile, SuggestionCard } from '../components/cards.jsx';

export function DiscoverScreen({ tags, nav }) {
  const [q, setQ] = useState('');
  const open = (tag) => nav.push('tagresults', { tag });
  const trackTag = () => q && nav.push('tagresults', { tag: { name: q, kind: 'freeform', count: 0, fresh: 0, palette: 2 } });
  return (
    <div className="screen">
      <Appbar large title="Discover" />
      <div className="scroll" style={{ padding: '0 20px 24px' }}>
        <div style={{ marginBottom: 18 }}>
          <SearchField placeholder="Track a tag, ship, or fandom…" value={q} onChange={setQ} onSubmit={trackTag} />
        </div>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 12 }}>
          <div className="section-label">Tracked tags · {tags.length}</div>
          <span style={{ fontSize: 12, color: 'var(--accent)', fontWeight: 600 }}>{tags.reduce((a, t) => a + t.fresh, 0)} new matches</span>
        </div>
        <div className="tilegrid">
          {tags.map(t => <TagTile key={t.id} tag={t} onOpen={open} />)}
          <button className="tile add pressable" onClick={() => document.querySelector('.searchfield input')?.focus()}>
            <Icon icon="solar:add-circle-linear" size={30} />
            <div className="t-name" style={{ marginTop: 6 }}>Track a new tag</div>
          </button>
        </div>
      </div>
    </div>
  );
}

export function TagResultsScreen({ tag, suggestions, nav }) {
  const [items, setItems] = useState(suggestions);
  const [fetch, setFetch] = useState({});
  const [toast, showToast] = useToast();
  const c = TAG_COLOR[tag.kind] || 'var(--accent)';

  const doFetch = (w) => {
    if (fetch[w.id] === 'done') return;
    setFetch(f => ({ ...f, [w.id]: 'busy' }));
    setTimeout(() => { setFetch(f => ({ ...f, [w.id]: 'done' })); showToast(`“${w.title}” saved to library`); }, 1300);
  };
  const dismiss = (w) => { setItems(arr => arr.filter(x => x.id !== w.id)); showToast('Dismissed — won\'t resurface', 'solar:eye-closed-linear'); };

  return (
    <div className="screen view-enter">
      <Appbar back={() => nav.pop()} title={tag.name} sub={`${tag.count} works · ${tag.fresh || items.length} to review`} />
      <div className="scroll" style={{ padding: '4px 20px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 16 }}>
          <span className="chip" style={{ background: `color-mix(in srgb, ${c} 16%, transparent)`, color: c, height: 26 }}>
            <span className="swatch" style={{ background: c }}></span>{tag.kind}</span>
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>metadata only — nothing downloaded until you save</span>
        </div>
        {items.length === 0 ? (
          <EmptyState icon="solar:inbox-line-linear" title="All caught up" desc="You've reviewed every new match for this tag. New works will appear here as they're posted." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {items.map(w => <SuggestionCard key={w.id} work={w} fetchState={fetch[w.id] || 'idle'}
              onFetch={() => doFetch(w)} onDismiss={() => dismiss(w)} onOpen={() => nav.push('detail', { work: w, suggestion: true })} />)}
          </div>
        )}
        {toast}
      </div>
    </div>
  );
}
