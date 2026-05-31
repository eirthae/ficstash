import Icon from './Icon.jsx';
import { Cover, FetchButton, StatusBadge, FrozenBadge, TagChip, fmtWords } from './ui.jsx';
import { COVER_PALETTES } from '../data/sample.js';

// ---- Library list card (horizontal) --------------------------------------
export function LibraryCard({ work, onOpen }) {
  return (
    <div className="libcard pressable" onClick={() => onOpen && onOpen(work)}>
      <div className="meta">
        <div className="story-title" style={{ marginBottom: 2 }}>{work.title}</div>
        <div className="story-sub" style={{ marginBottom: 7 }}>by {work.author}</div>
        <div className="chiprow" style={{ marginBottom: 8 }}>
          {work.frozen ? <FrozenBadge /> : <StatusBadge status={work.status} updated={work.updated} />}
        </div>
        <div className="summary" style={{ flex: 1 }}>{work.summary}</div>
        <div style={{ marginTop: 9 }}>
          {work.progress >= 1 ? (
            <div className="metarow"><Icon icon="solar:check-circle-bold" size={14} color="var(--success)" /><span>Finished</span></div>
          ) : work.progress > 0 ? (
            <>
              <div className="progress" style={{ marginBottom: 5 }}><i style={{ width: `${work.progress * 100}%` }}></i></div>
              <div className="metarow"><span>Chapter {work.lastChapter} of {work.chaptersTotal}</span><span>·</span><span>{Math.round(work.progress * 100)}%</span></div>
            </>
          ) : (
            <div className="metarow" style={{ color: 'var(--accent)' }}><Icon icon="solar:book-bold" size={14} /><span>{work.unread ? 'Not started' : 'New — start reading'}</span></div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Library grid card (cover-forward) ------------------------------------
export function GridCard({ work, onOpen }) {
  return (
    <div className="gridcard pressable" onClick={() => onOpen && onOpen(work)}>
      <div style={{ position: 'relative' }}>
        <Cover title={work.title} author={work.author} fandom={work.fandom} palette={work.palette}
          w={'100%'} h={210} style={{ width: '100%' }} />
        {work.frozen && <div style={{ position: 'absolute', top: 8, left: 8 }}><FrozenBadge /></div>}
        {work.unread && <div style={{ position: 'absolute', top: 8, right: 8, width: 9, height: 9, borderRadius: '50%', background: 'var(--accent)', boxShadow: '0 0 0 2px rgba(0,0,0,.25)' }}></div>}
      </div>
      <div>
        {work.progress > 0 && work.progress < 1 && <div className="progress" style={{ marginBottom: 6 }}><i style={{ width: `${work.progress * 100}%` }}></i></div>}
        <div className="metarow" style={{ justifyContent: 'space-between' }}>
          <span style={{ color: work.status === 'complete' ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
            {work.progress >= 1 ? 'Finished' : work.progress > 0 ? `Ch ${work.lastChapter}/${work.chaptersTotal}` : work.status === 'complete' ? 'Complete' : 'Ongoing'}
          </span>
          <span>{fmtWords(work.words)}</span>
        </div>
      </div>
    </div>
  );
}

// ---- Continue-reading hero card -------------------------------------------
export function ContinueCard({ work, onOpen }) {
  return (
    <div className="ccard pressable" onClick={() => onOpen && onOpen(work)}>
      <div style={{ display: 'flex', gap: 12, padding: 12 }}>
        <Cover title={work.title} author={work.author} fandom={work.fandom} palette={work.palette} w={66} h={92} />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div className="section-label" style={{ color: 'var(--accent)', marginBottom: 5 }}>Continue</div>
          <div className="story-title" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', marginBottom: 4 }}>{work.title}</div>
          <div className="story-sub">{work.frozen ? 'saved copy' : work.fandom.split('–')[0].trim()}</div>
          <div style={{ flex: 1 }}></div>
          <div className="metarow" style={{ marginBottom: 6 }}><span>Chapter {work.lastChapter}</span><span>·</span><span>{Math.round(work.progress * 100)}%</span></div>
          <div className="progress"><i style={{ width: `${work.progress * 100}%` }}></i></div>
        </div>
      </div>
    </div>
  );
}

// ---- Suggestion card (+ save / dismiss) -----------------------------------
// saveState: 'idle' → 'queued' (worker will fetch on next sync) → 'saved' (in library)
export function SuggestionCard({ work, onSave, saveState = 'idle', onDismiss, onOpen, cta = 'Open' }) {
  return (
    <div className="libcard fade-enter">
      <div onClick={() => onOpen && onOpen(work)} style={{ cursor: 'pointer' }}>
        <Cover title={work.title} author={work.author} fandom={work.fandom} palette={work.palette} w={78} h={108} />
      </div>
      <div className="meta">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="story-title" style={{ marginBottom: 2 }}>{work.title}</div>
            <div className="story-sub">by {work.author}</div>
          </div>
          <button className="iconbtn" style={{ width: 30, height: 30, marginRight: -4, marginTop: -2 }} onClick={onDismiss} aria-label="Dismiss">
            <Icon icon="solar:close-circle-linear" size={20} color="var(--text-tertiary)" />
          </button>
        </div>
        <div className="summary" style={{ margin: '7px 0' }}>{work.summary}</div>
        <div className="chiprow" style={{ marginBottom: 9 }}>
          {work.tags.slice(0, 3).map((t, i) => <TagChip key={i} t={t.t} k={t.k} />)}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div className="metarow"><StatusBadge status={work.status} /><span>·</span><span>{fmtWords(work.words)}</span></div>
          {onSave ? (
            <button
              className={`btn btn-sm ${saveState === 'idle' ? 'btn-primary' : 'btn-flat'}`}
              onClick={() => saveState === 'idle' && onSave(work)}
              disabled={saveState !== 'idle'}
              style={{ minWidth: 104 }}
              title={saveState === 'queued' ? 'Will download on the next sync' : undefined}
            >
              {saveState === 'saved' ? <><Icon icon="solar:check-read-linear" size={16} /> In library</>
                : saveState === 'queued' ? <><Icon icon="solar:clock-circle-linear" size={16} /> Queued</>
                : <><Icon icon="solar:download-minimalistic-linear" size={16} /> Save</>}
            </button>
          ) : (
            <button className="btn btn-sm btn-flat" onClick={() => onOpen && onOpen(work)} style={{ minWidth: 92 }}>
              <Icon icon="solar:arrow-right-linear" size={16} /> {cta}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Tag tile (discovery grid) --------------------------------------------
export function TagTile({ tag, onOpen }) {
  const pal = COVER_PALETTES[tag.palette] || COVER_PALETTES[0];
  const kindLabel = { relationship: 'Relationship', fandom: 'Fandom', freeform: 'Tag', character: 'Character', group: 'Tag group' }[tag.kind] || 'Tag';
  return (
    <div className="tile pressable" onClick={() => onOpen && onOpen(tag)} style={{ background: `linear-gradient(150deg, ${pal[0]}, ${pal[1]})` }}>
      <div className="grain"></div>
      {tag.fresh > 0 && <div className="t-new"><span style={{ width: 6, height: 6, borderRadius: '50%', background: '#fff' }}></span>{tag.fresh} new</div>}
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', opacity: .85 }}>{kindLabel}</div>
      </div>
      <div style={{ position: 'relative', zIndex: 1 }}>
        <div className="t-name">{tag.name}</div>
        <div className="t-count" style={{ marginTop: 5 }}>{tag.count} works tracked</div>
      </div>
    </div>
  );
}

// ---- Chapter row (TOC, with fetch state) ----------------------------------
export function ChapterRow({ ch, current, onOpen, onFetch, fetchState }) {
  const state = fetchState || ch.state;
  return (
    <div className={`chrow pressable ${current ? 'current' : ''}`} onClick={() => state === 'done' && onOpen && onOpen(ch)}>
      <div className="chnum">{current ? <Icon icon="solar:bookmark-bold" size={16} color="var(--accent)" /> : ch.n}</div>
      <div className="chmeta">
        <div className="chtitle">{ch.title}</div>
        <div className="chsub">{fmtWords(ch.words)}{state === 'failed' ? ' · fetch failed' : state === 'idle' ? ' · not downloaded' : ''}</div>
      </div>
      <FetchButton state={state} onClick={(e) => { e.stopPropagation(); onFetch && onFetch(ch); }} />
    </div>
  );
}
