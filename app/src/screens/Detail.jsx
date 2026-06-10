import { Fragment, useState, useEffect } from 'react';
import Icon from '../components/Icon.jsx';
import { StatusBadge, FrozenBadge, TagChip, fmtWords, useToast, Sheet } from '../components/ui.jsx';
import { ChapterRow } from '../components/cards.jsx';
import { COVER_PALETTES, CHAPTERS } from '../data/sample.js';
import { fetchChapters, removeWork, updateWorkFields, fetchSeriesNames } from '../lib/library.js';
import { hasSupabase } from '../lib/supabase.js';
import { requestSave } from '../lib/tags.js';
import { TagGroupBuilder } from './Discover.jsx';
import { kickSync } from '../lib/sync.js';
import { workUrl, sourceLabel } from '../sources/index.js';

export function StoryDetailScreen({ work, suggestion, onSaved, onRemoved, onReload, nav }) {
  const pal = COVER_PALETTES[work.palette] || COVER_PALETTES[0];
  const total = work.chaptersTotal || work.chapters || 1;
  const srcLabel = sourceLabel(work.source);
  const isBook = (work.origin || '') === 'upload';
  // Which builder source a tapped tag should open: uploaded books track Open
  // Library subjects; AO3/RR/SH pass through; anything else falls back to AO3.
  const TRACK_SOURCES = ['ao3', 'royalroad', 'scribblehub', 'books'];
  const builderSource = isBook ? 'books' : (TRACK_SOURCES.includes(work.source) ? work.source : 'ao3');
  // Editable Books fields (rename / series / external link). Seeded from the
  // work and updated in place so the detail view reflects edits immediately.
  const [meta, setMeta] = useState({
    customTitle: work.customTitle || '',
    seriesName: work.seriesName || '',
    seriesIndex: work.seriesIndex ?? '',
    externalUrl: work.externalUrl || '',
  });
  const displayTitle = meta.customTitle || work.title;

  // Uploaded works (and anything without a resolvable link) have no site to open
  // back to — hide the "Open at source" affordances for them. A user-set
  // external link wins (e.g. a Goodreads/series page); AO3 works missing a
  // stored work id/url fall back to an AO3 title search.
  const directUrl = workUrl(work.source, work.sourceWorkId, work.sourceUrl);
  const searchFallback = !directUrl && !meta.externalUrl && work.source === 'ao3' && work.title
    ? `https://archiveofourown.org/works/search?work_search%5Bquery%5D=${encodeURIComponent(work.title)}`
    : '';
  const sourceUrl = meta.externalUrl || directUrl || searchFallback;
  const canOpenAtSource = !!sourceUrl;
  const openLabel = meta.externalUrl ? 'Open link' : searchFallback ? `Find on ${srcLabel}` : `Open on ${srcLabel}`;

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
  const [showEdit, setShowEdit] = useState(false);
  const [savingEdit, setSavingEdit] = useState(false);

  const saveEdit = async (next) => {
    setSavingEdit(true);
    try {
      const idx = next.seriesIndex === '' || next.seriesIndex == null ? null : Number(next.seriesIndex);
      await updateWorkFields(work.id, {
        custom_title: next.customTitle.trim() || null,
        series_name: next.seriesName.trim() || null,
        series_index: Number.isFinite(idx) ? idx : null,
        external_url: next.externalUrl.trim() || null,
      });
      setMeta(next);
      setShowEdit(false);
      onReload?.();
      showToast('Saved', 'solar:check-circle-bold');
    } catch {
      showToast("Couldn't save — try again", 'solar:danger-triangle-linear');
    } finally {
      setSavingEdit(false);
    }
  };
  // Tapping a tag opens the full tracker builder, pre-filled with that tag and
  // this story's source (AO3 tag → AO3 builder, Scribble Hub → SH, …), so the
  // user can add include/exclude tags and hit Follow. `tagBuilder` = tapped tag.
  const [tagBuilder, setTagBuilder] = useState(null);

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
        ? 'Saved — downloading; new chapters arrive on each sync'
        : 'Saved — starting download', 'solar:check-circle-bold');
    } catch {
      setSaveState('idle');
      showToast("Couldn't save — try again", 'solar:danger-triangle-linear');
    }
  };

  const openReader = (ch) => nav.push('reader', { work, workId: work.id, chapterTitle: ch ? ch.title : null, chapterN: ch ? ch.n : (work.lastChapter || 1) });

  const openAtSource = () => {
    if (!sourceUrl) { showToast('No source link for this work', 'solar:link-broken-linear'); return; }
    window.open(sourceUrl, '_blank', 'noopener');
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
            <div style={{ fontFamily: 'var(--font-serif)', fontSize: 22, fontWeight: 600, lineHeight: 1.12, color: '#fff', marginBottom: 6 }}>{displayTitle}</div>
            {isBook && meta.seriesName && <div style={{ fontSize: 12, color: 'rgba(255,255,255,.8)', marginBottom: 4 }}>📚 {meta.seriesName}{meta.seriesIndex !== '' && meta.seriesIndex != null ? ` · #${meta.seriesIndex}` : ''}</div>}
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
            ) : canOpenAtSource ? (
              <button className="btn btn-lg btn-surface" onClick={openAtSource} style={{ flex: 'none', width: 56, padding: 0 }} title={openLabel}>
                <Icon icon="solar:square-top-down-linear" size={22} /></button>
            ) : null}
          </div>

          {suggestion && ongoing && (
            <button className="pressable" onClick={openAtSource}
              style={{ display: 'flex', gap: 10, padding: 13, borderRadius: 'var(--radius-md)', background: 'var(--info-soft)', marginBottom: 18, width: '100%', textAlign: 'left', border: 'none' }}>
              <Icon icon="solar:bell-bold" size={20} color="var(--info)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                <b style={{ color: 'var(--text-primary)' }}>This work is still updating.</b> Saving downloads everything posted so far, and FicStash re-checks it on every sync — new chapters download automatically as they go up.
              </div>
              <Icon icon="solar:arrow-right-up-linear" size={18} color="var(--text-tertiary)" style={{ flexShrink: 0, alignSelf: 'center' }} />
            </button>
          )}

          {!suggestion && ongoing && !work.frozen && (
            <div style={{ display: 'flex', gap: 10, padding: 13, borderRadius: 'var(--radius-md)', background: 'var(--success-soft, rgba(23,201,100,.12))', marginBottom: 18 }}>
              <Icon icon="solar:refresh-circle-bold" size={20} color="var(--success, #17c964)" style={{ flexShrink: 0, marginTop: 1 }} />
              <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
                <b style={{ color: 'var(--text-primary)' }}>Following — auto-updating.</b> This work is still ongoing, so FicStash checks it for new chapters on every sync (each night and whenever you tap Sync) and downloads them automatically. It stops on its own once the work is complete.
              </div>
            </div>
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

          <div className="chiprow" style={{ marginBottom: 10 }}>
            <TagChip t={work.fandom.split('–')[0].trim()} k="fandom"
              onClick={() => setTagBuilder({ name: work.fandom.split('–')[0].trim(), id: '', kind: 'fandom' })} />
            {(work.tags || []).map((t, i) => (
              <TagChip key={i} t={t.t} k={t.k} onClick={() => setTagBuilder({ name: t.t, id: '', kind: t.k })} />
            ))}
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', marginBottom: 22 }}>Tap a tag to follow it — refine with include/exclude, then track.</div>

          {canOpenAtSource && (
            <button className="set-group pressable" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, width: '100%', textAlign: 'left', marginBottom: 22 }}
              onClick={openAtSource}>
              <div className="set-ic"><Icon icon="solar:square-top-down-linear" size={18} /></div>
              <div style={{ flex: 1 }}>
                <div className="set-h">{openLabel}</div>
                <div className="set-d">Follow or bookmark on the site — FicStash never touches your account.</div>
              </div>
              <Icon icon="solar:arrow-right-up-linear" size={18} color="var(--text-tertiary)" />
            </button>
          )}

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
        {canOpenAtSource && (
          <button className="set-group pressable" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, width: '100%', textAlign: 'left', marginBottom: 10 }}
            onClick={() => { setShowMenu(false); openAtSource(); }}>
            <div className="set-ic"><Icon icon="solar:square-top-down-linear" size={18} /></div>
            <div style={{ flex: 1 }}>
              <div className="set-h">{openLabel}</div>
              <div className="set-d">View this work on the site.</div>
            </div>
          </button>
        )}
        {!suggestion && (
          <button className="set-group pressable" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, width: '100%', textAlign: 'left', marginBottom: 10 }}
            onClick={() => { setShowMenu(false); setShowEdit(true); }}>
            <div className="set-ic"><Icon icon="solar:pen-2-linear" size={18} /></div>
            <div style={{ flex: 1 }}>
              <div className="set-h">Edit details</div>
              <div className="set-d">{isBook ? 'Rename, set a series & reading order, add a link.' : 'Rename or add a custom link.'}</div>
            </div>
          </button>
        )}
        <button className="set-group pressable" style={{ display: 'flex', alignItems: 'center', gap: 13, padding: 14, width: '100%', textAlign: 'left' }}
          onClick={remove} disabled={removing}>
          <div className="set-ic" style={{ color: 'var(--danger)' }}><Icon icon="solar:trash-bin-trash-linear" size={18} /></div>
          <div style={{ flex: 1 }}>
            <div className="set-h" style={{ color: 'var(--danger)' }}>{removing ? 'Removing…' : 'Remove from library'}</div>
            <div className="set-d">{work.origin === 'upload' ? 'Hides it in the app. The downloaded copy stays in your shelf.' : 'Hides it in the app. Your AO3 bookmark stays untouched.'}</div>
          </div>
        </button>
      </Sheet>

      <TagGroupBuilder
        open={!!tagBuilder}
        initialSource={builderSource}
        initialTags={tagBuilder ? [tagBuilder] : []}
        onClose={() => setTagBuilder(null)}
        onCreated={(g) => { setTagBuilder(null); showToast(`Now tracking “${g.name}”`, 'solar:check-circle-bold'); }}
      />

      <EditDetailsSheet open={showEdit} onClose={() => setShowEdit(false)} isBook={isBook}
        initial={meta} placeholderTitle={work.title} saving={savingEdit} onSave={saveEdit} />
    </div>
  );
}

