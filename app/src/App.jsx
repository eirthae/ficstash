import { useState, useEffect, useRef } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Preferences } from '@capacitor/preferences';
import { BottomNav } from './components/chrome.jsx';
import { AddMenu } from './components/AddMenu.jsx';
import { LibraryScreen } from './screens/Library.jsx';
import { WhatsNewScreen } from './screens/WhatsNew.jsx';
import { DiscoverScreen, TagResultsScreen, LaterScreen } from './screens/Discover.jsx';
import { SettingsScreen, ConnectScreen } from './screens/Settings.jsx';
import { StoryDetailScreen } from './screens/Detail.jsx';
import { SeriesScreen } from './screens/Series.jsx';
import { ReaderScreen } from './screens/Reader.jsx';
import { LoginScreen } from './screens/Login.jsx';
import { WORKS, NEW_CHAPTERS, NEW_MATCHES } from './data/sample.js';
import { LocalNotifications } from '@capacitor/local-notifications';
import { fetchWorks } from './lib/library.js';
import { notifySavedAvailable, ensureNotifyPermission } from './lib/notify.js';
import { supabase, hasSupabase } from './lib/supabase.js';

const READER_DEFAULTS = { theme: 'dark', font: 'serif', size: 19, leading: 1.70, margin: 26, brightness: 1 };

