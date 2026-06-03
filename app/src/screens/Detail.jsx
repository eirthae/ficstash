import { Fragment, useState, useEffect } from 'react';
import Icon from '../components/Icon.jsx';
import { StatusBadge, FrozenBadge, TagChip, fmtWords, useToast, Sheet } from '../components/ui.jsx';
import { ChapterRow } from '../components/cards.jsx';
import { COVER_PALETTES, CHAPTERS } from '../data/sample.js';
import { fetchChapters, removeWork } from '../lib/library.js';
import { hasSupabase } from '../lib/supabase.js';
import { requestSave } from '../lib/tags.js';
import { kickSync } from '../lib/sync.js';
import { workUrl, sourceLabel } from '../sources/index.js';

export function StoryDetailScreen({ work, suggestion, onSaved, onRemoved, nav }) {
  const pal = COVER_PALETTES[work.palette] || COVER_PALETTES[0];
  const total = work.chaptersTotal || work.chapters || 1;
  const srcLabel = sourceLabel(work.source);

  // Real downloaded chapters for this work. When connected to Supabase we show
  // only real data — an empty list means nothing's been downloaded yet. The
  // sample chapter list is used only in the unconnected demo build.
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (suggestion) { setLive([]); return; }
    let alive = true;
    fetchChapters(work.id)
      .then(r => { if (alive) setLive(r || []); })
      .catch(() => { if (alive) setLive([]); });
    return () => { alive = false; };
  }, [work.id, suggestion]);

  const base = (live && live.length)
    ? live
    : hasSupabase
      ? []
      : CHAPTERS.slice(0, total).map(c => ({ ...c, state: suggestion ? 'idle' : c.state }));
  const [chState, setChState] = useState({});
  // For suggestions, Save is a request to the worker (idle → queued → saved);
  // for library works there's nothing to save, so the button opens AO3 instead.
  const [saveState, setSaveState] = useState(work.saved ? 'saved' : work.wanted ? 'queued' : 'idle');
  const [toast, showToast] = useToast();
  const [showMenu, setShowMenu] = useState(false);
  const [removing, setRemoving] = useState(false);

  const fetchCh = (ch) => {
    if (chState[ch.n] === 'done' || chState[ch.n] === 'busy') return;
    setChState(s => ({ ...s, [ch.n]: 'busy' }));
    setTimeout(() => setChState(s => ({ ...s, [ch.n]: 'done' })), 1100);
  };
  const chStateOf = (c) => chState[c.n] || c.state || 'idle';
  const downloadedCount = base.filter(c => chStateOf(c) === 'done').length;

  const ongoing = work.status !== 'complete';
  // Readable only when a full offline copy exists. Suggestions and metadata-only
  // library works (offline === false) aren't downloaded yet; the sample/demo
  // build leaves offline undefined, so those stay readable.
  const readable = !suggestion && work.offline !== false;

  const queueSave = async () => {
    if (saveState !== 'idle') return;
    setSaveState('queued');
    try {
      await requestSave(work.matchId || work.id);
      kickSync();
      onSaved?.();
      showToast(ongoing
        ? 'Saved — downloading; subscribe on AO3 for new chapters'
        : 'Saved — starting download', 'solar:check-circle-bold');
    } catch {
      setSaveState('idle');
      showToast("Couldn't save — try again", 'solar:danger-triangle-linear');
    }
  };

  const openReader = (ch) => nav.push('reader', { work, workId: work.id, chapterTitle: ch ? ch.title : null, chapterN: ch ? ch.n : (work.lastChapter || 1) });

  const openAtSource = () => {
    const url = workUrl(work.source, work.sourceWorkId, work.sourceUrl);
    if (!url) { showToast('No source link for this work', 'solar:link-broken-linear'); return; }
    window.open(url, '_blank', 'noopener');
  };

  const remove = async () => {
    if (removing) return;
    setRemoving(true);
    try {
      await removeWork(work.id);
      onRemoved?.(work.id);
      setShowMenu(false);
      nav.pop();
    } catch {
      setRemoving(false);
      showToast("Couldn't remove — try again", 'solar:danger-triangle-linear');
    }
  };

  return (
    <div className="screen view-enter">
      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 260, background: `linear-gradient(170deg, ${pal[0]}, ${pal[1]})`, opacity: .9 }}>
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, rgba(0,0,0,.18), var(--surface) 96%)' }}></div>
      </div>
      <div className="appbar" style={{ background: 'transparent', position: 'relative', zIndex: 3 }}>
        <button className="iconbtn" style={{ background: 'rgba(0,0,0,.28)', backdropFilter: 'blur(4px)', color: '#fff' }} onClick={() => nav.pop()}>
          <Icon icon="solar:arrow-left-linear" size={22} /></button>
        <div style={{ flex: 1 }}></div>
        <button className="iconbtn" style={{ background: 'rgba(0,0,0,.28)', backdropFilter: 'blur(4px)', color: '#fff' }}
          onClick={() => (suggestion ? openAtSource() : setShowMenu(true))}>
          <Icon icon="solar:menu-dots-bold" size={22} /></button>
      </div>

      <div className="scroll" style={{ position: 'relative', zIndex: 2 }}>
        <div style={{ padding: '48px 20px 0' }}>
          <div style={{ minWidth: 0, paddingBottom: 4 }}>
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
            {readable ? (
              <button className="btn btn-lg btn-primary btn-block" onClick={() => openReader()}>
                <Icon icon="solar:book-2-bold" size={20} />
                {work.progress >= 1 ? 'Read again' : work.progress > 0 ? `Continue · Ch ${work.lastChapter}` : 'Start reading'}
              </button>
            ) : (
              <button className="btn btn-lg btn-surface btn-block" disabled style={{ opacity: .85 }}>
                <Icon icon="solar:clock-circle-linear" size={20} />
                {suggestion ? 'Not saved yet' : 'Not downloaded yet'}
              </button>
            )}
            {suggestion ? (
              <button
                className={`btn btn-lg ${saveState === 'idle' ? 'btn-flat' : 'btn-surface'}`}
                onClick={queueSave}
                disabled={saveState !== 'idle'}
                style={{ flex: 'none', width: 56, padding: 0 }}
                title={saveState === 'saved' ? 'In your library' : saveState === 'queued' ? 'Downloading — sync started' : 'Save to library'}
              >
                <Icon icon={saveState === 'saved' ? 'solar:check-read-linear' : saveState === 'queued' ? 'solar:clock-circle-linear' : 'solar:download-minimalistic-bold'} size={22} /></button>
            ) : (
              <button className="btn btn-lg btn-surface" onClick={openAtSource} style={{ flex: 'none', width: 56, padding: 0 }} title={`Open on ${srcLabel}`}>
                <Icon icon="solar:square-top-down-linear" size={22} /></button>
            )}
          </div>

          {suggestion && ongoing && (
            <button className="pressable" onClick={openAtSource}
              style={{ display: 'flex', gap: 10, padding: 13, borderRadius: 'var(--radius-md)', background: 'var(--info-soft)', marginBottom: 18, width: '100%', textAlign: 'left', border: 'none' }}>
              <Icon icon="solar:bell-bold" size={20} color="var(--info)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                <b style={{ color: 'var(--text-primary)' }}>This work is still updating.</b> Saving downloads everything posted so far — subscribe on AO3 and each sync will pull in new chapters as they go up.
              </div>
              <Icon icon="solar:arrow-right-up-linear" size={18} color="var(--text-tertiary)" style={{ flexShrink: 0, alignSelf: 'center' }} />
            </button>
          )}

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
            {(work.tags || []).map((t, i) => <TagChip key={i} t={t.t} k={t.k} />)}
          </div>

          <button className="set-group pressable" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, width: '100%', textAlign: 'left', marginBottom: 22 }}
            onClick={openAtSource}>
            <div className="set-ic"><Icon icon="solar:square-top-down-linear" size={18} /></div>
            <div style={{ flex: 1 }}>
              <div className="set-h">Open on {srcLabel}</div>
              <div className="set-d">Follow or bookmark on the site — FicStash never touches your account.</div>
            </div>
            <Icon icon="solar:arrow-right-up-linear" size={18} color="var(--text-tertiary)" />
          </button>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div className="section-label">Chapters</div>
            <span style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>{downloadedCount}/{total} downloaded</span>
          </div>
          <div>
            {base.length === 0 ? (
              <div style={{ padding: '16px 2px', fontSize: 13.5, lineHeight: 1.55, color: 'var(--text-tertiary)' }}>
                {suggestion
                  ? 'Save this work and the next sync will download it for offline reading.'
                  : 'Queued for offline download — the next sync will fetch the full text so you can read it offline.'}
              </div>
            ) : base.map(ch => (
              <Fragment key={ch.n}>
                <ChapterRow ch={ch} current={!work.frozen && ch.n === work.lastChapter} fetchState={chStateOf(ch)}
                  onOpen={() => openReader(ch)} onFetch={fetchCh} />
                <div className="divider"></div>
              </Fragment>
            ))}
          </div>
        </div>
        {toast}
      </div>

      <Sheet open={showMenu} onClose={() => setShowMenu(false)} title={work.title}>
        <button className="set-group pressable" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, width: '100%', textAlign: 'left', marginBottom: 10 }}
          onClick={() => { setShowMenu(false); openAtSource(); }}>
          <div className="set-ic"><Icon icon="solar:square-top-down-linear" size={18} /></div>
          <div style={{ flex: 1 }}>
            <div className="set-h">Open on {srcLabel}</div>
            <div className="set-d">View this work on the site.</div>
          </div>
        </button>
        <button className="set-group pressable" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, width: '100%', textAlign: 'left' }}
          onClick={remove} disabled={removing}>
          <div className="set-ic" style={{ color: 'var(--danger)' }}><Icon icon="solar:trash-bin-trash-linear" size={18} /></div>
          <div style={{ flex: 1 }}>
            <div className="set-h" style={{ color: 'var(--danger)' }}>{removing ? 'Removing…' : 'Remove from library'}</div>
            <div className="set-d">Hides it in the app. Your AO3 bookmark stays untouched.</div>
          </div>
        </button>
      </Sheet>
    </div>
  );
}
