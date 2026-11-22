import { CapacitorHttp } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  isAo3Url, AO3_PAGE_GAP_MS, AO3_LOOKUP_GAP_MS, AO3_COOLDOWN_MS, ao3GateDelay, ao3CooldownLeft,
} from './sources/ao3-util.js';

// Native HTTP for AO3's JSON endpoints (tag autocomplete), called DIRECTLY from
// the device — no Supabase proxy. On Android CapacitorHttp makes the request from
// native code, which bypasses the WebView CORS wall and uses the phone's own IP.
// AO3 returns Cloudflare 525 to our server proxy's datacenter IP ~100% of the
// time, but answers the device.
const API_UA = 'FicStash/1.0 (+https://github.com/eirthae/ficstash; personal reading app)';
// A normal desktop UA for AO3's full HTML pages (work / search / series). The
// JSON autocomplete endpoint wants API_UA + Accept:*/* (above); HTML pages are
// happy with a browser-ish UA and an HTML Accept.
const HTML_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

// Move an inline ?query off the URL into CapacitorHttp's native `params` — the
// Android layer percent-encodes a literal "?" and AO3 then 302s to /404.
//
// We keep every key AND value PERCENT-ENCODED exactly as built, and the callers
// pass shouldEncodeUrlParams:false so the native layer sends them verbatim. If we
// instead decode here (URLSearchParams) and let CapacitorHttp re-encode, native
// Android drops a literal "&" in a value — so an AO3 relationship tag like
// "Shane Hollander & Carter Vaughn" collapsed to "Shane Hollander" and the search
// returned unrelated works. Our URL builders already encodeURIComponent the values,
// so verbatim pass-through is correct.
function splitQuery(url) {
  const s = String(url);
  const qi = s.indexOf('?');
  if (qi < 0) return { base: s, params: null };
  const params = {};
  for (const pair of s.slice(qi + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    params[eq < 0 ? pair : pair.slice(0, eq)] = eq < 0 ? '' : pair.slice(eq + 1);
  }
  return { base: s.slice(0, qi), params };
}

// How long a single request may take before we give up on it.
//
// This existed only as a default before, and the default was the problem.
// CapacitorHttp on Android is OkHttp, whose connect/read timeouts are 10
// SECONDS. AO3 under load answers in 15-36s — measured 2026-10-22 from a
// residential connection: a login page at 15.4s, a tag search at 36.3s, both
// HTTP 200. Every one of those would have been killed at 10s and reported as
// "AO3 didn't answer". A browser has no such limit, which is exactly why AO3
// works in a browser and not in the app, on the same phone, on the same wifi,
// at the same moment. Retrying harder could never have fixed it: the request
// was being cut off before AO3 had finished answering.
//
// 20s is the floor for everything (double OkHttp's default, so slow work pages
// land too); a patient caller asks for much more.
const DEFAULT_TIMEOUT_MS = 20000;

// A site telling us "no" on purpose, as opposed to failing to answer.
//
// AO3 came back from its 2026 outage behind a robot check: a browser passes it,
// anything automated gets HTTP 418 ("Request temporarily denied") or a 403
// challenge. Scribble Hub does the same to addresses it doesn't like. Retrying
// that is pointless — the answer is a decision, not a hiccup — and repeated
// refused requests are precisely what such a check is watching for. So these
// are never retried: one request, one answer, stop. We don't try to get past
// the check; we wait for it to be lifted.
export const isDenied = (status) => status === 418 || status === 403;
// ---- the AO3 gate -----------------------------------------------------------
// Every AO3 request the phone makes — search, work pages, series, chapter
// checks, the tag picker — takes its turn here. Two rules (ao3-util.js has the
// numbers and the reasons): requests START at least a gap apart, and after AO3
// says "429 / Retry later" nothing goes to AO3 at all until a cooldown ends.
// The cooldown is remembered across app restarts, so closing and reopening the
// app doesn't send the next request straight back into a rate limit.
const COOLDOWN_KEY = 'fs-ao3-cooldown-until';
let lastAo3Start = 0;
let cooldownUntil = 0;
const cooldownLoaded = Preferences.get({ key: COOLDOWN_KEY })
  .then(({ value }) => { cooldownUntil = Number(value) || 0; })
  .catch(() => {});
let turnChain = Promise.resolve();

// Milliseconds left on the 429 cooldown (0 when there is none).
export async function ao3CooldownLeftMs() {
  await cooldownLoaded;
  return ao3CooldownLeft(cooldownUntil, Date.now());
}

// Wait for this request's turn. Turns are handed out one at a time, so two
// features asking at once still start their requests a gap apart; a slow
// response doesn't hold up the next turn, only the start times are spaced.
function ao3Turn(gapMs) {
  const turn = turnChain.then(async () => {
    const wait = ao3GateDelay(lastAo3Start, gapMs, Date.now());
    if (wait > 0) await new Promise((res) => setTimeout(res, wait));
    lastAo3Start = Date.now();
  });
  turnChain = turn.catch(() => {});
  return turn;
}

// What AO3 answered. A 429 starts the cooldown.
function noteAo3(status) {
  if (status !== 429) return;
  cooldownUntil = Date.now() + AO3_COOLDOWN_MS;
  Preferences.set({ key: COOLDOWN_KEY, value: String(cooldownUntil) }).catch(() => {});
}

// Run one AO3 request through the gate. During a cooldown nothing is sent: the
// caller gets a 429 back exactly as if AO3 had said it, marked `cooldown`.
async function viaAo3Gate(url, gapMs, send, coolResult) {
  if (!isAo3Url(url)) return send();
  await cooldownLoaded;
  if (ao3CooldownLeft(cooldownUntil, Date.now()) > 0) return coolResult;
  await ao3Turn(gapMs);
  // A turn can wait several seconds; a 429 elsewhere in that time still counts.
  if (ao3CooldownLeft(cooldownUntil, Date.now()) > 0) return coolResult;
  const r = await send();
  noteAo3(r && r.status);
  return r;
}

const timeouts = (ms) => {
  const t = ms || DEFAULT_TIMEOUT_MS;
  return { connectTimeout: t, readTimeout: t };
};

async function getOnce(url, timeoutMs) {
  return viaAo3Gate(url, AO3_LOOKUP_GAP_MS, () => getOnceRaw(url, timeoutMs),
    { status: 429, data: null, url, raw: '', cooldown: true });
}

async function getOnceRaw(url, timeoutMs) {
  const { base, params } = splitQuery(url);
  const res = await CapacitorHttp.get({
    url: base,
    ...(params ? { params, shouldEncodeUrlParams: false } : {}),
    headers: { 'User-Agent': API_UA, Accept: '*/*' },
    responseType: 'text',
    ...timeouts(timeoutMs),
  });
  let data = res && res.data;
  const raw = typeof data === 'string' ? data : '';
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
  return { status: res ? res.status : 0, data, url: (res && res.url) || url, raw };
}

// Fetch + parse a JSON endpoint, retrying past AO3's intermittent 525s.
export async function fetchJson(url, { attempts = 4, timeoutMs = 0 } = {}) {
  let last = { status: 0, data: null, url, raw: '' };
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await getOnce(url, timeoutMs);
      // Success = 2xx AND the body parsed to non-null JSON. AO3 autocomplete
      // returns a top-level array; romance.io returns an object ({success,books}).
      // Both are non-null; an error page (HTML) fails JSON.parse → null → retry.
      if (r.status >= 200 && r.status < 300 && r.data != null) return r;
      last = r;
      // Refused on purpose (418/403), or told to slow down (429): asking again
      // straight away is exactly what we were just asked not to do.
      if (isDenied(r.status) || r.status === 429) break;
    } catch (e) {
      last = { status: 0, data: null, url, raw: String(e && e.message || e) };
    }
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 150));
  }
  return last;
}

