import { useState } from 'react';
import { Appbar } from '../components/chrome.jsx';
import Icon from '../components/Icon.jsx';
import { Cover, StatusBadge, fmtWords, useToast } from '../components/ui.jsx';

// shared row: a new chapter on a followed work
function ChapterUpdateRow({ u, nav }) {
  return (
    <div className="update pressable" onClick={() => nav.push('reader', { workId: u.workId, chapterTitle: u.chapter })}>
      {u.fresh && <span className="unew"></span>}
      <Cover title={u.title} author={u.author} fandom={u.fandom} palette={u.palette} w={50} h={70} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="chip" style={{ background: 'var(--accent-soft)', color: 'var(--accent)', height: 20 }}>
            <Icon icon="solar:bookmark-bold" size={12} /> New chapter</span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{u.time}</span>
        </div>
        <div className="story-title" style={{ fontSize: 14.5 }}>{u.chapter}</div>
        <div className="story-sub" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.title} · {fmtWords(u.words)}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2, fontSize: 11.5, color: 'var(--success)', fontWeight: 600 }}>
          <Icon icon="solar:check-circle-bold" size={13} /> Downloaded · ready to read
        </div>
      </div>
    </div>
  );
}

// shared row: a new work matching a tracked tag (metadata-first)
function MatchUpdateRow({ u, onFetch, fetched }) {
  return (
    <div className="update">
      <Cover title={u.title} author={u.author} fandom={u.fandom} palette={u.palette} w={50} h={70} />
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="chip" style={{ background: 'color-mix(in srgb, var(--tag-relationship) 16%, transparent)', color: 'var(--tag-relationship)', height: 20 }}>
            <span className="swatch" style={{ background: 'var(--tag-relationship)' }}></span>{u.tag.length > 22 ? u.tag.slice(0, 21) + '…' : u.tag}</span>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 'auto' }}>{u.time}</span>
        </div>
        <div className="story-title" style={{ fontSize: 14.5 }}>{u.title}</div>
        <div className="summary" style={{ WebkitLineClamp: 2 }}>{u.summary}</div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
          <div className="metarow"><StatusBadge status={u.status} /><span>·</span><span>{fmtWords(u.words)}</span></div>
          <button className={`btn btn-sm ${fetched ? 'btn-flat' : 'btn-primary'}`} onClick={() => onFetch(u.id)} style={{ minWidth: 84 }}>
            {fetched ? <><Icon icon="solar:check-read-linear" size={15} /> Saved</> : <><Icon icon="solar:add-circle-linear" size={15} /> Save</>}
          </button>
        </div>
      </div>
    </div>
  );
}

export function WhatsNewScreen({ chapters, matches, nav }) {
  const [tab, setTab] = useState('chapters');
  const [fetched, setFetched] = useState({});
  const [toast, showToast] = useToast();
  const doFetch = (id) => { setFetched(f => ({ ...f, [id]: true })); showToast('Saved to library', 'solar:check-circle-bold'); };

  const days = (arr) => {
    const order = ['Today', 'Yesterday', 'This week'];
    const groups = {}; arr.forEach(u => { (groups[u.day] = groups[u.day] || []).push(u); });
    return order.filter(d => groups[d]).map(d => ({ day: d, items: groups[d] }));
  };

  const active = tab === 'chapters' ? chapters : matches;
  return (
    <div className="screen">
      <Appbar large title="What's New" sub={`${chapters.length + matches.length} updates`} />
      <div className="wn-seg" style={{ marginBottom: 16 }}>
        <button className={tab === 'chapters' ? 'on' : ''} onClick={() => setTab('chapters')}>
          New chapters <span className="pill">{chapters.length}</span>
        </button>
        <button className={tab === 'matches' ? 'on' : ''} onClick={() => setTab('matches')}>
          New matches <span className="pill">{matches.length}</span>
        </button>
      </div>
      <div className="scroll fade-enter" key={tab} style={{ padding: '0 20px 24px' }}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon icon={tab === 'chapters' ? 'solar:download-minimalistic-linear' : 'solar:magnifer-linear'} size={14} />
          {tab === 'chapters' ? 'On works you follow — downloaded automatically.' : 'Matching tags you track — tap Save to download.'}
        </div>
        {days(active).map(g => (
          <div key={g.day} style={{ marginBottom: 18 }}>
            <div className="daygroup" style={{ marginBottom: 10 }}>{g.day}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 11 }}>
              {g.items.map(u => tab === 'chapters'
                ? <ChapterUpdateRow key={u.id} u={u} nav={nav} />
                : <MatchUpdateRow key={u.id} u={u} onFetch={doFetch} fetched={fetched[u.id]} />)}
            </div>
          </div>
        ))}
        {toast}
      </div>
    </div>
  );
}
