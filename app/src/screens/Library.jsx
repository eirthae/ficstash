import { useState } from 'react';
import { Appbar } from '../components/chrome.jsx';
import { EmptyState, useToast } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { LibraryCard, GridCard } from '../components/cards.jsx';
import { triggerSync } from '../lib/sync.js';

// The fandom name without the author suffix ("Heated Rivalry – Rachel Reid" → "Heated Rivalry").
function fandomName(work) {
  return (work.fandom || 'Other').split('–')[0].split(' - ')[0].trim() || 'Other';
}

export function LibraryScreen({ works, layout = 'grid', connected = true, nav }) {
  const open = (w) => nav.push('detail', { work: w });
  const [toast, showToast] = useToast();
  const [syncing, setSyncing] = useState(false);

  const doSync = async () => {
    if (syncing) return;
    setSyncing(true);
    showToast('Starting sync…');
    const res = await triggerSync();
    setSyncing(false);
    showToast(res.ok ? 'Sync started — new works arrive shortly.' : (res.error || 'Sync failed.'));
  };
  const syncAction = { icon: syncing ? 'solar:refresh-circle-bold' : 'solar:refresh-circle-linear', onClick: doSync };

  if (works === null) {
    return (
      <div className="screen">
        <Appbar large title="Library" />
        <div className="scroll" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div className="fetch busy" style={{ width: 44, height: 44 }}>
            <svg className="ring" viewBox="0 0 44 44"><circle className="track" cx="22" cy="22" r="19"></circle>
              <circle className="bar" cx="22" cy="22" r="19" strokeDasharray="119" strokeDashoffset="50"></circle></svg>
          </div>
        </div>
      </div>
    );
  }

  if (!connected || works.length === 0) {
    return (
      <div className="screen">
        <Appbar large title="Library" />
        <div className="scroll" style={{ display: 'flex' }}>
          <EmptyState icon="solar:book-minimalistic-linear" title="Nothing here yet"
            desc="Connect your AO3 account and your bookmarks will download into your private shelf."
            action={<button className="btn btn-lg btn-primary" onClick={() => nav.push('connect')}>
              <Icon icon="solar:link-circle-bold" size={20} /> Connect to AO3</button>} />
        </div>
      </div>
    );
  }

  const archiveAction = { icon: 'solar:history-linear', onClick: () => nav.push('archive') };

  return (
    <div className="screen">
      <Appbar large title="Library" actions={[syncAction, archiveAction]} />
      {toast}
      <div className="scroll">
        {layout === 'shelves' ? <Shelves works={works} open={open} />
          : layout === 'fandom' ? <FandomSections works={works} open={open} />
          : layout === 'list' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13, padding: '0 20px 24px' }}>
              <div className="section-label" style={{ marginBottom: -2 }}>All works · {works.length}</div>
              {works.map(w => <LibraryCard key={w.id} work={w} onOpen={open} />)}
            </div>
          ) : (
            <div style={{ padding: '0 20px 24px' }}>
              <div className="section-label" style={{ marginBottom: 12 }}>All works · {works.length}</div>
              <div className="libgrid">{works.map(w => <GridCard key={w.id} work={w} onOpen={open} />)}</div>
            </div>
          )}
      </div>
    </div>
  );
}

function FandomSections({ works, open }) {
  // Group works under their fandom, preserving the works' existing sort order.
  const groups = [];
  const byName = new Map();
  for (const w of works) {
    const name = fandomName(w);
    let g = byName.get(name);
    if (!g) { g = { name, items: [] }; byName.set(name, g); groups.push(g); }
    g.items.push(w);
  }
  groups.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));

  const [collapsed, setCollapsed] = useState({});
  const toggle = (name) => setCollapsed(c => ({ ...c, [name]: !c[name] }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 20px 24px' }}>
      {groups.map(g => {
        const isOpen = !collapsed[g.name];
        return (
          <div key={g.name}>
            <button className="fandom-head pressable" onClick={() => toggle(g.name)} aria-expanded={isOpen}>
              <Icon icon="solar:alt-arrow-down-linear" size={18}
                style={{ transition: 'transform .18s', transform: isOpen ? 'none' : 'rotate(-90deg)' }} />
              <span className="fandom-name">{g.name}</span>
              <span className="fandom-count">{g.items.length}</span>
            </button>
            {isOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13, paddingTop: 11 }}>
                {g.items.map(w => <LibraryCard key={w.id} work={w} onOpen={open} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Shelves({ works, open }) {
  const shelves = [
    { label: 'Reading', items: works.filter(w => w.progress > 0 && w.progress < 1) },
    { label: 'Up next', items: works.filter(w => w.progress === 0) },
    { label: 'Finished', items: works.filter(w => w.progress >= 1 && !w.frozen) },
    { label: 'Saved copies', items: works.filter(w => w.frozen) },
  ].filter(s => s.items.length);
  return (
    <div style={{ padding: '0 0 24px', display: 'flex', flexDirection: 'column', gap: 22 }}>
      {shelves.map(s => (
        <div key={s.label}>
          <div className="section-label" style={{ padding: '0 20px 10px' }}>{s.label} · {s.items.length}</div>
          <div className="crow">{s.items.map(w => <div key={w.id} style={{ width: 130, flex: 'none', scrollSnapAlign: 'start' }}><GridCard work={w} onOpen={open} /></div>)}</div>
        </div>
      ))}
    </div>
  );
}
