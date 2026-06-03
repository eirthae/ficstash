import { useState, useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { BottomNav } from './components/chrome.jsx';
import { LibraryScreen } from './screens/Library.jsx';
import { WhatsNewScreen } from './screens/WhatsNew.jsx';
import { DiscoverScreen, TagResultsScreen, LaterScreen } from './screens/Discover.jsx';
import { SettingsScreen, ConnectScreen } from './screens/Settings.jsx';
import { StoryDetailScreen } from './screens/Detail.jsx';
import { ReaderScreen } from './screens/Reader.jsx';
import { WORKS, NEW_CHAPTERS, NEW_MATCHES } from './data/sample.js';
import { fetchWorks } from './lib/library.js';

const READER_DEFAULTS = { theme: 'dark', font: 'serif', size: 19, leading: 1.70, margin: 26, brightness: 1 };

export default function App() {
  // ---- app color mode (whole chrome) -------------------------------------
  const [appMode, setAppMode] = useState(() => localStorage.getItem('fs-mode') || 'system');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => { try { localStorage.setItem('fs-mode', appMode); } catch (e) {} }, [appMode]);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const fn = e => setSystemDark(e.matches);
    mq.addEventListener ? mq.addEventListener('change', fn) : mq.addListener(fn);
    return () => { mq.removeEventListener ? mq.removeEventListener('change', fn) : mq.removeListener(fn); };
  }, []);
  const resolvedMode = appMode === 'system' ? (systemDark ? 'dark' : 'light') : appMode;

  // ---- reader settings (independent of app mode) -------------------------
  // Persisted through Capacitor Preferences (native key-value store) rather than
  // WebView localStorage: on Android the WebView can drop localStorage between
  // cold starts, which silently reset the reader's font/size/margins. Preferences
  // is backed by SharedPreferences and survives. Hydration is async, so we guard
  // the write effect until the stored value has loaded — otherwise the initial
  // default-state render would clobber the saved settings before we read them.
  const [readerSettings, setReaderSettings] = useState(() => {
    let saved = {}; try { saved = JSON.parse(localStorage.getItem('fs-reader') || '{}'); } catch (e) {}
    return { ...READER_DEFAULTS, ...saved };
  });
  const readerHydrated = useRef(false);
  useEffect(() => {
    let alive = true;
    Preferences.get({ key: 'fs-reader' })
      .then(({ value }) => {
        if (alive && value) {
          try { setReaderSettings({ ...READER_DEFAULTS, ...JSON.parse(value) }); } catch (e) {}
        }
      })
      .catch(() => {})
      .finally(() => { readerHydrated.current = true; });
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!readerHydrated.current) return;
    Preferences.set({ key: 'fs-reader', value: JSON.stringify(readerSettings) }).catch(() => {});
    try { localStorage.setItem('fs-reader', JSON.stringify(readerSettings)); } catch (e) {}
    try { localStorage.setItem('fs-reader-theme', readerSettings.theme); } catch (e) {}
  }, [readerSettings]);

  // ---- live library from Supabase (null = still loading) -----------------
  // When Supabase isn't configured, fetchWorks() returns null and we fall
  // back to bundled sample data so the app still has something to show.
  const [works, setWorks] = useState(null);
  useEffect(() => {
    let alive = true;
    fetchWorks()
      .then(r => { if (alive) setWorks(r ?? WORKS); })
      .catch(() => { if (alive) setWorks(WORKS); });
    return () => { alive = false; };
  }, []);
  // Drop a removed work from the in-memory list so the library updates at once
  // (the row is already flagged hidden in the DB by the Detail screen).
  const removeFromLibrary = (id) => setWorks(ws => (ws || []).filter(w => w.id !== id));

  // ---- navigation stack --------------------------------------------------
  const [tab, setTab] = useState('library');
  const [stack, setStack] = useState([]);
  const nav = useRef();
  nav.current = {
    push: (screen, props = {}) => { setStack(s => [...s, { screen, props }]); try { history.pushState({ fs: 1 }, ''); } catch (e) {} },
    pop: () => setStack(s => s.slice(0, -1)),
    reset: (tabId) => { setStack([]); setTab(tabId); },
  };
  useEffect(() => {
    const onPop = () => setStack(s => (s.length ? s.slice(0, -1) : s));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const switchTab = (id) => { setStack([]); setTab(id); };

  // Android hardware back / swipe-back gesture. Capacitor routes both through
  // the backButton event; once we register a listener it stops auto-closing the
  // app, so we drive the in-app stack and only exit from the Library root.
  const navState = useRef({ stack, tab });
  navState.current = { stack, tab };
  useEffect(() => {
    const handle = CapApp.addListener('backButton', () => {
      const { stack, tab } = navState.current;
      if (stack.length) setStack(s => s.slice(0, -1));
      else if (tab !== 'library') switchTab('library');
      else CapApp.exitApp();
    });
    return () => { handle.then(h => h.remove()).catch(() => {}); };
  }, []);

  const top = stack[stack.length - 1];
  const showNav = !top;

  const renderTab = () => {
    const n = nav.current;
    if (tab === 'library') return <LibraryScreen works={works} layout="fandom" onRemove={removeFromLibrary} nav={n} />;
    if (tab === 'whatsnew') return <WhatsNewScreen chapters={NEW_CHAPTERS} matches={NEW_MATCHES} nav={n} />;
    if (tab === 'discover') return <DiscoverScreen nav={n} />;
    if (tab === 'settings') return <SettingsScreen appMode={appMode} setAppMode={setAppMode} nav={n} />;
  };
  const renderTop = () => {
    const n = nav.current, p = top.props || {};
    if (top.screen === 'detail') return <StoryDetailScreen work={p.work} suggestion={p.suggestion} onSaved={p.onSaved} onRemoved={p.onRemoved} nav={n} />;
    if (top.screen === 'reader') return <ReaderScreen work={p.work} workId={p.workId} chapterN={p.chapterN} chapterTitle={p.chapterTitle} settings={readerSettings} setSettings={setReaderSettings} nav={n} />;
    if (top.screen === 'tagresults') return <TagResultsScreen tag={p.tag} onLeave={p.onLeave} nav={n} />;
    if (top.screen === 'later') return <LaterScreen onLeave={p.onLeave} nav={n} />;
    if (top.screen === 'connect') return <ConnectScreen nav={n} />;
    return null;
  };

  return (
    <div className="app-root" data-mode={resolvedMode}>
      <div className="viewport">
        {renderTab()}
        {top && <div className="screen" style={{ zIndex: 30 }}>{renderTop()}</div>}
      </div>
      {showNav && <BottomNav active={tab} onTab={switchTab} />}
    </div>
  );
}
