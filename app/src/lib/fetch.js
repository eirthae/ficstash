import { CapacitorHttp } from '@capacitor/core';

// Native HTTP for AO3's JSON endpoints (tag autocomplete), called DIRECTLY from
// the device — no Supabase proxy. On Android CapacitorHttp makes the request from
// native code, which bypasses the WebView CORS wall and uses the phone's own IP.
// AO3 returns Cloudflare 525 to our server proxy's datacenter IP ~100% of the
// time, but answers the device.
const API_UA = 'FicStash/1.0 (+https://github.com/eirthae/ficstash; personal reading app)';

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
