import { useState, useEffect } from 'react';
import { Appbar } from '../components/chrome.jsx';
import Icon from '../components/Icon.jsx';
import { Segmented } from '../components/ui.jsx';
import { fetchOfflineStats } from '../lib/library.js';

export function SettingsScreen({ appMode, setAppMode, onSignOut, canSignOut, nav }) {
  const [storage, setStorage] = useState(undefined); // undefined=loading, null=unavailable
  useEffect(() => { fetchOfflineStats().then(setStorage).catch(() => setStorage(null)); }, []);
  const storageLine = storage === undefined ? 'Counting…'
    : storage === null ? 'No offline works yet'
    : storage.downloaded >= storage.total
      ? `${storage.total} works · all available offline`
      : `${storage.downloaded} of ${storage.total} works downloaded · backfill in progress`;

  return (
    <div className="screen">
      <Appbar large title="Settings" />
      <div className="scroll" style={{ padding: '0 20px 28px', display: 'flex', flexDirection: 'column', gap: 22 }}>

        <SetSection label="Sources">
          <button className="set-row pressable" style={{ width: '100%', textAlign: 'left' }} onClick={() => nav.push('connect')}>
            <div className="set-ic" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}><Icon icon="solar:widget-5-bold" size={18} /></div>
            <div className="set-tx"><div className="set-h">How FicStash works</div><div className="set-d">A curated, private reader</div></div>
            <Icon icon="solar:alt-arrow-right-linear" size={18} color="var(--text-tertiary)" />
          </button>
        </SetSection>

        {canSignOut && (
          <SetSection label="Account" note="Your library is private and locked to this account. Signing out clears this device; sign back in any time.">
            <button className="set-row pressable" style={{ width: '100%', textAlign: 'left' }} onClick={onSignOut}>
              <div className="set-ic" style={{ background: 'var(--danger-soft, rgba(243,18,96,.12))', color: 'var(--danger, #f31260)' }}><Icon icon="solar:logout-3-bold" size={18} /></div>
              <div className="set-tx"><div className="set-h">Sign out</div><div className="set-d">Lock this device</div></div>
              <Icon icon="solar:alt-arrow-right-linear" size={18} color="var(--text-tertiary)" />
            </button>
          </SetSection>
        )}

        <SetSection label="Appearance" note="Controls the whole app. Reader themes are separate — set them in the reader.">
          <div className="set-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div className="set-ic"><Icon icon="solar:pallete-2-bold" size={18} /></div>
              <div className="set-tx"><div className="set-h">App color mode</div><div className="set-d">Dark, Light, or follow your phone</div></div>
            </div>
            <Segmented value={appMode} onChange={setAppMode} options={[
              { value: 'light', label: 'Light', icon: 'solar:sun-2-linear' },
              { value: 'dark', label: 'Dark', icon: 'solar:moon-linear' },
              { value: 'system', label: 'System', icon: 'solar:smartphone-linear' },
            ]} />
          </div>
        </SetSection>

        <SetSection label="Storage">
          <div className="set-row">
            <div className="set-ic"><Icon icon="solar:database-linear" size={18} /></div>
            <div className="set-tx"><div className="set-h">Offline library</div><div className="set-d">{storageLine}</div></div>
            <Icon icon="solar:wifi-router-minimalistic-linear" size={20} color="var(--text-tertiary)" />
          </div>
        </SetSection>

        <div style={{ textAlign: 'center', fontSize: 11.5, color: 'var(--text-tertiary)', paddingTop: 4 }}>FicStash · private archive · v1.0</div>
      </div>
    </div>
  );
}

function SetSection({ label, note, children }) {
  return (
    <div>
      <div className="section-label" style={{ marginBottom: 10, padding: '0 2px' }}>{label}</div>
      <div className="set-group">{children}</div>
      {note && <div style={{ fontSize: 11.5, color: 'var(--text-tertiary)', padding: '8px 4px 0', lineHeight: 1.45 }}>{note}</div>}
    </div>
  );
}

// ---- How FicStash works ---------------------------------------------------
// FicStash is a curated multi-source reader, not an AO3 account mirror. It has
// its own private owner login (so only you can read your library), but it never
// collects or stores any AO3 password. This screen explains where stories come
// from and how to add them.
const WAYS = [
  { icon: 'solar:magnifer-bold', title: 'Track tags & genres', body: 'Follow tags on AO3, or genres on Royal Road and Scribble Hub. New matches surface in What’s New — no account needed.' },
  { icon: 'solar:link-round-bold', title: 'Add by link', body: 'Paste a work’s URL and FicStash fetches a private, fully-offline copy.' },
  { icon: 'solar:upload-minimalistic-bold', title: 'Upload a file', body: 'Bring your own EPUB, HTML, or TXT. It’s parsed on-device and stored offline.' },
  { icon: 'solar:book-bookmark-bold', title: 'Watch for new books', body: 'Track an author on Open Library to hear about new releases, then buy the EPUB and upload it.' },
];

export function ConnectScreen({ nav }) {
  return (
    <div className="screen view-enter">
      <Appbar back={() => nav.pop()} title="How FicStash works" />
      <div className="scroll" style={{ padding: '8px 24px 28px' }}>
        <div style={{ width: 72, height: 72, borderRadius: 20, background: 'linear-gradient(150deg,#7828c8,#006fee)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '14px auto 18px', boxShadow: 'var(--shadow-pop)' }}>
          <Icon icon="solar:bookmark-opened-bold" size={36} color="#fff" />
        </div>
        <div style={{ textAlign: 'center', fontSize: 21, fontWeight: 800, letterSpacing: '-.02em', marginBottom: 8 }}>Your private, curated shelf</div>
        <div style={{ textAlign: 'center', fontSize: 14, lineHeight: 1.55, color: 'var(--text-secondary)', maxWidth: 300, margin: '0 auto 24px' }}>
          FicStash gathers stories from several sites into one offline library. You choose what comes in. It’s locked to your own private account — and no AO3 password is ever asked for or stored.
        </div>

        <div className="set-group" style={{ display: 'flex', flexDirection: 'column' }}>
          {WAYS.map(w => (
            <div key={w.title} className="set-row" style={{ alignItems: 'flex-start', gap: 13 }}>
              <div className="set-ic" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}><Icon icon={w.icon} size={18} /></div>
              <div className="set-tx"><div className="set-h">{w.title}</div><div className="set-d" style={{ whiteSpace: 'normal', lineHeight: 1.45 }}>{w.body}</div></div>
            </div>
          ))}
        </div>

        <button className="btn btn-lg btn-primary btn-block" style={{ marginTop: 18 }} onClick={() => nav.reset('discover')}>
          <Icon icon="solar:compass-bold" size={20} /> Discover stories</button>
        <ManualNote />
      </div>
    </div>
  );
}

function ManualNote() {
  return (
    <div style={{ display: 'flex', gap: 11, padding: 14, borderRadius: 'var(--radius-md)', background: 'var(--info-soft)', marginTop: 14 }}>
      <Icon icon="solar:square-top-down-linear" size={20} color="var(--info)" style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
        Want to bookmark or comment? Use <b style={{ color: 'var(--text-primary)' }}>Open at source</b> from any story. FicStash only reads — it never acts on your behalf.
      </div>
    </div>
  );
}
