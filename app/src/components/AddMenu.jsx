import { useState, useRef } from 'react';
import Icon from './Icon.jsx';
import { Sheet, useToast } from './ui.jsx';
import { requestUrl, findExistingWork } from '../lib/links.js';
import { uploadFile, isSupportedUpload } from '../lib/upload.js';

// The global "add" menu, anchored to the centered + button in the bottom nav.
// Tapping the FAB toggles `open`; two options pop out — Upload a file and Add by
// link. Both actions run here (not in Library) so the + works from any tab.
// On success it calls onChanged() so the library refreshes its works + pending
// links.
export function AddMenu({ open, onClose, onChanged }) {
  const [toast, showToast] = useToast();
  const [showLink, setShowLink] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef(null);

  const pickFile = () => { if (!uploading && fileInput.current) fileInput.current.click(); };
  const onFileChosen = async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    onClose?.();
    if (!isSupportedUpload(file)) { showToast('Upload an EPUB, HTML, or TXT file.', 'solar:danger-triangle-bold'); return; }
    setUploading(true);
    showToast(`Importing “${file.name}”…`);
    const res = await uploadFile(file);
    setUploading(false);
    if (res.ok) { showToast('Added to your library.'); onChanged?.(); }
    else showToast(res.error || 'Could not import that file.', 'solar:danger-triangle-bold');
  };

  return (
    <>
      <input ref={fileInput} type="file" accept=".epub,.html,.htm,.txt" onChange={onFileChosen} style={{ display: 'none' }} />

      {open && (
        <>
          <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 40, background: 'rgba(0,0,0,.32)', animation: 'fadeIn .15s ease' }} />
          <div className="add-popout">
            <button className="add-opt pressable" onClick={pickFile} disabled={uploading}>
              <span className="add-opt-ic" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}><Icon icon="solar:upload-minimalistic-bold" size={20} /></span>
              <span className="add-opt-tx"><b>Upload a file</b><span>EPUB, HTML or TXT from your phone</span></span>
            </button>
            <button className="add-opt pressable" onClick={() => { onClose?.(); setShowLink(true); }}>
              <span className="add-opt-ic" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}><Icon icon="solar:link-round-bold" size={20} /></span>
              <span className="add-opt-tx"><b>Add by link</b><span>Paste an AO3 work URL</span></span>
            </button>
          </div>
        </>
      )}

      <AddLinkSheet open={showLink} onClose={() => setShowLink(false)} showToast={showToast}
        onAdded={() => { setShowLink(false); onChanged?.(); }} />
      {toast}
    </>
  );
}

function AddLinkSheet({ open, onClose, onAdded, showToast }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [dupe, setDupe] = useState(null); // existing library work this link points to, if any

  // The actual queue+download, used both for a normal add and "Add anyway".
  const doRequest = async () => {
    setBusy(true);
    const res = await requestUrl(url);
    setBusy(false);
    if (res.ok) {
      setUrl(''); setDupe(null);
      showToast('Downloading… it’ll appear here shortly.');
      onAdded && onAdded();
    } else {
      showToast(res.error || 'Could not add link.', 'solar:danger-triangle-bold');
    }
  };

  const submit = async () => {
    if (busy || !url.trim()) return;
    // Flag a link that's already in the library before queueing it.
    setBusy(true);
    const existing = await findExistingWork(url);
    setBusy(false);
    if (existing && !existing.hidden) { setDupe(existing); return; }
    doRequest();
  };

  const onChangeUrl = (v) => { setUrl(v); if (dupe) setDupe(null); };

  return (
    <Sheet open={open} onClose={onClose} title="Add a work by link">
      <div style={{ fontSize: 13.5, lineHeight: 1.5, color: 'var(--text-secondary)', marginBottom: 14 }}>
        Paste a story link — Royal Road, Scribble Hub, FanFiction.net and many more. FicStash downloads a full offline copy.
      </div>
      <div className="searchfield" style={{ marginBottom: 14 }}>
        <Icon icon="solar:link-linear" size={20} color="var(--text-tertiary)" />
        <input placeholder="https://www.royalroad.com/fiction/…" value={url}
          onChange={e => onChangeUrl(e.target.value)} onKeyDown={e => e.key === 'Enter' && submit()}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} inputMode="url" />
      </div>

      {dupe && (
        <div style={{ display: 'flex', gap: 10, padding: 13, borderRadius: 'var(--radius-md)', background: 'var(--warning-soft, rgba(240,160,30,.14))', marginBottom: 14 }}>
          <Icon icon="solar:check-circle-bold" size={20} color="var(--warning, #f5a524)" style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
            <b style={{ color: 'var(--text-primary)' }}>Already in your library:</b> “{dupe.title}”.
            {dupe.status === 'complete'
              ? ' It’s complete and already saved.'
              : ' It’s ongoing and already auto-updates with new chapters each sync.'}
            {' '}Adding again won’t make a duplicate.
          </div>
        </div>
      )}

      {dupe ? (
        <button className="btn btn-lg btn-surface" style={{ width: '100%' }} onClick={doRequest} disabled={busy}>
          {busy ? 'Adding…' : <><Icon icon="solar:refresh-linear" size={18} /> Add anyway (re-fetch)</>}
        </button>
      ) : (
        <button className="btn btn-lg btn-primary" style={{ width: '100%' }} onClick={submit} disabled={busy || !url.trim()}>
          {busy ? 'Checking…' : <><Icon icon="solar:download-minimalistic-bold" size={18} /> Download work</>}
        </button>
      )}
    </Sheet>
  );
}