async function getHtmlOnce(url, accept, timeoutMs) {
  return viaAo3Gate(url, AO3_PAGE_GAP_MS, () => getHtmlOnceRaw(url, accept, timeoutMs),
    { status: 429, url, html: '', cooldown: true });
}

async function getHtmlOnceRaw(url, accept, timeoutMs) {
  const { base, params } = splitQuery(url);
  const res = await CapacitorHttp.get({
    url: base,
    ...(params ? { params, shouldEncodeUrlParams: false } : {}),
    headers: { 'User-Agent': HTML_UA, Accept: accept },
    responseType: 'text',
    ...timeouts(timeoutMs),
    // follow redirects (default) so a restricted work lands on its /users/login
    // page — the caller reads res.url to detect that.
  });
  const data = res && res.data;
  return {
    status: res ? res.status : 0,
    url: (res && res.url) || url, // final URL after redirects (restricted detection)
    html: typeof data === 'string' ? data : (data == null ? '' : String(data)),
  };
}

// POST a form-encoded body over native HTTP and return the response text/HTML.
// Scribble Hub's chapter list comes from an admin-ajax POST (not in the page), so
// the on-device SH downloader needs this. Residential IP like the GET helpers —
// Scribble Hub Cloudflare-403s datacenter IPs (the worker), but answers the phone.
export async function fetchHtmlPost(url, form = {}, { headers = {}, attempts = 3, timeoutMs = 0 } = {}) {
  const body = Object.entries(form)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  let last = { status: 0, url, html: '' };
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await CapacitorHttp.post({
        url,
        headers: {
          'User-Agent': HTML_UA,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html,*/*',
          ...headers,
        },
        data: body,
        responseType: 'text',
        ...timeouts(timeoutMs),
      });
      const data = res && res.data;
      const html = typeof data === 'string' ? data : (data == null ? '' : String(data));
      if (res && res.status >= 200 && res.status < 300 && html) {
        return { status: res.status, url: (res && res.url) || url, html };
      }
      last = { status: res ? res.status : 0, url, html };
    } catch (e) {
      last = { status: 0, url, html: '' };
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 200));
  }
  return last;
}

// Fetch a remote image over native HTTP and return it as a `data:` URI (so the
// reader can show it OFFLINE — the reader neutralizes any remaining remote <img>
// to a placeholder). Native CapacitorHttp returns binary as a base64 string for
// responseType 'blob'. Best-effort: any failure returns '' and the caller leaves
// the image remote (→ placeholder), i.e. no worse than before.
export async function fetchImageDataUri(url) {
  try {
    const { base, params } = splitQuery(url);
    const res = await viaAo3Gate(url, AO3_PAGE_GAP_MS, () => CapacitorHttp.get({
      url: base,
      ...(params ? { params, shouldEncodeUrlParams: false } : {}),
      headers: { 'User-Agent': HTML_UA, Accept: 'image/*,*/*' },
      responseType: 'blob',
      ...timeouts(),
    }), { status: 429, data: '' });
    const b64 = typeof res.data === 'string' ? res.data : '';
    if (!b64) return '';
    const h = res.headers || {};
    let ctype = (h['Content-Type'] || h['content-type'] || '').split(';')[0].trim();
    if (!/^image\//i.test(ctype)) {
      // Infer from a data-ish extension if the header was unhelpful.
      if (/\.png(\?|$)/i.test(base)) ctype = 'image/png';
      else if (/\.gif(\?|$)/i.test(base)) ctype = 'image/gif';
      else if (/\.webp(\?|$)/i.test(base)) ctype = 'image/webp';
      else ctype = 'image/jpeg';
    }
    return `data:${ctype};base64,${b64}`;
  } catch (e) {
    return '';
  }
}

