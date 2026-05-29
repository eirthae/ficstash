import { Fragment, useState } from 'react';
import Icon from '../components/Icon.jsx';
import { Cover, StatusBadge, FrozenBadge, TagChip, fmtWords, useToast } from '../components/ui.jsx';
import { ChapterRow } from '../components/cards.jsx';
import { COVER_PALETTES, CHAPTERS } from '../data/sample.js';

export function StoryDetailScreen({ work, suggestion, nav }) {
  const pal = COVER_PALETTES[work.palette] || COVER_PALETTES[0];
  const total = work.chaptersTotal || work.chapters || 1;
  const base = CHAPTERS.slice(0, total);
  const [chState, setChState] = useState(() => {
    const m = {}; base.forEach(c => { m[c.n] = suggestion ? 'idle' : c.state; }); return m;
  });
  const [saved, setSaved] = useState(!suggestion);
  const [toast, showToast] = useToast();

  const fetchCh = (ch) => {
    if (chState[ch.n] === 'done' || chState[ch.n] === 'busy') return;
    setChState(s => ({ ...s, [ch.n]: 'busy' }));
    setTimeout(() => setChState(s => ({ ...s, [ch.n]: 'done' })), 1100);
  };
  const downloadedCount = Object.values(chState).filter(s => s === 'done').length;

  const saveWork = () => {
    setSaved(true); showToast('Added to library — downloading…');
    base.forEach((c, i) => setTimeout(() => setChState(s => ({ ...s, [c.n]: 'done' })), 400 + i * 120));
  };

  const openReader = (ch) => nav.push('reader', { workId: work.id, chapterTitle: ch ? ch.title : null, chapterN: ch ? ch.n : (work.lastChapter || 1) });

  return (
    <div className="screen view-enter">
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 260, background: `linear-gradient(170deg, ${pal[0]}, ${pal[1]})`, opacity: .9 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,.18), var(--surface) 96%)' }}></div>
      </div>
      <div className="appbar" style={{ background: 'transparent', position: 'relative', zIndex: 3 }}>
        <button className="iconbtn" style={{ background: 'rgba(0,0,0,.28)', backdropFilter: 'blur(4px)', color: '#fff' }} onClick={() => nav.pop()}>
          <Icon icon="solar:arrow-left-linear" size={22} /></button>
        <div style={{ flex: 1 }}></div>
        <button className="iconbtn" style={{ background: 'rgba(0,0,0,.28)', backdropFilter: 'blur(4px)', color: '#fff' }} onClick={() => showToast('Opening AO3 in browser…', 'solar:square-top-down-linear')}>
          <Icon icon="solar:menu-dots-bold" size={22} /></button>
      </div>

      <div className="scroll" style={{ position: 'relative', zIndex: 2 }}>
        <div style={{ padding: '6px 20px 0', display: 'flex', gap: 16, alignItems: 'flex-end' }}>
          <Cover title={work.title} author={work.author} fandom={work.fandom} palette={work.palette} w={108} h={150}
            style={{ boxShadow: '0 12px 30px -8px rgba(0,0,0,.6)' }} />
          <div style={{ flex: 1, minWidth: 0, paddingBottom: 4 }}>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: '#fff', opacity: .9, marginBottom: 6 }}>{work.fandom.split('–')[0].trim()}</div>
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 600, lineHeight: 1.12, color: '#fff', marginBottom: 6 }}>{work.title}</div>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,.85)', fontWeight: 500 }}>by {work.author}</div>
          </div>
        </div>

        <div style={{ padding: '18px 20px 24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
            {work.frozen ? <FrozenBadge date={work.frozenDate} full /> : <StatusBadge status={work.status} updated={work.updated} />}
            <span className="metarow"><Icon icon="solar:document-text-linear" size={14} /> {fmtWords(work.words)}</span>
            <span className="metarow"><Icon icon="solar:list-linear" size={14} /> {total} ch</span>
          </div>

          <div style={{ display: 'flex', gap: 10, marginBottom: 16 }}>
            <button className="btn btn-lg btn-primary btn-block" onClick={() => openReader()}>
              <Icon icon="solar:book-2-bold" size={20} />
              {work.progress >= 1 ? 'Read again' : work.progress > 0 ? `Continue · Ch ${work.lastChapter}` : 'Start reading'}
            </button>
            {!saved ? (
              <button className="btn btn-lg btn-flat" onClick={saveWork} style={{ flex: 'none', width: 56, padding: 0 }}>
                <Icon icon="solar:download-minimalistic-bold" size={22} /></button>
            ) : (
              <button className="btn btn-lg btn-surface" onClick={() => showToast('Opening on AO3…', 'solar:square-top-down-linear')} style={{ flex: 'none', width: 56, padding: 0 }} title="Open on AO3">
                <Icon icon="solar:square-top-down-linear" size={22} /></button>
            )}
          </div>

          {work.frozen && (
            <div style={{ display: 'flex', gap: 10, padding: 13, borderRadius: 'var(--radius-md)', background: 'var(--info-soft)', marginBottom: 18 }}>
              <Icon icon="solar:shield-check-bold" size={20} color="var(--info)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                <b style={{ color: 'var(--text-primary)' }}>This work is no longer on AO3.</b> Your downloaded copy is safe and fully readable — saved {work.frozenDate}.
              </div>
            </div>
          )}

          <div className="section-label" style={{ marginBottom: 8 }}>Summary</div>
          <p style={{ fontSize: 14, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 16px' }}>{work.summary}</p>

          <div className="chiprow" style={{ marginBottom: 22 }}>
            <TagChip t={work.fandom.split('–')[0].trim()} k="fandom" />
            {work.tags.map((t, i) => <TagChip key={i} t={t.t} k={t.k} />)}
          </div>

          <button className="set-group pressable" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, width: '100%', textAlign: 'left', marginBottom: 22 }}
            onClick={() => showToast('Opening on AO3…', 'solar:square-top-down-linear')}>
            <div className="set-ic"><Icon icon="solar:square-top-down-linear" size={18} /></div>
            <div style={{ flex: 1 }}>
              <div className="set-h">Open on AO3</div>
              <div className="set-d">Follow or bookmark on the site — FicStash never touches your account.</div>
            </div>
            <Icon icon="solar:arrow-right-up-linear" size={18} color="var(--text-tertiary)" />
          </button>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div className="section-label">Chapters</div>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{downloadedCount}/{total} downloaded</span>
          </div>
          <div>
            {base.map(ch => (
              <Fragment key={ch.n}>
                <ChapterRow ch={ch} current={!work.frozen && ch.n === work.lastChapter} fetchState={chState[ch.n]}
                  onOpen={() => openReader(ch)} onFetch={fetchCh} />
                <div className="divider"></div>
              </Fragment>
            ))}
          </div>
        </div>
        {toast}
      </div>
    </div>
  );
}
