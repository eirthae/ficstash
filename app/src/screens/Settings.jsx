import { useState, useEffect } from 'react';
import { Appbar } from '../components/chrome.jsx';
import Icon from '../components/Icon.jsx';
import { Toggle, Segmented } from '../components/ui.jsx';
import { fetchOfflineStats } from '../lib/library.js';

export function SettingsScreen({ appMode, setAppMode, nav }) {
  const [notif, setNotif] = useState({ chapters: true, matches: true, frozen: true });
  const [filters, setFilters] = useState({ minWords: true, noPodfic: true, complete: false });
  const [langs, setLangs] = useState({ English: true, Russian: true, Armenian: true, Japanese: true });
  const [defaultTheme] = useState(localStorage.getItem('fs-reader-theme') || 'dark');
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
            <div className="set-tx"><div className="set-h">How FicStash works</div><div className="set-d">A curated reader — no account, no login</div></div>
            <Icon icon="solar:alt-arrow-right-linear" size={18} color="var(--text-tertiary)" />
          </button>
        </SetSection>

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

        <SetSection label="Reading">
          <button className="set-row pressable" style={{ width: '100%', textAlign: 'left' }}
            onClick={() => nav.push('reader', { workId: 'w1', chapterN: 1 })}>
            <div className="set-ic"><Icon icon="solar:book-2-bold" size={18} /></div>
            <div className="set-tx"><div className="set-h">Default reading theme</div><div className="set-d">Used when you open a work — change live in the reader</div></div>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)', textTransform: 'capitalize', fontWeight: 600 }}>{defaultTheme}</span>
            <Icon icon="solar:alt-arrow-right-linear" size={18} color="var(--text-tertiary)" />
          </button>
          <ToggleRow icon="solar:lock-keyhole-minimalistic-linear" h="Keep screen awake" d="While reading" on={true} onChange={() => {}} />
        </SetSection>

        <SetSection label="Discovery filters" note="Applied to tag matches before they reach What's New.">
          <ToggleRow icon="solar:text-field-linear" h="Min. 300 words" d="Skip drabbles and stubs" on={filters.minWords} onChange={v => setFilters({ ...filters, minWords: v })} />
          <ToggleRow icon="solar:microphone-linear" h="Exclude podfics" d="Text works only" on={filters.noPodfic} onChange={v => setFilters({ ...filters, noPodfic: v })} />
          <ToggleRow icon="solar:check-circle-linear" h="Complete works only" d="Hide ongoing fics from matches" on={filters.complete} onChange={v => setFilters({ ...filters, complete: v })} />
          <div className="set-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 10 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <div className="set-ic"><Icon icon="solar:global-linear" size={18} /></div>
              <div className="set-tx"><div className="set-h">Languages</div><div className="set-d">{Object.keys(langs).filter(l => langs[l]).length} selected</div></div>
            </div>
            <div className="chiprow">
              {Object.keys(langs).map(l => (
                <button key={l} className="chip pressable" onClick={() => setLangs({ ...langs, [l]: !langs[l] })}
                  style={{ height: 30, padding: '0 13px', fontSize: 13, background: langs[l] ? 'var(--accent-soft)' : 'var(--surface-2)', color: langs[l] ? 'var(--accent)' : 'var(--text-secondary)' }}>
                  {langs[l] && <Icon icon="solar:check-circle-bold" size={14} />}{l}
                </button>
              ))}
            </div>
          </div>
        </SetSection>

        <SetSection label="Notifications">
          <ToggleRow icon="solar:bell-linear" h="New chapters" d="On works you follow" on={notif.chapters} onChange={v => setNotif({ ...notif, chapters: v })} />
          <ToggleRow icon="solar:magnifer-linear" h="New tag matches" d="Works matching tracked tags" on={notif.matches} onChange={v => setNotif({ ...notif, matches: v })} />
          <ToggleRow icon="solar:shield-warning-linear" h="Work went offline" d="When a saved work disappears from its source" on={notif.frozen} onChange={v => setNotif({ ...notif, frozen: v })} />
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

function ToggleRow({ icon, h, d, on, onChange }) {
  return (
    <div className="set-row">
      <div className="set-ic"><Icon icon={icon} size={18} /></div>
      <div className="set-tx"><div className="set-h">{h}</div>{d && <div className="set-d">{d}</div>}</div>
      <Toggle on={on} onChange={onChange} />
    </div>
  );
}

// ---- How FicStash works ---------------------------------------------------
// FicStash is a curated multi-source reader, not an account mirror. There is no
// login and no password is ever collected or stored. This screen explains where
// stories come from and how to add them.
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
          FicStash gathers stories from several sites into one offline library. You choose what comes in — there’s no login and no password is ever stored.
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