// Edit a work's display title, series grouping (Books), and external link.
function EditDetailsSheet({ open, onClose, isBook, initial, placeholderTitle, saving, onSave }) {
  const [form, setForm] = useState(initial);
  const [allSeries, setAllSeries] = useState([]); // existing collection names
  useEffect(() => {
    if (open) { setForm(initial); fetchSeriesNames().then(setAllSeries).catch(() => {}); }
  }, [open]); // reseed + load existing series on open
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const field = { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 };
  const label = { fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' };
  // Existing collections matching what's typed (so you reuse one, not retype it).
  const sq = (form.seriesName || '').trim().toLowerCase();
  const seriesMatches = sq
    ? allSeries.filter(s => s.toLowerCase().includes(sq) && s.toLowerCase() !== sq).slice(0, 6)
    : [];

  return (
    <Sheet open={open} onClose={onClose} title="Edit details">
      <div style={field}>
        <label style={label}>Title</label>
        <div className="searchfield" style={{ background: 'var(--surface-2)' }}>
          <input placeholder={placeholderTitle} value={form.customTitle}
            onChange={e => set('customTitle', e.target.value)} />
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>Leave blank to keep the original title.</div>
      </div>

      {isBook && (
        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ ...field, flex: 1, position: 'relative' }}>
            <label style={label}>Series</label>
            <div className="searchfield" style={{ background: 'var(--surface-2)' }}>
              <input placeholder="e.g. Mistborn" value={form.seriesName}
                onChange={e => set('seriesName', e.target.value)} autoComplete="off" />
            </div>
            {seriesMatches.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 5, marginTop: 4,
                background: 'var(--surface-elevated)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
                boxShadow: 'var(--shadow-pop)', overflow: 'hidden' }}>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', padding: '7px 12px 4px' }}>Use an existing collection</div>
                {seriesMatches.map(s => (
                  <button key={s} className="pressable" onClick={() => set('seriesName', s)}
                    style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left',
                      padding: '9px 12px', background: 'transparent', borderTop: '1px solid var(--border)',
                      fontSize: 13.5, color: 'var(--text-primary)' }}>
                    <Icon icon="solar:layers-minimalistic-linear" size={15} color="var(--text-tertiary)" />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div style={{ ...field, width: 92 }}>
            <label style={label}>Order #</label>
            <div className="searchfield" style={{ background: 'var(--surface-2)' }}>
              <input inputMode="decimal" placeholder="1" value={form.seriesIndex}
                onChange={e => set('seriesIndex', e.target.value)} />
            </div>
          </div>
        </div>
      )}

      <div style={field}>
        <label style={label}>External link <span style={{ fontWeight: 500, color: 'var(--text-tertiary)' }}>(optional)</span></label>
        <div className="searchfield" style={{ background: 'var(--surface-2)' }}>
          <Icon icon="solar:link-linear" size={18} color="var(--text-tertiary)" />
          <input placeholder="https://www.goodreads.com/…" value={form.externalUrl}
            onChange={e => set('externalUrl', e.target.value)}
            autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)' }}>A Goodreads / series page — opens from “Open at source”.</div>
      </div>

      <button className="btn btn-lg btn-primary" style={{ width: '100%' }} disabled={saving} onClick={() => onSave(form)}>
        {saving ? 'Saving…' : <><Icon icon="solar:check-circle-bold" size={18} /> Save</>}
      </button>
    </Sheet>
  );
}
