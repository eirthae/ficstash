import { useState, useEffect } from 'react';
import { Appbar } from '../components/chrome.jsx';
import Icon from '../components/Icon.jsx';
import { Toggle, Segmented, useToast } from '../components/ui.jsx';
import { fetchOfflineStats } from '../lib/library.js';

export function SettingsScreen({ appMode, setAppMode, nav }) {
  const [notif, setNotif] = useState({ chapters: true, matches: true, frozen: true });
  const [filters, setFilters] = useState({ minWords: true, noPodfic: true, complete: false });
  const [langs, setLangs] = useState({ English: true, Russian: true, Armenian: true, Japanese: true });
  const [defaultTheme] = useState(localStorage.getItem('fs-reader-theme') || 'dark');
  const [storage, setStorage] = useState(undefined); // undefined=loading, null=unavailable
  useEffect(() => { fetchOfflineStats().then(setStorage).catch(() => setStorage(null)); }, []);
  const storageLine = storage === undefined ? 'Counting…'
    : storage === null ? 'Connect AO3 to see your offline library'
    : storage.downloaded >= storage.total
      ? `${storage.total} works · all available offline`
      : `${storage.downloaded} of ${storage.total} works downloaded · backfill in progress`;

  return (
    <div className="screen">
      <Appbar large title="Settings" />
      <div className="scroll" style={{ padding: '0 20px 28px', display: 'flex', flexDirection: 'column', gap: 22 }}>

        <SetSection label="Account">
          <button className="set-row pressable" style={{ width: '100%', textAlign: 'left' }} onClick={() => nav.push('connect')}>
            <div className="set-ic" style={{ background: 'var(--success-soft)', color: 'var(--success)' }}><Icon icon="solar:link-circle-bold" size={18} /></div>
            <div className="set-tx"><div className="set-h">AO3 connection</div><div className="set-d">Connected as <b>your_ao3_handle</b></div></div>
            <span className="statusbadge" style={{ color: 'var(--success)' }}><span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--success)' }}></span></span>
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
          <ToggleRow icon="solar:shield-warning-linear" h="Work went offline" d="When a saved work leaves AO3" on={notif.frozen} onChange={v => setNotif({ ...notif, frozen: v })} />
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

// ---- Connect / Account ----------------------------------------------------
export function ConnectScreen({ nav }) {
  const [step, setStep] = useState('intro'); // intro | importing | done
  const [toast] = useToast();
  useEffect(() => {
    if (step === 'importing') { const t = setTimeout(() => setStep('done'), 2600); return () => clearTimeout(t); }
  }, [step]);

  return (
    <div className="screen view-enter">
      <Appbar back={() => nav.pop()} title="Connect to AO3" />
      <div className="scroll" style={{ padding: '8px 24px 28px' }}>
        <div style={{ width: 72, height: 72, borderRadius: 20, background: 'linear-gradient(150deg,#7828c8,#006fee)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '14px auto 18px', boxShadow: 'var(--shadow-pop)' }}>
          <Icon icon="solar:bookmark-opened-bold" size={36} color="#fff" />
        </div>
        <div style={{ textAlign: 'center', fontSize: 21, fontWeight: 800, letterSpacing: '-.02em', marginBottom: 8 }}>Bring your bookmarks home</div>
        <div style={{ textAlign: 'center', fontSize: 14, lineHeight: 1.55, color: 'var(--text-secondary)', maxWidth: 300, margin: '0 auto 24px' }}>
          Sign in once. FicStash downloads private copies of your bookmarked works — and never writes anything back to your AO3 account.
        </div>

        {step === 'intro' && (
          <div className="fade-enter" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div className="set-group">
              <div className="set-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 12, padding: 16 }}>
                <Field label="AO3 username" placeholder="your_handle" icon="solar:user-linear" />
                <Field label="Password" placeholder="••••••••" icon="solar:lock-password-linear" pw />
              </div>
            </div>
            <button className="btn btn-lg btn-primary btn-block" onClick={() => setStep('importing')}>
              <Icon icon="solar:login-3-bold" size={20} /> Sign in &amp; import bookmarks</button>
            <ManualNote />
          </div>
        )}

        {step === 'importing' && (
          <div className="fade-enter" style={{ textAlign: 'center', padding: '20px 0' }}>
            <div className="fetch busy" style={{ width: 52, height: 52, margin: '0 auto 18px' }}>
              <svg className="ring" viewBox="0 0 52 52"><circle className="track" cx="26" cy="26" r="23"></circle>
                <circle className="bar" cx="26" cy="26" r="23" strokeDasharray="144" strokeDashoffset="60"></circle></svg>
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>Importing bookmarks…</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Downloading 6 works in the background</div>
          </div>
        )}

        {step === 'done' && (
          <div className="fade-enter" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div className="set-group" style={{ padding: 18, display: 'flex', alignItems: 'center', gap: 13 }}>
              <div className="set-ic" style={{ background: 'var(--success-soft)', color: 'var(--success)', width: 42, height: 42 }}><Icon icon="solar:check-circle-bold" size={24} /></div>
              <div><div className="set-h">Connected</div><div className="set-d">6 works imported · your library is ready</div></div>
            </div>
            <button className="btn btn-lg btn-primary btn-block" onClick={() => nav.reset('library')}>
              <Icon icon="solar:books-minimalistic-bold" size={20} /> Go to Library</button>
            <ManualNote />
          </div>
        )}
        {toast}
      </div>
    </div>
  );
}

function ManualNote() {
  return (
    <div style={{ display: 'flex', gap: 11, padding: 14, borderRadius: 'var(--radius-md)', background: 'var(--info-soft)', marginTop: 4 }}>
      <Icon icon="solar:square-top-down-linear" size={20} color="var(--info)" style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ fontSize: 12.5, lineHeight: 1.5, color: 'var(--text-secondary)' }}>
        To follow or bookmark a work, use <b style={{ color: 'var(--text-primary)' }}>Open on AO3</b> from any story. FicStash reads — it never acts on your account.
      </div>
    </div>
  );
}

function Field({ label, placeholder, icon, pw }) {
  const [v, setV] = useState('');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--text-secondary)' }}>{label}</label>
      <div className="searchfield" style={{ background: 'var(--surface-2)', height: 48 }}>
        <Icon icon={icon} size={19} color="var(--text-tertiary)" />
        <input type={pw ? 'password' : 'text'} placeholder={placeholder} value={v} onChange={e => setV(e.target.value)} />
      </div>
    </div>
  );
}
