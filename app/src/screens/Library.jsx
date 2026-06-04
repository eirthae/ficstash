import { useState, useEffect } from 'react';
import { Appbar } from '../components/chrome.jsx';
import { EmptyState, useToast, Sheet } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { LibraryCard } from '../components/cards.jsx';
import { triggerSync } from '../lib/sync.js';
import { fetchPendingLinks, removeRequest } from '../lib/links.js';
import { removeWork } from '../lib/library.js';
import { getLastRead } from '../lib/reading.js';

// The fandom name without the author suffix ("Heated Rivalry – Rachel Reid" → "Heated Rivalry").
function fandomName(work) {
  return (work.fandom || 'Other').split('–')[0].split(' - ')[0].trim() || 'Other';
}

// Which shelf a work belongs to. Routing is automatic by how it entered the
// library: uploaded EPUBs are Books; AO3 works (bookmarks, tag saves, AO3 links)
// are Fics; everything else added from another site is a Story.
function shelfOf(work) {
  if ((work.origin || '') === 'upload') return 'books';
  if (work.source === 'ao3') return 'fics';
  return 'stories';
}

const SHELVES = [
  { id: 'fics', label: 'Fics' },
  { id: 'stories', label: 'Stories' },
  { id: 'books', label: 'Books' },
];

// Sort options, shown as icons. 'default' keeps the incoming order (source
// activity desc); 'updated' = clock; 'added' (newest) = leaf; 'read' = book
// (most recently opened in the reader); 'title' = A–Z (Books only).
const SORT_OPTS = {
  default: { icon: 'solar:sort-vertical-linear', label: 'Default order' },
  updated: { icon: 'solar:clock-circle-linear', label: 'Last updated' },
  added: { icon: 'solar:leaf-linear', label: 'Last added' },
  read: { icon: 'solar:book-linear', label: 'Last read' },
  title: { icon: 'solar:sort-from-top-to-bottom-linear', label: 'A–Z' },
};

// Sort a list without mutating it. Timestamps are ISO strings (sortable as text).
function sortWorks(list, sort, lastRead = {}) {
  const arr = [...list];
  if (sort === 'added') arr.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  else if (sort === 'updated') arr.sort((a, b) => (b.sourceUpdated || '').localeCompare(a.sourceUpdated || ''));
  else if (sort === 'title') arr.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  else if (sort === 'read') arr.sort((a, b) => (lastRead[b.id] || '').localeCompare(lastRead[a.id] || ''));
  return arr;
}

