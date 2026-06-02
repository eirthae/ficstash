import { useState, useEffect } from 'react';
import { Appbar } from '../components/chrome.jsx';
import { EmptyState, useToast, Sheet } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { LibraryCard, GridCard } from '../components/cards.jsx';
import { triggerSync } from '../lib/sync.js';
import { requestUrl, fetchPendingLinks } from '../lib/links.js';

// The fandom name without the author suffix ("Heated Rivalry – Rachel Reid" → "Heated Rivalry").
function fandomName(work) {
  return (work.fandom || 'Other').split('–')[0].split(' - ')[0].trim() || 'Other';
}

export function LibraryScreen({ works, layout = 'grid', connected = true, nav }) {
  const open = (w) => nav.push('detail', { work: w });
  const [toast, showToast] = useToast();
  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState('all');
  const [source, setSource] = useState('ao3'); // 'ao3' | 'other' (works added by link)
  const [showAdd, setShowAdd] = useState(false);
  const [pendingLinks, setPendingLinks] = useState([]);

  const reloadLinks = () => fetchPendingLinks().then(setPendingLinks).catch(() => {});
  useEffect(() => { reloadLinks(); }, []);

  const doSync = async () => {
    if (syncing) return;
    setSyncing(true);
    showToast('Starting sync…');
    const res = await triggerSync();
    setSyncing(false);
    showToast(res.ok ? 'Sync started — new works arrive shortly.' : (res.error || 'Sync failed.'));
  };
  const syncAction = { icon: syncing ? 'solar:refresh-circle-bold' : 'solar:refresh-circle-linear', onClick: doSync };
  const addAction = { icon: 'solar:add-circle-linear', onClick: () => setShowAdd(true) };
  const addSheet = (
    <AddLinkSheet open={showAdd} onClose={() => setShowAdd(false)} showToast={showToast}
      onAdded={() => { setShowAdd(false); reloadLinks(); }} />
  );

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

  // Show every work, including those still downloading. The cards mark
  // not-yet-downloaded works as "Queued" / "Downloads on next sync", and Detail
  // won't open them for reading until their chapters arrive — so a backfill in
  // progress is visible rather than making the library look half-empty.
  const ready = works;

  if (!connected || ready.length === 0) {
    return (
      <div className="screen">
        <Appbar large title="Library" actions={[addAction]} />
        {toast}
        <div className="scroll" style={{ display: 'flex' }}>
          <EmptyState icon="solar:book-minimalistic-linear" title="Nothing here yet"
            desc="Connect your AO3 account and your bookmarks will download into your private shelf."
            action={<button className="btn btn-lg btn-primary" onClick={() => nav.push('connect')}>
              <Icon icon="solar:link-circle-bold" size={20} /> Connect to AO3</button>} />
        </div>
        {addSheet}
      </div>
    );
  }

  // Split the library by origin. "AO3" is everything synced from AO3; "Other"
  // is works added by pasting a link (Royal Road, etc.). The toggle by the title
  // filters the whole page, and the status tabs apply within the chosen source.
  const linkWorks = ready.filter(w => w.source && w.source !== 'ao3');
  const mainWorks = ready.filter(w => !w.source || w.source === 'ao3');
  const sourceWorks = source === 'other' ? linkWorks : mainWorks;

  // Status filter (All / Ongoing / Complete) over the chosen source. Counts come
  // from that source's full set so the labels stay stable as the user switches.
  const ongoingCount = sourceWorks.filter(w => w.status !== 'complete').length;
  const completeCount = sourceWorks.length - ongoingCount;
  const shown = status === 'complete' ? sourceWorks.filter(w => w.status === 'complete')
    : status === 'ongoing' ? sourceWorks.filter(w => w.status !== 'complete')
    : sourceWorks;
  const label = status === 'complete' ? 'Complete' : status === 'ongoing' ? 'Ongoing' : 'All works';
  const isOther = source === 'other';
  const pending = isOther ? pendingLinks : [];

  return (
    <div className="screen">
      <Appbar large title="Library" actions={[addAction, syncAction]} />
      {toast}
      <div className="scroll">
        <div className="seg src-seg" style={{ margin: '0 20px 14px' }}>
          <button className={source === 'ao3' ? 'on' : ''} onClick={() => { setSource('ao3'); setStatus('all'); }}>AO3 · {mainWorks.length}</button>
          <button className={source === 'other' ? 'on' : ''} onClick={() => { setSource('other'); setStatus('all'); }}>Other · {linkWorks.length}</button>
        </div>
        {sourceWorks.length > 0 && (
          <div className="seg" style={{ margin: '0 20px 16px' }}>
            <button className={status === 'all' ? 'on' : ''} onClick={() => setStatus('all')}>All · {sourceWorks.length}</button>
            <button className={status === 'ongoing' ? 'on' : ''} onClick={() => setStatus('ongoing')}>Ongoing · {ongoingCount}</button>
            <button className={status === 'complete' ? 'on' : ''} onClick={() => setStatus('complete')}>Complete · {completeCount}</button>
          </div>
        )}
        {pending.map(r => (
          <div key={r.id} style={{ padding: '0 20px' }}><LinkRequestRow req={r} /></div>
        ))}
        {sourceWorks.length === 0 && pending.length === 0 ? (
          <div style={{ padding: '0 20px' }}>
            <EmptyState icon={isOther ? 'solar:link-broken-linear' : 'solar:inbox-line-linear'}
              title={isOther ? 'No imported works yet' : 'Nothing here yet'}
              desc={isOther ? 'Tap + to paste a story link from Royal Road, Scribble Hub, FanFiction.net and more.'
                : 'Your AO3 bookmarks and subscriptions will appear here after a sync.'}
              action={isOther ? <button className="btn btn-lg btn-primary" onClick={() => setShowAdd(true)}>
                <Icon icon="solar:add-circle-bold" size={20} /> Add a work by link</button> : undefined} />
          </div>
        ) : shown.length === 0 ? (
          <div style={{ padding: '0 20px' }}>
            <EmptyState icon="solar:inbox-line-linear" title={`No ${label.toLowerCase()} works`}
              desc="Nothing here under this filter yet." />
          </div>
        ) : isOther ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13, padding: '0 20px 24px' }}>
            {shown.map(w => <LibraryCard key={w.id} work={w} onOpen={open} />)}
          </div>
        ) : layout === 'shelves' ? <Shelves works={shown} open={open} />
          : layout === 'fandom' ? <FandomSections works={shown} open={open} />
          : layout === 'list' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 13, padding: '0 20px 24px' }}>
              <div className="section-label" style={{ marginBottom: -2 }}>{label} · {shown.length}</div>
              {shown.map(w => <LibraryCard key={w.id} work={w} onOpen={open} />)}
            </div>
          ) : (
            <div style={{ padding: '0 20px 24px' }}>
              <div className="section-label" style={{ marginBottom: 12 }}>{label} · {shown.length}</div>
              <div className="libgrid">{shown.map(w => <GridCard key={w.id} work={w} onOpen={open} />)}</div>
            </div>
          )}
      </div>
      {addSheet}
    </div>
  );
}

