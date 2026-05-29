import { useState, useEffect, useRef } from 'react';
import { BottomNav } from './components/chrome.jsx';
import { LibraryScreen } from './screens/Library.jsx';
import { WhatsNewScreen } from './screens/WhatsNew.jsx';
import { DiscoverScreen, TagResultsScreen } from './screens/Discover.jsx';
import { SettingsScreen, ConnectScreen } from './screens/Settings.jsx';
import { StoryDetailScreen } from './screens/Detail.jsx';
import { ReaderScreen } from './screens/Reader.jsx';
import { WORKS, NEW_CHAPTERS, NEW_MATCHES, TRACKED_TAGS, SUGGESTIONS } from './data/sample.js';
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
  const [readerSettings, setReaderSettings] = useState(() => {
    let saved = {}; try { saved = JSON.parse(localStorage.getItem('fs-reader') || '{}'); } catch (e) {}
    return { ...READER_DEFAULTS, ...saved };
  });
  useEffect(() => { try { localStorage.setItem('fs-reader', JSON.stringify(readerSettings)); } catch (e) {} }, [readerSettings]);
  useEffect(() => { try { localStorage.setItem('fs-reader-theme', readerSettings.theme); } catch (e) {} }, [readerSettings.theme]);

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

  const top = stack[stack.length - 1];
  const showNav = !top;

  const renderTab = () => {
    const n = nav.current;
    if (tab === 'library') return <LibraryScreen works={works} layout="grid" nav={n} />;
    if (tab === 'whatsnew') return <WhatsNewScreen chapters={NEW_CHAPTERS} matches={NEW_MATCHES} nav={n} />;
    if (tab === 'discover') return <DiscoverScreen tags={TRACKED_TAGS} nav={n} />;
    if (tab === 'settings') return <SettingsScreen appMode={appMode} setAppMode={setAppMode} nav={n} />;
  };
  const renderTop = () => {
    const n = nav.current, p = top.props || {};
    if (top.screen === 'detail') return <StoryDetailScreen work={p.work} suggestion={p.suggestion} nav={n} />;
    if (top.screen === 'reader') return <ReaderScreen workId={p.workId} chapterN={p.chapterN} chapterTitle={p.chapterTitle} settings={readerSettings} setSettings={setReaderSettings} nav={n} />;
    if (top.screen === 'tagresults') return <TagResultsScreen tag={p.tag} suggestions={SUGGESTIONS} nav={n} />;
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
