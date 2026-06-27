// AO3 tag autocomplete proxy.
//
// The phone app only talks to Supabase, never to AO3 directly. This Edge
// Function lets the in-app "add a tag" field show live AO3 suggestions: it
// forwards the typed term to AO3's own tag autocomplete and returns canonical
// tag names, so a tracked group uses the exact tags AO3 recognises (and its
// synonym wrangling applies when the worker later searches).
//
// Auth: callers must present the project's anon key (default JWT verification),
// so this isn't an open proxy.

const AO3_AUTOCOMPLETE = "https://archiveofourown.org/autocomplete/tag";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const url = new URL(req.url);
  let term = (url.searchParams.get("term") || "").trim();
  if (!term && req.method === "POST") {
    try {
      const body = await req.json();
      term = (body?.term || "").toString().trim();
    } catch (_e) { /* ignore bad bodies */ }
  }
  if (term.length < 2) return json({ tags: [] });

  const target = `${AO3_AUTOCOMPLETE}?term=${encodeURIComponent(term)}`;
  // AO3's autocomplete origin is flaky: it returns Cloudflare 525s on MOST
  // requests and a good 200 only intermittently (verified — ~1 in 6). A browser
  // works because it effectively retries; a single proxy request usually catches
  // the 525, which is why suggestions "did nothing". So we RETRY here (fast, since
  // a 525 fails quickly) within a total time budget, with browser-style headers,
  // and take the first good response. On exhausting the budget we return an empty
  // list with HTTP 200 so the app stays responsive (and its "Add what you typed"
  // fallback still works).
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "Accept-Language": "en-US,en;q=0.9",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://archiveofourown.org/works/new",
  };
  const deadline = Date.now() + 8000; // total budget across retries
  let lastStatus = 0;
  for (let attempt = 0; attempt < 25 && Date.now() < deadline; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(target, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.ok) {
        // AO3 returns [{ id, name }, ...]; normalise to a small, stable shape.
        const raw = await res.json();
        const tags = (Array.isArray(raw) ? raw : [])
          .map((t) => ({
            name: (t?.name ?? t?.id ?? "").toString(),
            id: (t?.id ?? "").toString(),
          }))
          .filter((t) => t.name.length > 0)
          .slice(0, 15);
        return new Response(JSON.stringify({ tags }), {
          status: 200,
          headers: { ...CORS, "Content-Type": "application/json", "Cache-Control": "private, max-age=120" },
        });
      }
      lastStatus = res.status; // 525 etc → retry
    } catch (_e) {
      clearTimeout(timer); // abort/network → retry
    }
    await new Promise((r) => setTimeout(r, 120)); // brief pause between tries
  }
  return json({ tags: [], error: `AO3 unreachable (last ${lastStatus || "n/a"})` });
});
