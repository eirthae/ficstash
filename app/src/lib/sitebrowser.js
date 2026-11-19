import { supabase, hasSupabase } from './supabase.js';
import { readPrefs, readDismissedKeys } from './ondevice.js';
import { excludedForShelf } from './shelving.js';
import {
  royalRoadSearchUrl, scribbleHubStart, shGenreId, shTermName,
  parseRoyalRoadList, parseScribbleHubList,
  filterSiteResults, siteMatchRow, siteForHost,
} from './sitesearch-pure.js';

// Royal Road / Scribble Hub discovery in an in-app browser you drive.
// See sitesearch-pure.js for why, and for the line this holds: the app reads
// only the page you have loaded, only when you tap "Add to FicStash". It makes
// no requests of its own — no background fetches, no automatic paging.

const SITE_LABEL = { royalroad: 'Royal Road', scribblehub: 'Scribble Hub' };

// The script dropped into each page you load on the site: a button pinned to
// the bottom that shows how many results this page holds, and — only when you
// tap it — reads them and hands them to the app. The parsers are the same
// functions the tests run, injected from their own source text.
function overlayScript() {
  return `(function () {
  if (window.__ficstash) { window.__ficstash.refresh(); return; }
  var host = location.hostname || '';
  var parse = /(^|\\.)royalroad\\.com$/.test(host) ? (${parseRoyalRoadList.toString()})
    : /(^|\\.)scribblehub\\.com$/.test(host) ? (${parseScribbleHubList.toString()}) : null;
  if (!parse || !document.body) return;
  function send(o) {
    var s = JSON.stringify(o);
    if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.cordova_iab) {
      window.webkit.messageHandlers.cordova_iab.postMessage(s);
    } else if (window.cordova_iab) { window.cordova_iab.postMessage(s); }
  }
  function count() { try { return parse(document).length; } catch (e) { return 0; } }
  var btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText = 'position:fixed;left:16px;right:16px;bottom:16px;z-index:2147483647;'
    + 'padding:14px 16px;border:0;border-radius:14px;background:#7c5cff;color:#fff;'
    + 'font:600 16px system-ui,-apple-system,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35)';
  function refresh() {
    var n = count();
    btn.disabled = !n;
    btn.style.opacity = n ? '1' : '.55';
    btn.textContent = n ? ('Add ' + n + ' to FicStash') : 'No results on this page';
  }
  btn.onclick = function () {
    var items;
    try { items = parse(document); } catch (e) { send({ type: 'ficstash-error', message: String(e) }); return; }
    btn.disabled = true;
    btn.textContent = 'Adding\\u2026';
    send({ type: 'ficstash-results', url: location.href, items: items });
  };
  window.__ficstash = { refresh: refresh };
  window.__ficstashDone = function (msg) {
    btn.textContent = msg;
    btn.disabled = true;
    setTimeout(refresh, 2500);
  };
  document.body.appendChild(btn);
  refresh();
})();`;
}

// Where to start, plus what to check on each result that the start page itself
// can't filter by. Excludes are the group's own plus this shelf's global ones.
async function planFor(group) {
  const prefs = await readPrefs();
  const siteExcl = excludedForShelf(prefs, 'sites');
  const include = Array.isArray(group.tags) ? group.tags : [];
  const exclude = [...(group.excludedTags || group.excluded_tags || []), ...siteExcl];
  const excludeNames = exclude.map((t) => (t && typeof t === 'object' ? t.name : t)).filter(Boolean);
  if (group.source === 'royalroad') {
    return { url: royalRoadSearchUrl(include, exclude), excludeNames, requireGenres: [] };
  }
  const start = scribbleHubStart(include, exclude);
  // A tag listing can't filter by genre, so the group's genres are checked on
  // each result instead (every Scribble Hub card lists its genres).
  const requireGenres = start.exact ? [] : include.filter((t) => shGenreId(t)).map(shTermName);
  return { url: start.url, excludeNames, requireGenres };
}

// Open the group's site search in the in-app browser. Resolves when it opens;
// `onAdded(n)` fires after each tap that wrote rows, `onClose()` when you close it.
export async function openSiteSearch(group, { onAdded, onClose } = {}) {
  const IAB = typeof window !== 'undefined' && window.cordova && window.cordova.InAppBrowser;
  if (!IAB) throw new Error('the in-app browser only works in the installed app');
  if (!hasSupabase) throw new Error('not connected');
  const source = group.source;
  const label = SITE_LABEL[source] || source;
  const plan = await planFor(group);
  const dismissed = await readDismissedKeys();

  const ref = IAB.open(plan.url, '_blank', [
    'location=yes', 'hidenavigationbuttons=no', 'toolbarcolor=#0c0c0e', 'closebuttoncaption=Done',
    'closebuttoncolor=#ffffff', 'navigationbuttoncolor=#ffffff', 'zoom=no', 'footer=no',
  ].join(','));

  const say = (msg) => {
    try { ref.executeScript({ code: `window.__ficstashDone && window.__ficstashDone(${JSON.stringify(msg)})` }); } catch (e) { /* closed */ }
  };

  ref.addEventListener('loadstop', (e) => {
    // Only ever on the group's own site — never inject into anything else the
    // person navigates to.
    if (siteForHost(e && e.url) !== source) return;
    try { ref.executeScript({ code: overlayScript() }); } catch (err) { /* page went away */ }
  });

  ref.addEventListener('message', async (e) => {
    const d = (e && e.data) || {};
    if (d.type === 'ficstash-error') { say(`Couldn't read this page (${d.message})`); return; }
    if (d.type !== 'ficstash-results') return;
    if (siteForHost(d.url) !== source) { say(`Open a ${label} page to add to this group`); return; }
    const items = Array.isArray(d.items) ? d.items : [];
    const kept = filterSiteResults(items, {
      source, status: group.status || 'all', excludeNames: plan.excludeNames,
      requireGenres: plan.requireGenres, dismissed,
    });
    if (!kept.length) {
      say(items.length ? `None of these ${items.length} fit this group's filters` : 'No results on this page');
      return;
    }
    const rows = kept.map((it) => siteMatchRow(group.id, source, it));
    const { error } = await supabase
      .from('tag_matches')
      .upsert(rows, { onConflict: 'group_id,source,source_work_id' });
    if (error) { say(`Couldn't save — ${error.message || error}`); return; }
    say(`Added ${rows.length} ✓`);
    if (onAdded) onAdded(rows.length);
  });

  ref.addEventListener('exit', () => { if (onClose) onClose(); });
  return { label };
}
