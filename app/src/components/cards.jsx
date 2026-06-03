import { useState, useRef } from 'react';
import Icon from './Icon.jsx';
import { Cover, FetchButton, StatusBadge, FrozenBadge, OriginBadges, TagChip, fmtWords } from './ui.jsx';
import { COVER_PALETTES } from '../data/sample.js';

// ---- Swipeable row wrapper ------------------------------------------------
// Drag a card to act on it. Swipe RIGHT past the threshold fires `onSwipeRight`
// (used for delete-forever); swipe LEFT fires `onSwipeLeft` (used for "Later").
// As you drag, the action behind the card is revealed on the side you're
// swiping toward, brightening as you approach the threshold. Below threshold
// the card springs back. Pointer events cover both touch and mouse.
export function Swipeable({
  children,
  onSwipeRight,
  onSwipeLeft,
  right = { icon: 'solar:trash-bin-trash-bold', label: 'Delete', color: '#f5455c' },
  left = { icon: 'solar:bookmark-linear', label: 'Later', color: '#f0a020' },
  threshold = 96,
}) {
  const [dx, setDx] = useState(0);
  const [snap, setSnap] = useState(false); // animate the transform (release/exit)
  const startX = useRef(null);
  const startY = useRef(null);
  const locked = useRef(false); // committed to a horizontal swipe (not a scroll)

  const down = (e) => {
    startX.current = e.clientX;
    startY.current = e.clientY;
    locked.current = false;
    setSnap(false);
  };
  const move = (e) => {
    if (startX.current == null) return;
    const d = e.clientX - startX.current;
    const dy = e.clientY - startY.current;
    // Don't hijack a vertical scroll: only lock into a swipe once horizontal
    // movement clearly dominates.
    if (!locked.current) {
      if (Math.abs(d) < 8) return;
      if (Math.abs(d) < Math.abs(dy)) { startX.current = null; return; }
      locked.current = true;
      try { e.currentTarget.setPointerCapture(e.pointerId); } catch (_) {}
    }
    // Ignore a direction that has no handler.
    if ((d > 0 && !onSwipeRight) || (d < 0 && !onSwipeLeft)) return;
    setDx(d);
  };
  const finish = (fn, toX) => { setSnap(true); setDx(toX); setTimeout(() => fn(), 180); };
  const up = () => {
    if (startX.current == null) return;
    startX.current = null;
    if (dx > threshold && onSwipeRight) return finish(onSwipeRight, window.innerWidth);
    if (dx < -threshold && onSwipeLeft) return finish(onSwipeLeft, -window.innerWidth);
    setSnap(true);
    setDx(0);
  };

  const progress = Math.min(Math.abs(dx) / threshold, 1);
  const act = dx > 0 ? right : left;
  return (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'var(--radius-lg, 16px)' }}>
      {dx !== 0 && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center',
          justifyContent: dx > 0 ? 'flex-start' : 'flex-end', padding: '0 22px',
          background: act.color, opacity: 0.35 + progress * 0.65, color: '#fff', gap: 9,
        }}>
          <Icon icon={act.icon} size={22} color="#fff" />
          <span style={{ fontWeight: 700, fontSize: 13, letterSpacing: '.02em' }}>{act.label}</span>
        </div>
      )}
      <div
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        style={{
          transform: `translateX(${dx}px)`,
          transition: snap ? 'transform .18s ease-out' : 'none',
          touchAction: 'pan-y',
        }}
      >
        {children}
      </div>
    </div>
  );
}

// ---- Library list card (horizontal) --------------------------------------
export function LibraryCard({ work, onOpen }) {
  return (
    <div className="libcard pressable" onClick={() => onOpen && onOpen(work)}>
      <div className="meta">
        <div className="story-title" style={{ marginBottom: 2 }}>{work.title}</div>
        <div className="story-sub" style={{ marginBottom: 7 }}>by {work.author}</div>
        <div className="chiprow" style={{ marginBottom: 8 }}>
          {work.frozen ? <FrozenBadge /> : <StatusBadge status={work.status} updated={work.updated} />}
          <OriginBadges bookmarked={work.bookmarked} subscribed={work.subscribed} />
        </div>
        <div className="summary" style={{ flex: 1 }}>{work.summary}</div>
        <div style={{ marginTop: 9 }}>
          {work.offline === false ? (
            <div className="metarow" style={{ color: 'var(--text-tertiary)' }}><Icon icon="solar:clock-circle-linear" size={14} /><span>Downloads on next sync</span></div>
          ) : work.progress >= 1 ? (
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
          {work.offline === false ? (
            <span style={{ color: 'var(--text-tertiary)', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon icon="solar:clock-circle-linear" size={13} /> Queued
            </span>
          ) : (
            <span style={{ color: work.status === 'complete' ? 'var(--success)' : 'var(--warning)', fontWeight: 600 }}>
              {work.progress >= 1 ? 'Finished' : work.progress > 0 ? `Ch ${work.lastChapter}/${work.chaptersTotal}` : work.status === 'complete' ? 'Complete' : 'Ongoing'}
            </span>
          )}
          <span>{fmtWords(work.words)}</span>
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
      <div className="meta">
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => onOpen && onOpen(work)}>
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
              title={saveState === 'queued' ? 'Downloading — sync started' : undefined}
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
  const kindLabel = { relationship: 'Relationship', fandom: 'Fandom', freeform: 'Tag', character: 'Character', group: 'Tag group', language: 'Language' }[tag.kind] || 'Tag';
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
