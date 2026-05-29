import { Appbar } from '../components/chrome.jsx';
import { EmptyState } from '../components/ui.jsx';
import Icon from '../components/Icon.jsx';
import { LibraryCard, GridCard, ContinueCard } from '../components/cards.jsx';

export function LibraryScreen({ works, layout = 'grid', connected = true, nav }) {
  const open = (w) => nav.push('detail', { work: w });

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

  const reading = works.filter(w => w.progress > 0 && w.progress < 1);
  const continueList = reading.length ? reading : works.filter(w => w.progress === 0 && !w.unread);

  if (!connected || works.length === 0) {
    return (
      <div className="screen">
        <Appbar large title="Library" />
        <div className="scroll" style={{ display: 'flex' }}>
          <EmptyState icon="solar:books-minimalistic-linear" title="Nothing here yet"
            desc="Connect your AO3 account and your bookmarks will download into your private shelf."
            action={<button className="btn btn-lg btn-primary" onClick={() => nav.push('connect')}>
              <Icon icon="solar:link-circle-bold" size={20} /> Connect to AO3</button>} />
        </div>
      </div>
    );
  }

  return (
    <div className="screen">
      <Appbar large title="Library" />
      <div className="scroll">
        {continueList.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div className="section-label" style={{ padding: '0 20px 9px' }}>Continue reading</div>
            <div className="crow">
              {continueList.map(w => <ContinueCard key={w.id} work={w} onOpen={open} />)}
            </div>
          </div>
        )}

        {layout === 'shelves' ? <Shelves works={works} open={open} />
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