export function LibraryScreen({ works, layout = 'fandom', connected = true, onRemove, onReload, refreshKey, nav }) {
  const open = (w) => nav.push('detail', { work: w, onRemoved: onRemove, onReload });
  const [toast, showToast] = useToast();
  const [syncing, setSyncing] = useState(false);
  const [shelf, setShelf] = useState('fics');
  const [status, setStatus] = useState('all');     // all | ongoing | complete (fics/stories)
  const [sort, setSort] = useState('default');      // default | added | updated | title
  const [pendingLinks, setPendingLinks] = useState([]);
  const [collapsed, setCollapsed] = useState({});   // fandom name -> collapsed?
  const [pendingDelete, setPendingDelete] = useState(null);
  const toggleSection = (name) => setCollapsed(c => ({ ...c, [name]: !c[name] }));

  const reloadLinks = () => fetchPendingLinks().then(setPendingLinks).catch(() => {});
  useEffect(() => { reloadLinks(); }, [refreshKey]);

  const removeLink = async (id) => {
    setPendingLinks(list => list.filter(r => r.id !== id));
    const res = await removeRequest(id);
    if (res.ok) showToast('Removed.');
    else { showToast(res.error || 'Could not remove.', 'solar:danger-triangle-bold'); reloadLinks(); }
  };

  const doSync = async () => {
    if (syncing) return;
    setSyncing(true);
    showToast('Starting sync…');
    const res = await triggerSync();
    setSyncing(false);
    showToast(res.ok ? 'Sync started — new works arrive shortly.' : (res.error || 'Sync failed.'));
  };
  const syncAction = { icon: syncing ? 'solar:refresh-circle-bold' : 'solar:refresh-circle-linear', onClick: doSync };

  // "Remove from library" with a confirm step (no more accidental swipe deletes).
  const confirmDelete = async () => {
    const w = pendingDelete;
    setPendingDelete(null);
    if (!w) return;
    onRemove?.(w.id); // optimistic
    try { await removeWork(w.id); showToast('Removed from library'); }
    catch { showToast('Could not remove — try again', 'solar:danger-triangle-bold'); onReload?.(); }
  };

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

  const ready = works;
  const isBooks = shelf === 'books';

  // Counts per shelf (for the tab labels) and the works for the active shelf.
  const counts = { fics: 0, stories: 0, books: 0 };
  for (const w of ready) counts[shelfOf(w)]++;
  const shelfWorks = ready.filter(w => shelfOf(w) === shelf);

  // Status filter (fics/stories only).
  const ongoingCount = shelfWorks.filter(w => w.status !== 'complete').length;
  const completeCount = shelfWorks.length - ongoingCount;
  const statusFiltered = isBooks ? shelfWorks
    : status === 'complete' ? shelfWorks.filter(w => w.status === 'complete')
    : status === 'ongoing' ? shelfWorks.filter(w => w.status !== 'complete')
    : shelfWorks;
  const lastRead = getLastRead(); // re-read each render so it stays fresh after reading
  const shown = sortWorks(statusFiltered, sort, lastRead);

  // Pending (still-downloading) link requests belong to the Stories shelf.
  const pending = shelf === 'stories' ? pendingLinks : [];

  // Books group into named series (manual/auto) when set; otherwise flat.
  const useSeries = isBooks && shown.some(w => w.seriesName);
  // Fandom sections only for Fics in Default sort; otherwise a flat sorted list.
  const useFandom = shelf === 'fics' && sort === 'default';
  const fandomNames = useFandom ? [...new Set(shown.map(fandomName))] : [];
  const anyExpanded = fandomNames.some(n => !collapsed[n]);
  const showCollapseToggle = useFandom && fandomNames.length > 1 && shown.length > 0;
  const toggleAll = () => {
    if (anyExpanded) { const all = {}; fandomNames.forEach(n => { all[n] = true; }); setCollapsed(all); }
    else setCollapsed({});
  };

  const SORTS = isBooks
    ? ['added', 'title', 'read']
    : ['default', 'updated', 'added', 'read'];
  // Keep sort valid when switching shelves (books has no 'default'/'updated').
  const activeSort = SORTS.includes(sort) ? sort : SORTS[0];

  const switchShelf = (id) => {
    setShelf(id);
    setStatus('all');
    setSort(id === 'books' ? 'added' : 'default');
  };

  const emptyCopy = {
    fics: { icon: 'solar:notebook-linear', title: 'No fics yet', desc: 'AO3 works land here — track a tag in Discover, or tap + to add one by link.' },
    stories: { icon: 'solar:book-linear', title: 'No stories yet', desc: 'Royal Road, Scribble Hub and other sites land here — tap + to add one by link.' },
    books: { icon: 'solar:book-2-linear', title: 'No books yet', desc: 'Tap + to upload an EPUB of a book you own.' },
  }[shelf];

  return (
    <div className="screen">
      <Appbar large title="Library" actions={[syncAction]} />
      {toast}
      <div className="scroll">
        <div className="seg src-seg" style={{ margin: '0 20px 14px' }}>
          {SHELVES.map(s => (
            <button key={s.id} className={shelf === s.id ? 'on' : ''} onClick={() => switchShelf(s.id)}>
              {s.label} · {counts[s.id]}
            </button>
          ))}
        </div>

        {(shelfWorks.length > 0 || pending.length > 0) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 20px 16px' }}>
            {!isBooks && (
              <div className="filterpick" style={{ flex: 1 }}>
                <select value={status} onChange={e => setStatus(e.target.value)} aria-label="Filter by status">
                  <option value="all">All · {shelfWorks.length}</option>
                  <option value="ongoing">Ongoing · {ongoingCount}</option>
                  <option value="complete">Complete · {completeCount}</option>
                </select>
                <Icon icon="solar:alt-arrow-down-linear" size={16} color="var(--text-tertiary)" />
              </div>
            )}
            <div className="sortbar">
              {SORTS.map(v => (
                <button key={v} className={`sortbtn ${activeSort === v ? 'on' : ''}`}
                  onClick={() => setSort(v)} aria-label={SORT_OPTS[v].label} title={SORT_OPTS[v].label}
                  aria-pressed={activeSort === v}>
                  <Icon icon={SORT_OPTS[v].icon} size={19} />
                </button>
              ))}
            </div>
            {showCollapseToggle && (
              <button className="iconbtn ghost" onClick={toggleAll} aria-label={anyExpanded ? 'Collapse all' : 'Expand all'}
                title={anyExpanded ? 'Collapse all' : 'Expand all'}
                style={{ flex: 'none', width: 40, height: 42, background: 'var(--surface-2)', borderRadius: 'var(--radius-md)' }}>
                <Icon icon={anyExpanded ? 'solar:alt-arrow-up-linear' : 'solar:alt-arrow-down-linear'} size={20} />
              </button>
            )}
          </div>
        )}

        {pending.map(r => (
          <div key={r.id} style={{ padding: '0 20px' }}><LinkRequestRow req={r} onRemove={() => removeLink(r.id)} /></div>
        ))}

        {shelfWorks.length === 0 && pending.length === 0 ? (
          <div style={{ padding: '0 20px' }}>
            <EmptyState icon={emptyCopy.icon} title={emptyCopy.title} desc={emptyCopy.desc} />
          </div>
        ) : shown.length === 0 ? (
          <div style={{ padding: '0 20px' }}>
            <EmptyState icon="solar:inbox-line-linear" title="Nothing under this filter"
              desc="Try a different status filter." />
          </div>
        ) : useSeries ? (
          <SeriesSections works={shown} open={open} onDelete={setPendingDelete} collapsed={collapsed} toggle={toggleSection} />
        ) : useFandom ? (
          <FandomSections works={shown} open={open} onDelete={setPendingDelete} collapsed={collapsed} toggle={toggleSection} />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13, padding: '0 20px 24px' }}>
            {shown.map(w => <LibraryCard key={w.id} work={w} onOpen={open} onDelete={() => setPendingDelete(w)} />)}
          </div>
        )}
      </div>

      <Sheet open={!!pendingDelete} onClose={() => setPendingDelete(null)} title="Remove from library?">
        <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-secondary)', marginBottom: 16 }}>
          “{pendingDelete?.title}” will be hidden from your library.{pendingDelete?.origin === 'upload'
            ? ' The uploaded copy stays on your device.'
            : ' Your copy at the source is untouched.'}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button className="btn btn-lg btn-surface" style={{ flex: 1 }} onClick={() => setPendingDelete(null)}>Cancel</button>
          <button className="btn btn-lg" style={{ flex: 1, background: 'var(--danger)', color: '#fff' }} onClick={confirmDelete}>
            <Icon icon="solar:trash-bin-trash-bold" size={18} /> Remove</button>
        </div>
      </Sheet>
    </div>
  );
}