// Fetch an HTML page over native HTTP, retrying past AO3's intermittent 525s —
// the on-device counterpart to fetchJson. Used for AO3 work pages, tag search and
// series paging (the port of the worker's AO3 scraping). Returns {status,url,html}
// — a non-2xx or empty body after all attempts comes back so the caller decides.
// `waits` replaces the default 150ms gap with a real ladder, for callers that can
// afford to wait out a struggling AO3 (a tap the user is watching) rather than
// report failure in half a second. `budgetMs` caps the whole attempt so a patient
// caller still can't hang forever on requests that never answer.
export async function fetchHtml(url, {
  attempts = 4, accept = 'text/html,application/xhtml+xml', waits = null, budgetMs = 0, timeoutMs = 0,
} = {}) {
  const started = Date.now();
  let last = { status: 0, url, html: '' };
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await getHtmlOnce(url, accept, timeoutMs);
      if (r.status >= 200 && r.status < 300 && r.html) return r;
      last = r;
      // Refused on purpose (418/403), or told to slow down (429): asking again
      // straight away is exactly what we were just asked not to do.
      if (isDenied(r.status) || r.status === 429) break;
    } catch (e) {
      last = { status: 0, url, html: '' };
    }
    if (i >= attempts - 1) break;
    const wait = waits ? waits[Math.min(i, waits.length - 1)] : 150;
    if (budgetMs && Date.now() - started + wait >= budgetMs) break;
    await new Promise((res) => setTimeout(res, wait));
  }
  return last;
}