function prettyUrl(url) {
  return (url || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');
}

function LinkRequestRow({ req }) {
  const failed = req.status === 'error';
  const label = req.status === 'fetching' ? 'Downloading…' : failed ? 'Couldn’t download' : 'Queued for download';
  const icon = failed ? 'solar:danger-triangle-bold' : req.status === 'fetching' ? 'solar:download-minimalistic-linear' : 'solar:clock-circle-linear';
  const color = failed ? 'var(--danger, #f5455c)' : 'var(--text-tertiary)';
  return (
    <div className="libcard" style={{ marginBottom: 13 }}>
      <div className="meta">
        <div className="story-title" style={{ marginBottom: 2 }}>{req.title || prettyUrl(req.url)}</div>
        <div className="story-sub" style={{ marginBottom: 7, wordBreak: 'break-all' }}>{prettyUrl(req.url)}</div>
        <div className="metarow" style={{ color }}><Icon icon={icon} size={14} /><span>{label}</span></div>
        {failed && req.error && <div className="summary" style={{ marginTop: 6 }}>{req.error}</div>}
      </div>
    </div>
  );
}

function AddLinkSheet({ open, onClose, onAdded, showToast }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (busy || !url.trim()) return;
    setBusy(true);
    const res = await requestUrl(url);
    setBusy(false);
    if (res.ok) {
      setUrl('');
      showToast('Downloading… it’ll appear here shortly.');
      onAdded && onAdded();
    } else {
      showToast(res.error || 'Could not add link.', 'solar:danger-triangle-bold');
    }
  };
  return (
    <Sheet open={open} onClose={onClose} title="Add a work by link">
      <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-secondary)', marginBottom: 14 }}>
        Paste a story link — Royal Road, Scribble Hub, FanFiction.net and many more. FicStash downloads a full offline copy.
      </div>
      <div className="searchfield" style={{ marginBottom: 14 }}>
        <Icon icon="solar:link-linear" size={20} color="var(--text-tertiary)" />
        <input placeholder="https://www.royalroad.com/fiction/…" value={url}
          onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />
      </div>
      <button className="btn btn-lg btn-primary" style={{ width: '100%' }} onClick={submit} disabled={busy || !url.trim()}>
        {busy ? 'Adding…' : <><Icon icon="solar:download-minimalistic-bold" size={18} /> Download work</>}
      </button>
    </Sheet>
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
