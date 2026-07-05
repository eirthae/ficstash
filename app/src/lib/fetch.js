import { CapacitorHttp } from '@capacitor/core';

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
function splitQuery(url) {
  const s = String(url);
  const qi = s.indexOf('?');
  if (qi < 0) return { base: s, params: null };
  const params = {};
  for (const [k, v] of new URLSearchParams(s.slice(qi + 1))) params[k] = v;
  return { base: s.slice(0, qi), params };
}

async function getOnce(url) {
  const { base, params } = splitQuery(url);
  const res = await CapacitorHttp.get({
    url: base,
    ...(params ? { params } : {}),
    headers: { 'User-Agent': API_UA, Accept: '*/*' },
    responseType: 'text',
  });
  let data = res && res.data;
  const raw = typeof data === 'string' ? data : '';
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch (e) { data = null; } }
  return { status: res ? res.status : 0, data, url: (res && res.url) || url, raw };
}

// Fetch + parse a JSON endpoint, retrying past AO3's intermittent 525s.
export async function fetchJson(url, { attempts = 4 } = {}) {
  let last = { status: 0, data: null, url, raw: '' };
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await getOnce(url);
      if (r.status >= 200 && r.status < 300 && Array.isArray(r.data)) return r;
      last = r;
    } catch (e) {
      last = { status: 0, data: null, url, raw: String(e && e.message || e) };
    }
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 150));
  }
  return last;
}

async function getHtmlOnce(url, accept) {
  const { base, params } = splitQuery(url);
  const res = await CapacitorHttp.get({
    url: base,
    ...(params ? { params } : {}),
    headers: { 'User-Agent': HTML_UA, Accept: accept },
    responseType: 'text',
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

// Fetch a remote image over native HTTP and return it as a `data:` URI (so the
// reader can show it OFFLINE — the reader neutralizes any remaining remote <img>
// to a placeholder). Native CapacitorHttp returns binary as a base64 string for
// responseType 'blob'. Best-effort: any failure returns '' and the caller leaves
// the image remote (→ placeholder), i.e. no worse than before.
export async function fetchImageDataUri(url) {
  try {
    const { base, params } = splitQuery(url);
    const res = await CapacitorHttp.get({
      url: base,
      ...(params ? { params } : {}),
      headers: { 'User-Agent': HTML_UA, Accept: 'image/*,*/*' },
      responseType: 'blob',
    });
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
export async function fetchHtml(url, { attempts = 4, accept = 'text/html,application/xhtml+xml' } = {}) {
  let last = { status: 0, url, html: '' };
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await getHtmlOnce(url, accept);
      if (r.status >= 200 && r.status < 300 && r.html) return r;
      last = r;
    } catch (e) {
      last = { status: 0, url, html: '' };
    }
    if (i < attempts - 1) await new Promise((res) => setTimeout(res, 150));
  }
  return last;
}