export default function App() {
  // ---- app color mode (whole chrome) -------------------------------------
  const [appMode, setAppModeState] = useState(() => localStorage.getItem('fs-mode') || 'system');
  const [systemDark, setSystemDark] = useState(() => window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  // Mark a real user choice so async hydration never clobbers it, and so we only
  // persist deliberate changes (not the transient initial/default state).
  const appModeDirty = useRef(false);
  const setAppMode = (m) => { appModeDirty.current = true; setAppModeState(m); };
  useEffect(() => {
    let alive = true;
    Preferences.get({ key: 'fs-mode' })
      .then(({ value }) => { if (alive && value && !appModeDirty.current) setAppModeState(value); })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!appModeDirty.current) return;
    Preferences.set({ key: 'fs-mode', value: appMode }).catch(() => {});
    try { localStorage.setItem('fs-mode', appMode); } catch (e) {}
  }, [appMode]);
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
  // `readerDirty` flips the first time the user actually changes a reader setting.
  // It does two jobs: (1) the save effect only writes once there's a real change,
  // so the transient initial/default state never clobbers stored values; (2) the
  // async hydration below refuses to overwrite a change the user already made.
  // The old code gated saves on "hydration finished" instead — but on Android the
  // native Preferences read is slow on cold start, so a quick change in that window
  // was dropped by the guard and then clobbered by the late hydration. This fixes
  // that race: a user change is always persisted immediately, to BOTH stores.
  const readerDirty = useRef(false);
  const updateReaderSettings = (next) => { readerDirty.current = true; setReaderSettings(next); };
  useEffect(() => {
    let alive = true;
    Preferences.get({ key: 'fs-reader' })
      .then(({ value }) => {
        if (alive && value && !readerDirty.current) {
          try { setReaderSettings({ ...READER_DEFAULTS, ...JSON.parse(value) }); } catch (e) {}
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    if (!readerDirty.current) return;
    const json = JSON.stringify(readerSettings);
    Preferences.set({ key: 'fs-reader', value: json }).catch(() => {});
    try { localStorage.setItem('fs-reader', json); } catch (e) {}
    try { localStorage.setItem('fs-reader-theme', readerSettings.theme); } catch (e) {}
  }, [readerSettings]);

  // ---- auth session (private archive: login required to read anything) ----
  // After migration 0015 the anon key reads nothing; every table needs a
  // logged-in owner session. session === undefined → still checking; null →
  // logged out (show LoginScreen); object → signed in. When Supabase isn't
  // configured at all we treat it as "no auth needed" and run on sample data.
  const [session, setSession] = useState(hasSupabase ? undefined : null);
  useEffect(() => {
    if (!hasSupabase) return;
    let alive = true;
    supabase.auth.getSession().then(({ data }) => { if (alive) setSession(data.session ?? null); });
    const { data: sub } = supabase.auth.onAuthStateChange((_evt, s) => { if (alive) setSession(s ?? null); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);
  const authed = !hasSupabase || !!session;
  const signOut = () => { if (hasSupabase) supabase.auth.signOut().catch(() => {}); };

  // ---- live library from Supabase (null = still loading) -----------------
  // When Supabase isn't configured, fetchWorks() returns null and we fall
  // back to bundled sample data so the app still has something to show.
  const [works, setWorks] = useState(null);
  const worksRef = useRef([]); worksRef.current = works || []; // latest works for the notification-tap reader deep-link
  // Saved-work arrival notifications: remember which saved-from-Discovery works
  // (origin 'tag') we've already seen; when a reload/sync surfaces new ones, fire
  // an OS notification. The first load only SEEDS the set (no notification spam
  // for the existing backlog).
  const knownSaved = useRef(null); // null until seeded
  const noteSavedArrivals = (list) => {
    const saved = (list || []).filter(w => w && w.origin === 'tag');
    const ids = new Set(saved.map(w => w.id));
    if (knownSaved.current === null) { knownSaved.current = ids; return; } // seed only
    const fresh = saved.filter(w => !knownSaved.current.has(w.id));
    knownSaved.current = ids;
    if (fresh.length) notifySavedAvailable(fresh);
  };
  const reloadWorks = () => fetchWorks()
    .then(r => { const list = r ?? WORKS; setWorks(list); noteSavedArrivals(list); })
    .catch(() => setWorks(WORKS));
  useEffect(() => {
    if (!authed) { setWorks(null); return; } // wait until signed in to query
    let alive = true;
    fetchWorks()
      .then(r => { if (alive) { const list = r ?? WORKS; setWorks(list); noteSavedArrivals(list); } })
      .catch(() => { if (alive) setWorks(WORKS); });
    // Ask for notification permission once, up front — otherwise the prompt only
    // appears the first time a saved work happens to arrive, which may be never.
    ensureNotifyPermission().catch(() => {});
    return () => { alive = false; };
  }, [authed]);
  // Drop a removed work from the in-memory list so the library updates at once
  // (the row is already flagged hidden in the DB by the Detail screen).
  const removeFromLibrary = (id) => setWorks(ws => (ws || []).filter(w => w.id !== id));

  // ---- global Add menu (centered + in the bottom nav) --------------------
  // Bumping refreshKey tells the Library to re-pull its works + pending links
  // after a file upload or add-by-link from the FAB on any tab.
  const [addOpen, setAddOpen] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const onLibraryChanged = () => { reloadWorks(); setRefreshKey(k => k + 1); };

  // ---- navigation stack --------------------------------------------------
  const [tab, setTab] = useState('library');
  const [stack, setStack] = useState([]);
  const stackRef = useRef([]); stackRef.current = stack;
  const [navDir, setNavDir] = useState('fwd'); // fwd: new screen slides in from the right
  // The screen being popped stays mounted briefly so it can slide OUT to the right
  // (revealing the screen beneath) instead of vanishing instantly — that instant
  // disappear was the "jump" on swipe-back. `exiting` holds the leaving screen for
  // the length of the animation, then clears.
  const [exiting, setExiting] = useState(null);
  const exitTimer = useRef(null);
  const goBack = () => {
    const s = stackRef.current;
    if (!s.length) return false;
    setNavDir('back');
    setExiting({ item: s[s.length - 1], key: s.length });
    setStack(s.slice(0, -1));
    if (exitTimer.current) clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => setExiting(null), 300);
    return true;
  };
  const nav = useRef();
  nav.current = {
    push: (screen, props = {}) => { setNavDir('fwd'); setStack(s => [...s, { screen, props }]); try { history.pushState({ fs: 1 }, ''); } catch (e) {} },
    pop: () => { goBack(); },
    reset: (tabId) => { setStack([]); setTab(tabId); },
  };
  useEffect(() => {
    const onPop = () => { goBack(); };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const switchTab = (id) => { setStack([]); setTab(id); if (id === 'library') reloadWorks(); }; // refresh so saved works show in the library at once (not just What's New)

  // Android hardware back / swipe-back gesture. Capacitor routes both through
  // the backButton event; once we register a listener it stops auto-closing the
  // app, so we drive the in-app stack and only exit from the Library root.
  const navState = useRef({ stack, tab });
  navState.current = { stack, tab };
  useEffect(() => {
    const handle = CapApp.addListener('backButton', () => {
      const { tab } = navState.current;
      if (goBack()) return;
      if (tab !== 'library') switchTab('library');
      else CapApp.exitApp();
    });
    return () => { handle.then(h => h.remove()).catch(() => {}); };
  }, []);

  // Tapping a "saved work ready to read" notification deep-links into its reader.
  useEffect(() => {
    const handle = LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
      const wid = action && action.notification && action.notification.extra && action.notification.extra.workId;
      if (!wid) return;
      const w = (worksRef.current || []).find(x => x.id === wid);
      if (w) { setNavDir('fwd'); setStack(s => [...s, { screen: 'reader', props: { work: w } }]); }
    });
    return () => { handle.then(h => h.remove()).catch(() => {}); };
  }, []);

  // Auth gates (all hooks above; safe to early-return here).
  if (hasSupabase && session === undefined) {
    return (
      <div className="app-root" data-mode={resolvedMode}>
        <div className="viewport" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Loading…</div>
        </div>
      </div>
    );
  }
  if (!authed) {
    return (
      <div className="app-root" data-mode="dark">
        <div className="viewport"><LoginScreen /></div>
      </div>
    );
  }

  const top = stack[stack.length - 1];
  const showNav = !top;

  const renderTab = () => {
    const n = nav.current;
    if (tab === 'library') return <LibraryScreen works={works} layout="fandom" onRemove={removeFromLibrary} onReload={reloadWorks} refreshKey={refreshKey} nav={n} />;
    if (tab === 'whatsnew') return <WhatsNewScreen chapters={NEW_CHAPTERS} matches={NEW_MATCHES} nav={n} />;
    if (tab === 'discover') return <DiscoverScreen nav={n} />;
    if (tab === 'settings') return <SettingsScreen appMode={appMode} setAppMode={setAppMode} onSignOut={signOut} canSignOut={hasSupabase && !!session} nav={n} />;
  };
  const renderScreen = (item) => {
    const n = nav.current, p = item.props || {};
    if (item.screen === 'detail') return <StoryDetailScreen work={p.work} suggestion={p.suggestion} onSaved={p.onSaved} onRemoved={p.onRemoved} onReload={p.onReload} nav={n} />;
    if (item.screen === 'series') return <SeriesScreen seriesId={p.seriesId} seriesName={p.seriesName} onReload={p.onReload} nav={n} />;
    if (item.screen === 'reader') return <ReaderScreen work={p.work} workId={p.workId} chapterN={p.chapterN} chapterTitle={p.chapterTitle} settings={readerSettings} setSettings={updateReaderSettings} nav={n} />;
    if (item.screen === 'tagresults') return <TagResultsScreen tag={p.tag} onLeave={p.onLeave} nav={n} />;
    if (item.screen === 'later') return <LaterScreen onLeave={p.onLeave} nav={n} />;
    if (item.screen === 'connect') return <ConnectScreen nav={n} />;
    return null;
  };

  return (
    <div className="app-root" data-mode={resolvedMode}>
      <div className="viewport">
        {renderTab()}
        {/* Every stack screen stays mounted (lower ones sit behind the opaque top
            one), so going back reveals the previous screen with its scroll + state
            intact instead of remounting and jumping to the top. Only the topmost
            animates in; the just-popped screen slides out via the `exiting` layer. */}
        {stack.map((item, i) => {
          const isTop = i === stack.length - 1;
          return (
            <div key={i} className={`screen ${isTop ? (navDir === 'back' ? 'view-reveal' : 'view-enter') : ''}`} style={{ zIndex: 30 + i }}>
              {renderScreen(item)}
            </div>
          );
        })}
        {exiting && <div className="screen view-pop" key={`exit-${exiting.key}`} style={{ zIndex: 30 + stack.length + 1 }}>{renderScreen(exiting.item)}</div>}
      </div>
      {showNav && <BottomNav active={tab} onTab={(id) => { setAddOpen(false); switchTab(id); }} onAdd={() => setAddOpen(o => !o)} addActive={addOpen} />}
      {showNav && <AddMenu open={addOpen} onClose={() => setAddOpen(false)} onChanged={onLibraryChanged} />}
    </div>
  );
}
