import { useState, useEffect } from 'react';
import { Appbar } from '../components/chrome.jsx';
import Icon from '../components/Icon.jsx';
import { useToast } from '../components/ui.jsx';
import { LibraryCard } from '../components/cards.jsx';
import { fetchSeriesWorks } from '../lib/library.js';
import { getSeriesFollow, requestSeriesDownload, setSeriesFollow, deleteSeries } from '../lib/series.js';

// A single AO3 series: every downloaded work in reading order (AO3's own order,
// oldest first), plus download-all / follow / delete-series actions. Reached by
// tapping a series name in the library, a work's detail page, or the reader.
export function SeriesScreen({ seriesId, seriesName, nav, onReload }) {
  const [works, setWorks] = useState(null); // null = loading
  const [follow, setFollow] = useState(null); // followed_series row or null
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false); // a download-all is in flight (works arrive next sync)
  const [confirmDel, setConfirmDel] = useState(false);
  const [toast, showToast] = useToast();

  useEffect(() => {
    let alive = true;
    fetchSeriesWorks(seriesId).then((r) => { if (alive) setWorks(r || []); }).catch(() => { if (alive) setWorks([]); });
    getSeriesFollow(seriesId).then((r) => { if (alive) setFollow(r); }).catch(() => {});
    return () => { alive = false; };
  }, [seriesId]);

  const open = (w) => nav.push('detail', { work: w, onReload });
  const name = seriesName || (works && works[0] && works[0].ao3SeriesName) || 'AO3 series';
  const got = works ? works.length : 0;
  const total = follow && follow.total ? follow.total : null; // worker records the series' total work count
  const following = !!(follow && follow.follow);

  const downloadAll = async () => {
    if (busy) return; setBusy(true);
    const res = await requestSeriesDownload(seriesId, name);
    setBusy(false);
    if (res.ok) { setFollow({ ...(follow || {}), seriesId, seriesName: name, follow: true }); setQueued(true); showToast('Downloading the whole series — works arrive each sync', 'solar:check-circle-bold'); }
    else showToast(res.error || 'Couldn’t queue the series', 'solar:danger-triangle-linear');
  };
  const toggleFollow = async () => {
    if (busy) return; setBusy(true);
    const next = !following;
    const res = await setSeriesFollow(seriesId, name, next);
    setBusy(false);
    if (res.ok) { setFollow(next ? { ...(follow || {}), seriesId, seriesName: name, follow: true } : null); showToast(next ? 'Following series — new works download automatically' : 'Unfollowed series', next ? 'solar:bell-bold' : 'solar:bell-off-linear'); }
    else showToast(res.error || 'Couldn’t update', 'solar:danger-triangle-linear');
  };
  const removeSeries = async () => {
    if (busy) return; setBusy(true);
    const res = await deleteSeries(seriesId);
    setBusy(false);
    if (res.ok) { onReload && onReload(); nav.pop(); }
    else { setConfirmDel(false); showToast(res.error || 'Couldn’t delete the series', 'solar:danger-triangle-linear'); }
  };

  const sub = total ? `${got} of ${total} works downloaded` : `${got} work${got === 1 ? '' : 's'} downloaded`;

  return (
    <div className="screen">
      <Appbar large title={name} sub={sub} back={() => nav.pop()}
        actions={[{ icon: 'solar:trash-bin-trash-linear', onClick: () => setConfirmDel(true) }]} />
      {toast}
      <div className="scroll" style={{ padding: '0 20px 24px' }}>
        {confirmDel && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', marginBottom: 16, borderRadius: 'var(--radius-md)', background: 'var(--surface-2)', border: '1px solid var(--border)' }}>
            <span style={{ flex: 1, fontSize: 13.5 }}>Delete this whole series from your library?</span>
            <button className="btn" style={{ padding: '8px 12px', fontSize: 13, color: 'var(--text-secondary)' }} onClick={() => setConfirmDel(false)}>Cancel</button>
            <button className="btn" style={{ padding: '8px 12px', fontSize: 13, background: 'var(--danger, #e5484d)', color: '#fff' }} onClick={removeSeries}>Delete</button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 4, marginBottom: 16, marginLeft: -10 }}>
          <button className={`btn btn-text ${queued ? 'is-done' : ''}`} style={{ flex: 'none', fontSize: 14.5 }} disabled={busy || queued} onClick={downloadAll}>
            <Icon icon={queued ? 'solar:check-circle-bold' : busy ? 'solar:refresh-linear' : 'solar:download-minimalistic-bold'} size={19} /> {queued ? 'Downloading' : busy ? 'Queueing…' : 'Download all'}
          </button>
          <button className={`btn btn-text ${following ? 'is-done' : ''}`} style={{ flex: 'none', fontSize: 14.5 }} disabled={busy} onClick={toggleFollow}>
            <Icon icon={following ? 'solar:bell-bing-bold' : 'solar:bell-linear'} size={19} /> {following ? 'Following' : 'Follow'}
          </button>
        </div>

        {queued && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', marginBottom: 16, borderRadius: 'var(--radius-md)', background: 'var(--accent-soft)', color: 'var(--accent)', fontSize: 12.5, fontWeight: 600 }}>
            <Icon icon="solar:clock-circle-linear" size={15} /> Queued — works download on the next sync{total ? ` (${got} of ${total} so far)` : ''}.
          </div>
        )}

        {works === null ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '8px 2px' }}>Loading…</div>
        ) : works.length === 0 ? (
          <div style={{ padding: '24px 8px', textAlign: 'center', fontSize: 13, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
            No works from this series are downloaded yet. Tap “Download all” to fetch them.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 13 }}>
            {works.map((w) => (
              <LibraryCard key={w.id} work={w} onOpen={open} onDelete={null} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