function prettyUrl(url) {
  return (url || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}

function LinkRequestRow({ req, onRemove }) {
  const failed = req.status === 'error';
  const label = req.status === 'fetching' ? 'Downloading…' : failed ? 'Couldn’t download' : 'Queued for download';
  const icon = failed ? 'solar:danger-triangle-bold' : req.status === 'fetching' ? 'solar:download-minimalistic-linear' : 'solar:clock-circle-linear';
  const color = failed ? 'var(--danger, #f5455c)' : 'var(--text-tertiary)';
  return (
    <div className="libcard" style={{ marginBottom: 13, position: 'relative' }}>
      <div className="meta">
        <div className="story-title" style={{ marginBottom: 2, paddingRight: 38 }}>{req.title || prettyUrl(req.url)}</div>
        <div className="story-sub" style={{ marginBottom: 7, wordBreak: 'break-all' }}>{prettyUrl(req.url)}</div>
        <div className="metarow" style={{ color }}><Icon icon={icon} size={14} /><span>{label}</span></div>
        {failed && req.error && <div className="summary" style={{ marginTop: 6 }}>{req.error}</div>}
      </div>
      {onRemove && (
        <button className="iconbtn ghost" onClick={onRemove} aria-label="Remove" title="Remove"
          style={{ position: 'absolute', top: 10, right: 10, width: 32, height: 32, background: 'var(--surface-2)', borderRadius: 'var(--radius-md)' }}>
          <Icon icon="solar:trash-bin-trash-linear" size={18} />
        </button>
      )}
    </div>
  );
}

// Books grouped into their series (ordered by series_index), with everything
// ungrouped collected under "Standalone" at the end.
function SeriesSections({ works, open, onDelete, collapsed, toggle }) {
  const groups = [];
  const byName = new Map();
  const standalone = { name: 'Standalone', items: [], standalone: true };
  for (const w of works) {
    if (!w.seriesName) { standalone.items.push(w); continue; }
    let g = byName.get(w.seriesName);
    if (!g) { g = { name: w.seriesName, items: [] }; byName.set(w.seriesName, g); groups.push(g); }
    g.items.push(w);
  }
  for (const g of groups) {
    g.items.sort((a, b) => (a.seriesIndex ?? 1e9) - (b.seriesIndex ?? 1e9) || (a.title || '').localeCompare(b.title || ''));
  }
  groups.sort((a, b) => a.name.localeCompare(b.name));
  if (standalone.items.length) groups.push(standalone);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: '0 20px 24px' }}>
      {groups.map(g => {
        const isOpen = !collapsed[g.name];
        return (
          <div key={g.name}>
            <button className="fandom-head pressable" onClick={() => toggle(g.name)} aria-expanded={isOpen}>
              <Icon icon="solar:alt-arrow-down-linear" size={18}
                style={{ transition: 'transform .18s', transform: isOpen ? 'none' : 'rotate(-90deg)' }} />
              <span className="fandom-name">{g.standalone ? g.name : `📚 ${g.name}`}</span>
              <span className="fandom-count">{g.items.length}</span>
            </button>
            {isOpen && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 13, paddingTop: 11 }}>
                {g.items.map(w => <LibraryCard key={w.id} work={w} onOpen={open} onDelete={() => onDelete(w)} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FandomSections({ works, open, onDelete, collapsed, toggle }) {
  const groups = [];
  const byName = new Map();
  for (const w of works) {
    const name = fandomName(w);
    let g = byName.get(name);
    if (!g) { g = { name, items: [] }; byName.set(name, g); groups.push(g); }
    g.items.push(w);
  }
  groups.sort((a, b) => b.items.length - a.items.length || a.name.localeCompare(b.name));

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
                {g.items.map(w => <LibraryCard key={w.id} work={w} onOpen={open} onDelete={() => onDelete(w)} />)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
